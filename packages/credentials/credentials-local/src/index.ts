/**
 * File-backed credentials provider over project and optional global documents, layered
 * against the environment by how much each layer is trusted:
 *
 * ```text
 * inherited process environment      (read-only, wins)
 * > project .credentials.yaml        (provider-managed override, writable)
 * > optional global document         (provider-managed default, writable)
 * > <invocation cwd>/.env            (read-only fallback)
 * > $DSH_HOME/.env                   (read-only fallback)
 * ```
 *
 * The inherited environment wins because `DEEPSEEK_API_KEY=… dsh`, a CI
 * secret, or a container `-e` is this run's explicit intent; it cannot be
 * edited from inside, so it must be *visibly* read-only rather than silently
 * shadow writes. Everything below it loses to the managed documents, so a key the
 * Models page writes takes effect immediately even when an older key sits in
 * the user's `.env`.
 *
 * The invoking project may supply a key, because the product trusts the
 * project it is launched in. It ranks below the managed documents, so a key stored
 * through the Models page is never displaced by one a checkout happens to carry.
 *
 * Each file is a provider-managed writable source: every write re-reads the
 * selected document under a cross-process writer lock before patching only its own key
 * — comments and the formatting of every untouched entry survive — external
 * edits hot-publish through the seam, and each reload replaces the snapshot
 * wholesale so a deleted entry never lingers in memory.
 *
 * Each document holds nothing but credentials, which is why it is a strict
 * `CredentialRef`-to-string mapping rather than a dotenv file: a store the
 * Harness owns and never materializes into the environment cannot also serve
 * as the user's environment layer; a store that doubled as the environment
 * layer would shadow non-secret entries behind its precedence, making them
 * silently unreachable.
 * @module @deepseek-ai/dsh-credentials-local
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { watch as chokidarWatch } from 'chokidar'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Document, parseDocument, type YAMLError } from 'yaml'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { canonicalizeWatchPath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialRef, CredentialScope, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type { LaunchEnvironmentEntry } from '@deepseek-ai/dsh-launch-environment'

/** Basename of the credentials document inside the harness home. */
export const CREDENTIALS_FILENAME = '.credentials.yaml'

/** Plugin config: file location and hot-reload behavior. */
export interface Config {
  /** Project credentials document path; defaults to `.credentials.yaml` under the harness home. */
  path?: string
  /** Harness home used when `path` is omitted; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Optional user-global credentials document below the project override. */
  globalPath?: string
  /** Scope used by writes that omit a target; `global` requires `globalPath`. */
  defaultScope?: CredentialScope
  /** Watch the document and hot-publish external edits; defaults to true. */
  watch?: boolean
  /** Watcher write-settle window in milliseconds; defaults to 100. */
  debounceMs?: number
}

/** Fully resolved provider parameters; defaulting happens here, never inline. */
interface ResolvedSpec {
  filename: string
  globalFilename?: string
  defaultScope?: CredentialScope
  watch: boolean
  debounceMs: number
}

/**
 * Resolve the runtime spec from plugin config: an explicit `path` wins,
 * otherwise the document lives at `<harness home>/.credentials.yaml`.
 * @param config - raw plugin config.
 * @returns the resolved file location and watch behavior.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  const filename = resolve(config.path ?? join(resolveDshHome(config.dshHome), CREDENTIALS_FILENAME))
  const globalFilename = config.globalPath === undefined ? undefined : resolve(config.globalPath)
  const defaultScope = config.defaultScope ?? 'project'
  if (defaultScope === 'global' && globalFilename === undefined) {
    throw new Error('credentials-local: defaultScope "global" requires globalPath')
  }
  if (globalFilename === filename) {
    throw new Error('credentials-local: globalPath must differ from the project credentials path')
  }
  return {
    filename,
    ...globalFilename === undefined ? {} : { globalFilename },
    ...globalFilename === undefined ? {} : { defaultScope },
    watch: config.watch ?? true,
    debounceMs: config.debounceMs ?? 100,
  }
}

/** Permission bits outside the owner; a credentials document must have none of them. */
const GROUP_OTHER_BITS = 0o077

/**
 * Reject a credentials document other OS users can read, before its contents
 * are read at all. The provider creates and replaces the file at `0600`, but a
 * hand-written or externally generated one carries whatever umask produced it,
 * and silently serving secrets out of a world-readable file would make the
 * mode the provider promises meaningless.
 *
 * POSIX only: Windows has no mode to inspect — its ACLs are not expressible
 * here — so the check is skipped rather than faked, and the file's protection
 * there is whatever the create and replace APIs express.
 * @param filename - absolute path of the document.
 * @throws when the path hierarchy is invalid or the file exists with group or other permission bits set.
 */
async function assertOwnerOnly(filename: string): Promise<void> {
  let mode: number
  try {
    mode = (await stat(filename)).mode
  } catch (error) {
    if (!isENOENT(error)) throw error
    await canonicalizeWatchPath(filename)
    return
  }
  /* v8 ignore next -- POSIX coverage cannot take the Windows peer; native Windows coverage does. */
  if (process.platform === 'win32') return
  /* v8 ignore start -- Windows has no POSIX mode enforcement; POSIX behavior tests enforce this peer. */
  const offending = mode & GROUP_OTHER_BITS
  if (offending === 0) return
  throw new Error(
    `credentials-local: ${filename} is readable beyond its owner (mode ${(mode & 0o777).toString(8)});`
    + ` run "chmod 600 ${filename}" before starting again`,
  )
  /* v8 ignore stop */
}

/** Whether a filesystem error means absence; every non-ENOENT failure must surface. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Describe one YAML parse failure without quoting the source. The parser's own
 * message embeds the offending line, which here holds a secret.
 * @param error - the parser's error.
 * @returns the error code with its line and column.
 */
function describeYamlError(error: YAMLError): string {
  const at = error.linePos?.[0]
  /* v8 ignore next -- `prettyErrors` populates linePos on every error; the guard answers its optional type */
  const where = at === undefined ? '' : ` at line ${String(at.line)}, column ${String(at.col)}`
  return `${error.code}${where}`
}

/**
 * Parse one credentials document into its entries. The document is a strict
 * mapping of {@link CredentialRef} to non-empty string: a non-mapping root, a
 * key that is not a POSIX identifier, a non-string value, and an empty string
 * are all rejected rather than skipped, because this file holds nothing but
 * credentials and a silently ignored entry reads as "the key I stored has no
 * effect". Duplicate keys surface as parser errors. An empty document is an
 * empty store.
 * @param text - the document's text.
 * @param filename - absolute path, quoted in errors.
 * @returns the parsed entries, keyed by reference.
 */
export function parseCredentialsDocument(text: string, filename: string): Map<string, string> {
  // `prettyErrors` is on only for `linePos`; `error.message` is never used,
  // because the parser quotes the offending source line and in this document
  // that line is a secret. Only the code and position leave this function, and
  // the same rule governs every other diagnostic here — a key name is safe to
  // print, a value is not.
  const document = parseDocument(text, { prettyErrors: true, uniqueKeys: true })
  if (document.errors.length > 0) {
    throw new Error(`credentials-local: invalid document at ${filename}: ${
      document.errors.map(describeYamlError).join('; ')}`)
  }
  const root: unknown = document.toJS() ?? {}
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new TypeError(`credentials-local: ${filename} must be a mapping of credential reference to value`)
  }
  const entries = new Map<string, string>()
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    // credentialRef throws on anything that is not a POSIX identifier, which
    // is exactly the constraint a stored reference must satisfy to be
    // addressable through the seam.
    credentialRef(key)
    // The key name is quoted, never the value: a wrong-typed entry is still a
    // secret the user meant to store.
    if (typeof value !== 'string') {
      throw new TypeError(`credentials-local: the value for "${key}" in ${filename} must be a string`)
    }
    if (value.length === 0) {
      throw new Error(`credentials-local: the value for "${key}" in ${filename} is empty; remove the key instead`)
    }
    entries.set(key, value)
  }
  return entries
}

/**
 * Render the next document text with one reference set or deleted. Editing
 * the parsed document rather than rebuilding it keeps comments and the
 * formatting of every untouched entry; an absent document starts a fresh one.
 * @param text - the current document text, `undefined` while the file is absent.
 * @param ref - the reference to write.
 * @param value - the new value, or `undefined` to delete the key.
 * @returns the text to persist.
 */
function renderDocument(text: string | undefined, ref: CredentialRef, value: string | undefined): string {
  // `text` only ever caches content that parsed successfully, so this re-parse
  // for the mutable comment-preserving tree cannot fail.
  const document = text === undefined ? new Document({}) : parseDocument(text)
  if (value === undefined) document.deleteIn([ref])
  else document.setIn([ref], value)
  return document.toString()
}

/** File-backed credentials provider with a project document and optional global default. */
export class LocalCredentialProvider extends CredentialProvider {
  /* jscpd:ignore-start -- deliberate config-surface and lifecycle symmetry with
     settings-file (prefer symmetry for parallel values); extracting the shared
     shape would couple the two providers' teardown semantics across packages. */
  static Config: z<Config> = z.object({
    path: z.string(),
    dshHome: z.string(),
    globalPath: z.string(),
    defaultScope: z.union(['global', 'project'] as const).default('project'),
    watch: z.boolean().default(true),
    debounceMs: z.number().min(0).default(100),
  })

  private readonly spec: ResolvedSpec
  /**
   * Raw text of the last read or persisted document; `undefined` while the
   * file is absent. Watcher events whose content equals this cache are no-ops,
   * which is also the self-write suppression.
   */
  private readonly text: Record<CredentialScope, string | undefined> = {
    global: undefined,
    project: undefined,
  }
  /** Parsed document snapshots; each is replaced wholesale on reload. */
  private readonly values: Record<CredentialScope, Map<string, string>> = {
    global: new Map<string, string>(),
    project: new Map<string, string>(),
  }
  /**
   * Single exclusive operation chain: watcher reloads and line edits run one
   * at a time in queue order (settled tail), so an edit can never render from
   * text a concurrent reload is busy replacing.
   */
  private operations: Promise<void> = Promise.resolve()
  /** Set at dispose: refuse new writes and let in-flight work no-op. */
  private closed = false

  /** Opaque read of {@link closed}: control flow cannot narrow it across awaits. */
  private isClosed(): boolean {
    return this.closed
  }
  /* jscpd:ignore-end */

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    // Programmatic construction may bypass Schemastery normalization; resolve
    // the same defaults in one explicit step either way.
    this.spec = resolveSpec(config)
  }

  /** The inherited-environment value for a reference, or `undefined` when empty or unset. */
  private inherited(ref: CredentialRef): string | undefined {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['process'])
    return entry !== undefined && entry.value.length > 0 ? entry.value : undefined
  }

  /**
   * The `.env` fallback for a reference — below the managed store, never above
   * it. The invoking project ranks over the user's home file, matching the
   * environment layering: the more specific location wins.
   */
  private dotenvFallback(ref: CredentialRef): LaunchEnvironmentEntry | undefined {
    const entry = launchEnvironmentOf(this.ctx).getFrom(ref, ['project-env', 'user-env'])
    return entry !== undefined && entry.value.length > 0 ? entry : undefined
  }

  /** Configured managed-document scopes in resolution order. */
  private scopes(): CredentialScope[] {
    return this.spec.globalFilename === undefined ? ['project'] : ['project', 'global']
  }

  /** Absolute managed-document path for one available scope. */
  private filename(scope: CredentialScope): string {
    if (scope === 'project') return this.spec.filename
    if (this.spec.globalFilename !== undefined) return this.spec.globalFilename
    throw new Error('credentials-local: global credential scope is not configured')
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    yield async () => {
      // Drain: refuse new operations, then settle the queued ones so disposal
      // completes only once storage is quiescent.
      this.closed = true
      await this.operations
    }
    for (const scope of this.scopes()) await this.loadInitial(scope)
    if (!this.spec.watch) return
    /* jscpd:ignore-start -- same watcher discipline as settings-file by design:
       the serialized-refresh and quiesce-on-dispose shape is the reviewed
       lifecycle contract, not accidental repetition. */
    const watchers = await Promise.all(this.scopes().map(async (scope) => {
      const filename = this.filename(scope)
      const watcher = chokidarWatch(await canonicalizeWatchPath(filename), {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: this.spec.debounceMs,
          pollInterval: Math.max(1, Math.min(this.spec.debounceMs, 10)),
        },
      })
      watcher.on('all', () => {
        if (this.closed) return
        this.queueRefresh(scope)
      })
      watcher.on('ready', () => {
        // The initial load raced the watcher's own setup: a change written
        // between that read and the watcher becoming active never fires an
        // event. One reconcile at ready closes the gap.
        if (this.closed) return
        this.queueRefresh(scope)
      })
      watcher.on('error', (error) => {
        this.ctx.logger.warn('credentials-local: watcher error on %s', filename)
        this.ctx.logger.warn(error)
      })
      return watcher
    }))
    yield async () => {
      // Quiesce: stop accepting events, close the watcher, then wait out any
      // queued or in-flight operation so nothing publishes after disposal.
      this.closed = true
      await Promise.all(watchers.map(watcher => watcher.close()))
      await this.operations
    }
    /* jscpd:ignore-end */
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const inherited = this.inherited(ref)
    if (inherited !== undefined) return Promise.resolve({ value: inherited, source: 'env' })
    const project = this.values.project.get(ref)
    if (project !== undefined) {
      return Promise.resolve({ value: project, source: this.spec.globalFilename === undefined ? 'file' : 'project-file' })
    }
    const global = this.values.global.get(ref)
    if (global !== undefined) return Promise.resolve({ value: global, source: 'global-file' })
    const fallback = this.dotenvFallback(ref)
    if (fallback !== undefined) return Promise.resolve({ value: fallback.value, source: fallback.source })
    return Promise.resolve(undefined)
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    // Only the inherited environment is unwritable: it is the one layer this
    // process cannot edit. A user `.env` value is writable in the sense that
    // matters — storing a key replaces it as the effective one.
    if (this.inherited(ref) !== undefined) {
      return Promise.resolve({ configured: true, source: 'env', writable: false })
    }
    if (this.spec.globalFilename === undefined) {
      const stored = this.values.project.get(ref)
      if (stored !== undefined) return Promise.resolve({ configured: true, source: 'file', writable: true })
      const fallback = this.dotenvFallback(ref)
      if (fallback !== undefined) return Promise.resolve({ configured: true, source: fallback.source, writable: true })
      return Promise.resolve({ configured: false, writable: true })
    }
    const writableScopes: CredentialScope[] = ['global', 'project']
    const scoped = {
      writable: true,
      writableScopes,
      defaultScope: this.spec.defaultScope ?? 'project',
    } as const
    const project = this.values.project.get(ref)
    if (project !== undefined) {
      return Promise.resolve({
        configured: true,
        source: 'project-file',
        scope: 'project',
        ...scoped,
      })
    }
    const global = this.values.global.get(ref)
    if (global !== undefined) {
      return Promise.resolve({ configured: true, source: 'global-file', scope: 'global', ...scoped })
    }
    const fallback = this.dotenvFallback(ref)
    if (fallback !== undefined) return Promise.resolve({ configured: true, source: fallback.source, ...scoped })
    return Promise.resolve({ configured: false, ...scoped })
  }

  override async set(ref: CredentialRef, value: string, scope?: CredentialScope): Promise<void> {
    if (value.length === 0) {
      throw new Error(`credentials-local: an empty value cannot be stored for "${ref}"; use unset`)
    }
    await this.write(ref, value, this.writeScope(scope))
  }

  override async unset(ref: CredentialRef, scope?: CredentialScope): Promise<void> {
    await this.write(ref, undefined, this.writeScope(scope))
  }

  /** Resolve an explicit or configured write scope and reject unavailable storage. */
  private writeScope(scope: CredentialScope | undefined): CredentialScope {
    const resolved = scope ?? this.spec.defaultScope ?? 'project'
    this.filename(resolved)
    return resolved
  }

  /* jscpd:ignore-start -- the operation-chain and reload lifecycle is the same
     reviewed contract as settings-file, deliberately mirrored (prefer symmetry
     for parallel values); the two providers own different documents and
     failure policies, so extracting a shared helper would couple their teardown
     semantics across packages for a handful of lines. */
  /** Queue one exclusive document operation behind every earlier one. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  /** Queue a reload; only an invariant violation escaping the fan-out can reject it. */
  private queueRefresh(scope: CredentialScope): void {
    void this.enqueue(() => this.refresh(scope)).catch((error: unknown) => {
      // Only an invariant violation escaping the update fan-out can reject a
      // refresh; keep the operation queue alive and surface it as an error so
      // one poisoned commit cannot silently end hot reloading forever.
      this.ctx.logger.error('credentials-local: reload commit failed at %s', this.filename(scope))
      this.ctx.logger.error(error)
    })
  }
  /* jscpd:ignore-end */

  /** Queue one line edit; entry checks reject early, the queue re-judges them at run time. */
  private async write(ref: CredentialRef, value: string | undefined, scope: CredentialScope): Promise<void> {
    const verb = value === undefined ? 'unset' : 'set'
    const filename = this.filename(scope)
    if (this.isClosed()) {
      throw new Error(`credentials-local is disposed: cannot ${verb} "${ref}"`)
    }
    this.assertUnshadowed(ref, verb)
    return this.enqueue(async () => {
      if (this.isClosed()) {
        throw new Error(`credentials-local was disposed before the queued "${ref}" ${verb} ran`)
      }
      // Re-judged at run time: the environment may have changed while queued.
      this.assertUnshadowed(ref, verb)
      // The writer lock's exclusive create needs the parent to exist; 0700
      // because the harness home holds user-private data.
      await mkdir(dirname(filename), { recursive: true, mode: 0o700 })
      await withFileLock(filename, async () => {
        // Read-modify-write: fold in any on-disk state this process has not
        // observed yet — an external edit still inside the watcher debounce
        // window, a change the watcher missed, or another process's write —
        // so the line edit below can never resurrect a stale document.
        await this.reconcileFromDisk(scope)
        const existing = this.values[scope].get(ref)
        if (value === undefined && existing === undefined) return
        const nextText = renderDocument(this.text[scope], ref, value)
        // 0600: a document holding secrets is never world-readable.
        await writeFileAtomic(filename, nextText, { mode: 0o600, dirMode: 0o700 })
        this.text[scope] = nextText
        if (value === undefined) this.values[scope].delete(ref)
        else this.values[scope].set(ref, value)
        // After the commit: a broken observer must never make the durable
        // write look failed (an INVARIANT failure still rethrows).
        this.notifyUpdated(ref)
      })
    })
  }

  /**
   * Reject a write the inherited environment would shadow into apparent
   * no-effect. Only that layer can shadow a write: everything else this
   * provider resolves ranks below the document being written.
   */
  private assertUnshadowed(ref: CredentialRef, verb: 'set' | 'unset'): void {
    if (this.inherited(ref) !== undefined) {
      throw new Error(
        `credentials-local: "${ref}" is supplied read-only by the launching environment, so ${verb} would be`
        + ' shadowed; unset it in the shell you start dsh from instead',
      )
    }
  }

  /**
   * Boot read: an absent file is an empty store; an invalid one fails the
   * plugin's activation, because a credentials document that exists but
   * cannot be trusted must never be treated as "no credentials stored".
   */
  private async loadInitial(scope: CredentialScope): Promise<void> {
    const filename = this.filename(scope)
    await assertOwnerOnly(filename)
    let text: string
    try {
      text = await readFile(filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      return
    }
    this.values[scope] = parseCredentialsDocument(text, filename)
    this.text[scope] = text
  }

  /* jscpd:ignore-start -- same deliberate mirror of settings-file's reload and
     reconcile policy: warn-and-keep on a reload, throw on a write, invariant
     failures propagate. */
  /**
   * Re-read the document after a watcher event. Unchanged content (including
   * this provider's own writes) is a no-op; an unreadable document keeps the
   * last good snapshot and warns — a live hot-reload must never take the
   * process down. An invariant violation escaping the fan-out is not a reload
   * failure and propagates to the queue's error surface.
   */
  private async refresh(scope: CredentialScope): Promise<void> {
    if (this.closed) return
    try {
      await this.reconcileFromDisk(scope)
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'INVARIANT') throw error
      this.ctx.logger.warn('credentials-local: reload failed at %s; keeping the last good document', this.filename(scope))
      this.ctx.logger.warn(error)
    }
  }

  /**
   * Compare the on-disk text against the cache and publish any difference
   * into the seam. Absence publishes the empty store; an unreadable or
   * invalid document throws, so each caller picks its policy — a reload warns
   * and keeps the last good snapshot, a write fails loud rather than
   * overwriting a document it could not understand.
   */
  private async reconcileFromDisk(scope: CredentialScope): Promise<void> {
    const filename = this.filename(scope)
    // Re-checked on every reload and before every write: an external editor or
    // a restored backup can loosen the mode after boot.
    await assertOwnerOnly(filename)
    let text: string | undefined
    try {
      text = await readFile(filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      text = undefined
    }
    if (text === this.text[scope] || this.isClosed()) return
    const next = text === undefined ? new Map<string, string>() : parseCredentialsDocument(text, filename)
    const changed = this.changedRefs(this.values[scope], next)
    this.text[scope] = text
    this.values[scope] = next
    for (const ref of changed) this.notifyUpdated(ref)
  }
  /* jscpd:ignore-end */

  /** Entries whose stored value changed; the parser has already proven every key addressable. */
  private changedRefs(prev: Map<string, string>, next: Map<string, string>): CredentialRef[] {
    const changed: CredentialRef[] = []
    for (const key of new Set([...prev.keys(), ...next.keys()])) {
      if (prev.get(key) === next.get(key)) continue
      changed.push(credentialRef(key))
    }
    return changed
  }
}

export default LocalCredentialProvider
