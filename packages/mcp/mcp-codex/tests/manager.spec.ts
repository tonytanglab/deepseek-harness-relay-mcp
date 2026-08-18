import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { CallId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type { HostFrame, MuxFrame, RpcRequest, RpcResponse, WorkspaceView } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { CodexRunManager } from '../src/manager.ts'
import type { ResolvedConfig } from '../src/runtime.ts'

class EventChannel<T> {
  private readonly values: T[] = []
  private wake: (() => void) | undefined
  private readonly disconnects = new Set<() => void>()

  push(value: T): void {
    this.values.push(value)
    this.wake?.()
    this.wake = undefined
  }

  disconnect(): void {
    for (const disconnect of [...this.disconnects]) disconnect()
  }

  stream(signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<T>> {
    const values = this.values
    const disconnects = this.disconnects
    const setWake = (wake: (() => void) | undefined): void => { this.wake = wake }
    const wake = (): void => { this.wake?.() }
    return {
      async *[Symbol.asyncIterator]() {
        let disconnected = false
        const disconnect = (): void => {
          disconnected = true
          wake()
          setWake(undefined)
        }
        disconnects.add(disconnect)
        onOpen?.()
        try {
          while (!signal.aborted && !disconnected) {
            const value = values.shift()
            if (value !== undefined) {
              yield { rpcId: 'event' as never, payload: value }
              continue
            }
            await new Promise<void>((resolve) => {
              const abort = (): void => { resolve() }
              setWake(resolve)
              signal.addEventListener('abort', abort, { once: true })
            })
          }
          if (disconnected) throw new Error('test disconnect')
        } finally {
          disconnects.delete(disconnect)
        }
      },
    }
  }
}

class FakeHarnessClient {
  readonly mux = new EventChannel<MuxFrame>()
  readonly host = new EventChannel<HostFrame>()
  readonly session = Session.create(SessionId('session-visible'))
  private running = false
  private turn = 0
  private failList = false

  constructor(
    private readonly workspacePath: string,
    private readonly cancelBehavior: 'settle' | 'accept-only' | 'reject' = 'settle',
  ) {}

  completeWithoutFrames(text: string): void {
    this.session.append('assistant/message', {
      turn: this.turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text }],
        source: { provider: 'test', model: 'test' },
      }),
    }, { surfaceOp: 'append' })
    this.session.append('step/end', { turn: this.turn, step: 1 })
    this.session.append('turn/end', { turn: this.turn, reason: { kind: 'completed' } })
    this.running = false
  }

  /** Make the next and later session.list RPCs reject, as a failing Host would. */
  failListing(): void {
    this.failList = true
  }

  /** Append one completed turn whose step performs the requested tool activity. */
  private appendToolTurn(text: string, turn: number): void {
    if (text === 'tool-storm') {
      for (let i = 1; i <= 3; i++) {
        const callId = CallId(`tool-call-${i}`)
        this.session.append('tool/call', { turn, step: 1, callId, name: `tool-${i}`, arguments: `{"n":${i}}` })
        this.session.append('tool/result', {
          turn,
          step: 1,
          message: createToolResultMessage({
            callId,
            content: [{ type: 'text', text: `out-${i}` }],
            isError: false,
          }),
        }, { surfaceOp: 'append' })
      }
    } else if (text === 'tool-huge') {
      this.session.append('tool/call', {
        turn,
        step: 1,
        callId: CallId('tool-call-1'),
        name: 'write',
        arguments: '{"path":"a","content":"' + 'x'.repeat(5_000) + '"}',
      })
      this.session.append('tool/result', {
        turn,
        step: 1,
        message: createToolResultMessage({
          callId: CallId('tool-call-1'),
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
    } else if (text === 'tool-error') {
      this.session.append('tool/call', {
        turn,
        step: 1,
        callId: CallId('tool-call-1'),
        name: 'read',
        arguments: '{"path":"missing"}',
      })
      this.session.append('tool/result', {
        turn,
        step: 1,
        message: createToolResultMessage({
          callId: CallId('tool-call-1'),
          content: [{ type: 'text', text: 'no such file' }],
          isError: true,
        }),
        error: { name: 'Error', code: 'ENOENT' },
      }, { surfaceOp: 'append' })
    } else {
      this.session.append('tool/call', {
        turn,
        step: 1,
        callId: CallId('tool-call-1'),
        name: 'dsh-tool-fs/edit',
        arguments: '{"path":"src/a.ts","content":"replace"}',
      })
      this.session.append('tool/result', {
        turn,
        step: 1,
        message: createToolResultMessage({
          callId: CallId('tool-call-1'),
          content: [{ type: 'text', text: 'wrote 12 lines' }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
    }
    this.session.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: `done:${text}` }],
        source: { provider: 'test', model: 'test' },
      }),
    }, { surfaceOp: 'append' })
    this.session.append('step/end', { turn, step: 1 })
    this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }

  disconnectStreams(): void {
    this.mux.disconnect()
    this.host.disconnect()
  }

  readonly client = {
    workspace: {
      create: () => ok({ workspace: this.workspace(), created: false }),
    },
    sessions: {
      create: () => ok({ sessionId: this.session.id }),
      list: () => this.failList
        ? Promise.reject(new Error('Web RPC unavailable'))
        : ok({ items: [{
          sessionId: this.session.id,
          updatedAt: 1,
          running: this.running,
          blank: this.session.events.length === 0,
        }] }),
      history: () => ok({
        events: this.session.events.map(event => ({ event })),
        hasMore: false,
      }),
      prompt: (payload: { mode: 'queue' | 'steer'; content: Array<{ type: string; text?: string }> }) => {
        const text = payload.content.flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('')
        const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
        if (payload.mode === 'steer') {
          const firstSeq = this.session.seq
          this.session.append('user/message', message, { surfaceOp: 'append' })
          this.session.append('assistant/message', {
            turn: this.turn,
            step: 1,
            message: createAssistantMessage({
              content: [{ type: 'text', text: `steered:${text}` }],
              source: { provider: 'test', model: 'test' },
            }),
          }, { surfaceOp: 'append' })
          this.session.append('step/end', { turn: this.turn, step: 1 })
          this.session.append('turn/end', { turn: this.turn, reason: { kind: 'completed' } })
          this.running = false
          this.publishSince(firstSeq)
          this.host.push({ type: 'host/session-status', sessionId: this.session.id, running: false })
          return ok({ accepted: true as const, messageId: message.id })
        }
        const turn = ++this.turn
        const firstSeq = this.session.seq
        this.session.append('turn/start', { turn })
        this.session.append('step/start', { turn, step: 1 })
        this.session.append('user/message', message, { surfaceOp: 'append' })
        this.running = true
        if (text.startsWith('tool-')) {
          this.appendToolTurn(text, turn)
          this.running = false
        } else if (text !== 'hold') {
          this.session.append('assistant/message', {
            turn,
            step: 1,
            message: createAssistantMessage({
              content: text === 'reasoning-only'
                ? [{ type: 'reasoning', text: 'K3 analysis result' }]
                : text === 'reasoning-and-text'
                  ? [
                    { type: 'reasoning', text: 'private analysis' },
                    { type: 'text', text: 'published answer' },
                  ]
                  : [{ type: 'text', text: `done:${text}` }],
              source: { provider: 'test', model: 'test' },
            }),
          }, { surfaceOp: 'append' })
          this.session.append('step/end', { turn, step: 1 })
          this.session.append('turn/end', { turn, reason: { kind: 'completed' } })
          this.running = false
        } else {
          this.publishSince(firstSeq)
          this.host.push({ type: 'host/session-status', sessionId: this.session.id, running: true })
        }
        return ok({ accepted: true as const, messageId: message.id })
      },
      cancel: () => {
        if (this.cancelBehavior === 'reject') return Promise.reject(new Error('Web RPC unavailable'))
        if (this.cancelBehavior === 'accept-only') return ok({ accepted: true as const })
        const firstSeq = this.session.seq
        this.session.append('step/end', { turn: this.turn, step: 1 })
        this.session.append('turn/end', {
          turn: this.turn,
          reason: { kind: 'aborted', reason: { kind: 'user' } },
        })
        this.running = false
        this.publishSince(firstSeq)
        this.host.push({ type: 'host/session-status', sessionId: this.session.id, running: false })
        return ok({ accepted: true as const })
      },
    },
    events: {
      mux: (_payload: object, signal: AbortSignal, onOpen?: () => void) => this.mux.stream(signal, onOpen),
      host: (_payload: object, signal: AbortSignal, onOpen?: () => void) => this.host.stream(signal, onOpen),
    },
  } as unknown as IApiClient

  private workspace(): WorkspaceView {
    return {
      workspaceId: 'workspace-1' as never,
      path: this.workspacePath,
      title: 'workspace',
      sessionIds: [this.session.id],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
  }

  private publishSince(firstSeq: number): void {
    for (const event of this.session.events.filter(candidate => candidate.seq >= firstSeq)) {
      this.mux.push({ type: 'session/event', sessionId: this.session.id, event })
    }
  }
}

function ok<T>(value: T): Promise<RpcResponse<T>> {
  return Promise.resolve({ rpcId: 'rpc' as never, result: { ok: true, value } })
}

interface FakeProcessOptions {
  output?: string | Buffer | Buffer[]
  exitBeforeReady?: boolean
  cancelBehavior?: 'settle' | 'accept-only' | 'reject'
  /** Platform browser opener settlement: exit 0, exit 1, or never settle. */
  opener?: 'exit' | 'fail' | 'hang'
}

interface SpawnRecord {
  argv: string[]
  terminated: boolean
}

function fakeSubprocess(
  spawns: SpawnRecord[],
  options: FakeProcessOptions = {},
): SubprocessRuntime {
  return {
    resolveExecutable: (command: string) => Promise.resolve(command),
    spawn: (spec: { argv: string[] }) => {
      const record: SpawnRecord = { argv: spec.argv, terminated: false }
      spawns.push(record)
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const done = Promise.withResolvers<{ exitCode: number | null; signal: NodeJS.Signals | null }>()
      let terminated = false
      const opener = spawns.length > 1
      queueMicrotask(() => {
        if (opener) {
          if (options.opener === 'hang') return
          done.resolve({ exitCode: options.opener === 'fail' ? 1 : 0, signal: null })
          stdout.end()
          stderr.end()
          return
        }
        if (options.exitBeforeReady === true) {
          stdout.end()
          stderr.end()
          done.resolve({ exitCode: 1, signal: null })
          return
        }
        const output = options.output ?? '{"type":"dsh/web-ready","url":"http://127.0.0.1:43123"}\n'
        for (const chunk of Array.isArray(output) ? output : [output]) stdout.write(chunk)
      })
      const handle: SubprocessHandle = {
        pid: 4321,
        stdin: undefined,
        stdout,
        stderr,
        collected: {},
        done: done.promise,
        terminate: () => {
          if (terminated) return
          terminated = true
          record.terminated = true
          stdout.end()
          stderr.end()
          done.resolve({ exitCode: 0, signal: null })
        },
        waitForExit: () => Promise.resolve(terminated),
      }
      return handle
    },
  } as unknown as SubprocessRuntime
}

async function setup(options: FakeProcessOptions & {
  startupTimeoutMs?: number
  maxToolEvents?: number
  maxToolEventBytes?: number
} = {}): Promise<{
  manager: CodexRunManager
  workspace: string
  spawns: SpawnRecord[]
  harness: FakeHarnessClient
}> {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-mcp-manager-'))
  const workspace = await mkdtemp(join(parent, 'workspace-'))
  const spawns: SpawnRecord[] = []
  const harness = new FakeHarnessClient(workspace, options.cancelBehavior)
  const config: ResolvedConfig = {
    dataDirectory: join(parent, 'services'),
    credentialsPath: join(parent, '.credentials.yaml'),
    allowedWorkspaceRoots: [parent],
    startupTimeoutMs: options.startupTimeoutMs ?? 1_000,
    stopGraceMs: 100,
    rpcTimeoutMs: 1_000,
    browserOpenTimeoutMs: 100,
    eventReconnectDelayMs: 10,
    maxTaskCharacters: 100_000,
    maxLogCharacters: 100_000,
    maxAssistantTextBytes: 50_000,
    maxToolEvents: options.maxToolEvents ?? 20,
    maxToolEventBytes: options.maxToolEventBytes ?? 2_000,
  }
  const manager = new CodexRunManager(fakeSubprocess(spawns, options), config, {
    createClient: () => harness.client,
  })
  return { manager, workspace, spawns, harness }
}

describe('Codex MCP lifecycle manager', () => {
  it('deduplicates concurrent workspace startup and returns a session deep link after fast completion', async () => {
    const { manager, workspace, spawns } = await setup()
    const [left, right] = await Promise.all([
      manager.startService({ workspace }),
      manager.startService({ workspace }),
    ])
    expect(left.serviceId).toBe(right.serviceId)
    expect(spawns).toHaveLength(1)
    expect(spawns[0]?.argv).not.toContain('npx')

    const run = await manager.start({ workspace, task: '/literal-task' })
    expect(run).toMatchObject({ status: 'succeeded', assistantText: 'done:/literal-task' })
    expect(run.webUrl).toMatch(/^http:\/\/127\.0\.0\.1:43123\/\?sessionId=session-visible$/u)
    await manager.close()
  })

  it('returns reasoning text only when a completed run has no answer text', async () => {
    const { manager, workspace } = await setup()
    const reasoningOnly = await manager.start({ workspace, task: 'reasoning-only' })
    expect(reasoningOnly).toMatchObject({ status: 'succeeded', assistantText: 'K3 analysis result' })

    const withAnswer = await manager.start({
      workspace,
      task: 'reasoning-and-text',
      sessionId: reasoningOnly.sessionId,
    })
    expect(withAnswer).toMatchObject({ status: 'succeeded', assistantText: 'published answer' })
    await manager.close()
  })

  it('settles cancellation only after the durable aborted turn and idle frame', async () => {
    const { manager, workspace } = await setup()
    const run = await manager.start({ workspace, task: 'hold' })
    expect(run.status).toBe('running')
    const cancellation = manager.cancel(run.runId)
    await expect(manager.steer(run.runId, 'too late')).rejects.toThrow('cancellation is already requested')
    const requested = await cancellation
    expect(requested.cancelRequested).toBe(true)
    expect((await manager.wait(run.runId, 1_000)).status).toBe('cancelled')
    expect((await manager.cancel(run.runId)).status).toBe('cancelled')
    await manager.close()
  })

  it.each([
    ['accepted cancellation without idle', 'accept-only' as const, 'did not reach Agent idle'],
    ['failed cancellation RPC', 'reject' as const, 'cancellation request failed'],
  ])('terminates the shared Web service after %s', async (_name, cancelBehavior, expected) => {
    const { manager, workspace } = await setup({ cancelBehavior })
    const run = await manager.start({ workspace, task: 'hold' })
    const cancelled = await manager.cancel(run.runId)
    expect(cancelled).toMatchObject({ status: 'failed', cancelRequested: true })
    expect(cancelled.error).toContain(expected)
    expect(manager.listServices()).toMatchObject([{ status: 'failed' }])
    await manager.close()
  })

  it('inserts a literal correction into an active run without changing its identity', async () => {
    const { manager, workspace } = await setup()
    const run = await manager.start({ workspace, task: 'hold' })
    const steered = await manager.steer(run.runId, '/correct-now')
    expect(steered).toMatchObject({
      accepted: true,
      run: { runId: run.runId, sessionId: run.sessionId },
    })
    expect(steered.messageId).toBeTruthy()
    let completed = manager.get(run.runId)
    for (let attempt = 0; attempt < 8 && completed.status === 'running'; attempt++) {
      completed = await manager.wait(run.runId, 1_000)
    }
    expect(completed).toMatchObject({
      status: 'succeeded',
      assistantText: 'steered:/correct-now',
    })
    await expect(manager.steer(run.runId, 'after completion')).rejects.toThrow('is not running')
    await manager.close()
  })

  it('fills event history after streams reconnect', async () => {
    const { manager, workspace, harness } = await setup()
    const run = await manager.start({ workspace, task: 'hold' })
    harness.disconnectStreams()
    harness.completeWithoutFrames('completed while disconnected')
    await expect(manager.wait(run.runId, 1_000)).resolves.toMatchObject({
      status: 'succeeded',
      assistantText: 'completed while disconnected',
    })
    await manager.close()
  })

  it('frames a readiness record split inside a UTF-8 code point', async () => {
    const encoded = Buffer.from('{"type":"dsh/web-ready","日志":"中","url":"http://127.0.0.1:43123"}\n', 'utf8')
    const split = encoded.indexOf(Buffer.from('中', 'utf8')) + 1
    const { manager, workspace } = await setup({ output: [encoded.subarray(0, split), encoded.subarray(split)] })
    await expect(manager.startService({ workspace })).resolves.toMatchObject({ status: 'running' })
    await manager.close()
  })

  it.each([
    ['invalid UTF-8', Buffer.from([0xff, 0x0a]), 'encoded data was not valid'],
    ['a non-loopback URL', '{"type":"dsh/web-ready","url":"http://example.com:43123"}\n', 'rejected Web readiness URL'],
  ])('fails startup for %s', async (_name, output, expected) => {
    const { manager, workspace } = await setup({ output })
    await expect(manager.startService({ workspace })).rejects.toThrow(expected)
    expect(manager.listServices()).toMatchObject([{ status: 'failed' }])
    await manager.close()
  })

  it('fails startup after malformed readiness times out', async () => {
    const { manager, workspace } = await setup({ output: '{not-json}\n', startupTimeoutMs: 20 })
    await expect(manager.startService({ workspace })).rejects.toThrow('Harness Web readiness did not complete within 20ms')
    expect(manager.listServices()).toMatchObject([{ status: 'failed' }])
    await manager.close()
  })

  it('fails startup when the Web process exits before readiness', async () => {
    const { manager, workspace } = await setup({ exitBeforeReady: true })
    await expect(manager.startService({ workspace })).rejects.toThrow('exited before readiness')
    expect(manager.listServices()).toMatchObject([{ status: 'failed' }])
    await manager.close()
  })

  it('terminates the Web tree when event-stream reconciliation fails after reconnect', async () => {
    const { manager, workspace, spawns, harness } = await setup()
    const run = await manager.start({ workspace, task: 'hold' })
    expect(run.status).toBe('running')
    harness.failListing()
    harness.disconnectStreams()
    await expect(manager.wait(run.runId, 1_000)).resolves.toMatchObject({ status: 'failed' })
    expect(manager.listServices()).toMatchObject([{ status: 'failed' }])
    expect(spawns[0]?.terminated).toBe(true)
    await manager.close()
  })

  it('opens the browser and records success when the opener exits cleanly', async () => {
    const { manager, workspace, spawns } = await setup()
    const service = await manager.startService({ workspace, openBrowser: true })
    expect(service).toMatchObject({ status: 'running', browserOpened: true, browserError: null })
    expect(spawns[1]?.argv).not.toContain('npx')
    await manager.close()
  })

  it('bounds a hanging browser opener, terminates it, and keeps the service running', async () => {
    const { manager, workspace, spawns } = await setup({ opener: 'hang' })
    const service = await manager.startService({ workspace })
    await expect(manager.openService(service.serviceId)).rejects.toThrow('browser opener did not complete within')
    expect(spawns[1]?.terminated).toBe(true)
    expect(manager.listServices()).toMatchObject([{ status: 'running' }])
    expect(manager.listServices()[0]?.browserError).toContain('browser opener did not complete within')
    await manager.close()
  })

  it('reports a non-zero browser opener exit code without stopping the service', async () => {
    const { manager, workspace } = await setup({ opener: 'fail' })
    const service = await manager.startService({ workspace })
    await expect(manager.openService(service.serviceId)).rejects.toThrow('exited with code 1')
    expect(manager.listServices()).toMatchObject([{ status: 'running' }])
    expect(manager.listServices()[0]?.browserError).toContain('exited with code 1')
    await manager.close()
  })

  it('returns the admitted run when the browser open fails', async () => {
    const { manager, workspace } = await setup({ opener: 'fail' })
    const run = await manager.start({ workspace, task: 'hold', openBrowser: true })
    expect(run).toMatchObject({ status: 'running' })
    expect(run.runId).toBeTruthy()
    expect(manager.listServices()[0]?.browserError).toContain('exited with code 1')
    expect((await manager.cancel(run.runId)).status).toBe('cancelled')
    await manager.close()
  })

  it('exposes the bounded tool calls and results of a completed run', async () => {
    const { manager, workspace } = await setup()
    const run = await manager.start({ workspace, task: 'tool-use' })
    expect(run).toMatchObject({ status: 'succeeded' })
    expect(run.lastToolEvents).toEqual([
      {
        kind: 'call',
        callId: 'tool-call-1',
        name: 'dsh-tool-fs/edit',
        arguments: '{"path":"src/a.ts","content":"replace"}',
        truncated: false,
      },
      {
        kind: 'result',
        callId: 'tool-call-1',
        summary: 'wrote 12 lines',
        error: null,
        truncated: false,
      },
    ])
    await manager.close()
  })

  it('retains only the most recent maxToolEvents tool entries', async () => {
    const { manager, workspace } = await setup({ maxToolEvents: 2 })
    const run = await manager.start({ workspace, task: 'tool-storm' })
    // eslint-disable-next-line no-console
    console.log('DEBUG storm', run.status, run.error, run.lastEventSeq, JSON.stringify(run.lastToolEvents))
    expect(run.lastToolEvents).toEqual([
      { kind: 'result', callId: 'tool-call-2', summary: 'out-2', error: null, truncated: false },
      { kind: 'call', callId: 'tool-call-3', name: 'tool-3', arguments: '{"n":3}', truncated: false },
    ])
    await manager.close()
  })

  it('truncates oversized tool fields on UTF-8 boundaries', async () => {
    const { manager, workspace } = await setup({ maxToolEventBytes: 100 })
    const run = await manager.start({ workspace, task: 'tool-huge' })
    const call = run.lastToolEvents.find(entry => entry.kind === 'call')
    if (call === undefined || call.kind !== 'call') throw new Error('expected a retained tool call')
    expect(call).toMatchObject({ kind: 'call', name: 'write', truncated: true })
    expect(call.arguments.length).toBeLessThanOrEqual(100)
    expect(call.arguments).toMatch(/"\}$/u)
    const result = run.lastToolEvents.find(entry => entry.kind === 'result')
    expect(result).toMatchObject({ kind: 'result', summary: 'ok', truncated: false })
    await manager.close()
  })

  it('reports the internal failure identity of a failed tool result', async () => {
    const { manager, workspace } = await setup()
    const run = await manager.start({ workspace, task: 'tool-error' })
    expect(run.lastToolEvents).toContainEqual({
      kind: 'result',
      callId: 'tool-call-1',
      summary: 'no such file',
      error: 'Error: ENOENT',
      truncated: false,
    })
    await manager.close()
  })
})
