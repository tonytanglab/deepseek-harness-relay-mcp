import { spawn } from 'node:child_process'
import { chmod, stat } from 'node:fs/promises'
import { hostname, userInfo } from 'node:os'
import { decodeUtf8Strict } from '../strict-utf8.js'

const WINDOWS_SID_SCRIPT = String.raw`
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
[Console]::Write([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
`

const WINDOWS_CHECK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $utf8
if (![System.IO.File]::Exists($target)) {
  [Console]::Write((@{ restricted = $false; detail = 'file does not exist' } | ConvertTo-Json -Compress))
  return
}
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$acl = [System.IO.File]::GetAccessControl($target)
$rules = @($acl.Access)
$ownerSid = $acl.Owner
try { $ownerSid = ([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
$ruleOk = $false
if ($rules.Count -eq 1) {
  $rule = $rules[0]
  $ruleSid = $rule.IdentityReference.Value
  try { $ruleSid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
  $full = (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)
  $ruleOk = !$rule.IsInherited -and $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $ruleSid -eq $identity.User.Value -and $full
}
$restricted = $acl.AreAccessRulesProtected -and $ownerSid -eq $identity.User.Value -and $ruleOk
$detail = if ($restricted) { $null } else { 'ACL is not current-user-only' }
[Console]::Write((@{ restricted = $restricted; detail = $detail } | ConvertTo-Json -Compress))
`

export interface FilePermissionCheck {
  restricted: boolean
  detail?: string
}

/**
 * Injectable permission backend: non-Windows restricts to mode 0600 via chmod
 * and Windows applies the equivalent current-user-only ACL. Failures always
 * propagate; they are never swallowed by platform guards.
 */
export interface FilePermissionBackend {
  readonly platform: NodeJS.Platform
  restrict(path: string, options?: { existing?: boolean }): Promise<void>
  check(path: string): Promise<FilePermissionCheck>
}

export class FilePermissionError extends Error {
  readonly code = 'FILE_PERMISSION_FAILED'

  constructor(operation: string, path: string, detail: string, options?: ErrorOptions) {
    super(`failed to ${operation} permissions for ${path}: ${detail}`, options)
    this.name = 'FilePermissionError'
  }
}

/** Runs a permission command; capture=true collects stdout for inspection. */
export interface PermissionCommandRunner {
  (command: string, args: string[], capture: boolean): Promise<{ code: number; stdout?: string; stderr?: string }>
}

export class NodeFilePermissionBackend implements FilePermissionBackend {
  readonly platform: NodeJS.Platform
  readonly #run: PermissionCommandRunner
  #windowsSid: string | null

  constructor(options: { platform?: NodeJS.Platform; run?: PermissionCommandRunner; windowsSid?: string } = {}) {
    this.platform = options.platform ?? process.platform
    this.#run = options.run ?? runPermissionCommand
    this.#windowsSid = options.windowsSid ?? null
  }

  async restrict(path: string, options: { existing?: boolean } = {}): Promise<void> {
    if (this.platform === 'win32') {
      const sid = await this.#resolveWindowsSid(path)
      const operations = options.existing === true
        ? [[path, '/reset'], [path, '/inheritance:r', '/grant:r', `*${sid}:F`]]
        : [[path, '/inheritance:r', '/grant:r', `*${sid}:F`]]
      for (const args of operations) {
        let outcome: { code: number; stderr?: string }
        try {
          outcome = await this.#run('icacls.exe', args, false)
        } catch (error) {
          throw new FilePermissionError('apply the current-user ACL to', path, errorText(error), { cause: error })
        }
        if (outcome.code !== 0) throw new FilePermissionError('apply the current-user ACL to', path, `icacls exited with ${outcome.code}`)
      }
      return
    }
    try {
      await chmod(path, 0o600)
    } catch (error) {
      throw new FilePermissionError('chmod 0600', path, errorText(error), { cause: error })
    }
  }

  async check(path: string): Promise<FilePermissionCheck> {
    if (this.platform === 'win32') {
      let outcome: { code: number; stdout?: string; stderr?: string }
      try {
        outcome = await this.#runWindowsPowerShell(path, WINDOWS_CHECK_SCRIPT)
      } catch (error) {
        return { restricted: false, detail: errorText(error) }
      }
      if (outcome.code !== 0) {
        const stderr = outcome.stderr?.trim()
        return { restricted: false, detail: `PowerShell exited with ${outcome.code}${stderr ? `: ${stderr}` : ''}` }
      }
      try {
        const parsed = JSON.parse(outcome.stdout ?? '') as FilePermissionCheck
        return typeof parsed.restricted === 'boolean' ? parsed : { restricted: false, detail: 'invalid ACL inspection output' }
      } catch {
        return { restricted: false, detail: 'invalid ACL inspection output' }
      }
    }
    try {
      const mode = (await stat(path)).mode & 0o777
      return mode === 0o600
        ? { restricted: true }
        : { restricted: false, detail: `mode is 0${mode.toString(8)}` }
    } catch (error) {
      return { restricted: false, detail: errorText(error) }
    }
  }

  async #resolveWindowsSid(path: string): Promise<string> {
    if (this.#windowsSid !== null) return this.#windowsSid
    const outcome = await this.#runWindowsPowerShell(path, WINDOWS_SID_SCRIPT)
    const sid = outcome.stdout?.trim() ?? ''
    if (outcome.code !== 0 || !/^S-\d(?:-\d+)+$/u.test(sid)) {
      throw new FilePermissionError('resolve the current-user SID for', path, `PowerShell exited with ${outcome.code}`)
    }
    this.#windowsSid = sid
    return sid
  }

  #runWindowsPowerShell(path: string, script: string): Promise<{ code: number; stdout?: string; stderr?: string }> {
    const command = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    const target = path.replaceAll("'", "''")
    const commandText = `$target = '${target}'\n${script}`
    return this.#run(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', commandText], true).catch(error => {
      throw new FilePermissionError('apply the current-user ACL to', path, errorText(error), { cause: error })
    })
  }
}

/**
 * The current-user Windows principal in DOMAIN\USER form. Uses USERDOMAIN when
 * set (always present in a user session) and falls back to the local hostname
 * so the ACL always names the invoking identity.
 */
export function currentUserPrincipal(
  env: NodeJS.ProcessEnv = process.env,
  hostnameValue: string = hostname(),
  usernameValue: string = userInfo().username,
): string {
  const domain = env.USERDOMAIN
  if (typeof domain === 'string' && domain.length > 0) return `${domain}\\${usernameValue}`
  return `${hostnameValue}\\${usernameValue}`
}

function runCommand(command: string, args: string[], capture: boolean): Promise<{ code: number; stdout?: string; stderr?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout?.on('data', chunk => { stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) })
    child.stderr?.on('data', chunk => { stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) })
    child.once('error', reject)
    child.once('exit', code => {
      try {
        resolve({
          code: code ?? -1,
          ...(capture ? {
            stdout: decodeUtf8Strict(Buffer.concat(stdout), `${command} stdout`),
            stderr: decodeUtf8Strict(Buffer.concat(stderr), `${command} stderr`),
          } : {}),
        })
      } catch (error) {
        reject(error)
      }
    })
  })
}

export async function runPermissionCommand(command: string, args: string[], capture: boolean): Promise<{ code: number; stdout?: string; stderr?: string }> {
  return runCommand(command, args, capture)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
