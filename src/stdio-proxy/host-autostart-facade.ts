import { spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import {
  HarnessLauncherContractFacade,
  type RelayHostLauncher,
  type RelayStatusDocument,
} from '../relay-runtime/index.js'
import { FileLockFacade, type FileLockLease } from '../state-repository/index.js'
import type { ProxyInspection } from './proxy-diagnostics-facade.js'
import type { ProxyRouteFailure } from './types.js'

export type LoopbackPortState = 'free' | 'occupied' | 'unknown'

export interface HarnessHostAutostartDependencies {
  spawnHost?: (launcher: RelayHostLauncher) => Promise<void>
  probePort?: (port: number) => Promise<LoopbackPortState>
  delay?: (timeoutMs: number) => Promise<void>
  lockFactory?: () => HarnessHostAutostartLock
  accessPath?: (path: string) => Promise<void>
  now?: () => number
}

export interface HarnessHostAutostartLock {
  recoverStale(lockPath: string): Promise<{ recovered: boolean; reason: string }>
  acquire(lockPath: string): Promise<FileLockLease>
}

/** Safely restarts a previously recorded Harness Web launcher. */
export class HarnessHostAutostartFacade {
  private readonly spawnHost: (launcher: RelayHostLauncher) => Promise<void>
  private readonly probePort: (port: number) => Promise<LoopbackPortState>
  private readonly delay: (timeoutMs: number) => Promise<void>
  private readonly lockFactory: () => HarnessHostAutostartLock
  private readonly accessPath: (path: string) => Promise<void>
  private readonly now: () => number
  private readonly launcherContract = new HarnessLauncherContractFacade()

  constructor(
    private readonly descriptorFile: string,
    private readonly statusFile: string,
    private readonly timeoutMs: number,
    dependencies: HarnessHostAutostartDependencies = {},
  ) {
    this.spawnHost = dependencies.spawnHost ?? spawnBackgroundHarness
    this.probePort = dependencies.probePort ?? probeLoopbackPort
    this.delay = dependencies.delay ?? (timeoutMs => new Promise(resolveDelay => setTimeout(resolveDelay, timeoutMs)))
    this.lockFactory = dependencies.lockFactory ?? (() => new FileLockFacade({ timeoutMs }))
    this.accessPath = dependencies.accessPath ?? (path => access(path, constants.F_OK))
    this.now = dependencies.now ?? Date.now
  }

  async recover(initial: ProxyInspection, inspect: () => Promise<ProxyInspection>): Promise<ProxyInspection> {
    if (!isRecoverable(initial)) return initial
    const deadline = this.now() + this.timeoutMs
    const lockPath = join(dirname(this.statusFile), 'relay-autostart.lock')
    const locks = this.lockFactory()
    let lease: FileLockLease | undefined
    try {
      await locks.recoverStale(lockPath)
      lease = await locks.acquire(lockPath)
      const current = await inspect()
      if (current.failure === null || !isRecoverable(current)) return current
      const status = current.status
      if (status?.launcher === null || status?.launcher === undefined) {
        return replaceFailure(current, routeFailure(
          'HOST_AUTO_START_UNAVAILABLE',
          'Relay has no trusted launcher contract from a previous embedded Harness Host.',
          'Start Harness Web once with Relay 0.2.8 or later so it can publish a reusable launcher contract.',
        ))
      }
      const invalidLauncher = await this.validateLauncher(status, status.launcher)
      if (invalidLauncher !== null) return replaceFailure(current, invalidLauncher)
      const port = portFromStatus(status)
      if (port === null) {
        return replaceFailure(current, routeFailure(
          'HOST_AUTO_START_UNAVAILABLE',
          'Relay could not resolve a safe loopback port from the recorded Host identity.',
          'Start Harness Web manually and verify it binds a valid loopback port.',
        ))
      }
      const portState = await this.probePort(port)
      if (portState !== 'free') {
        const recovered = await this.waitForReady(inspect, deadline)
        if (recovered.failure === null) return recovered
        return replaceFailure(recovered, routeFailure(
          'HOST_AUTO_START_BLOCKED',
          portState === 'occupied'
            ? `Loopback port ${port} is already occupied while the recorded Relay owner is dead.`
            : `Loopback port ${port} availability could not be verified safely.`,
          'Inspect the listener; Relay will not start a second Harness Web while the port is occupied or unknown.',
        ))
      }
      await this.spawnHost(status.launcher)
      const recovered = await this.waitForReady(inspect, deadline)
      if (recovered.failure === null) return recovered
      return replaceFailure(recovered, routeFailure(
        'HOST_AUTO_START_TIMEOUT',
        `Harness Web did not publish a ready Relay endpoint within ${this.timeoutMs} ms after launch.`,
        'Inspect the Harness Web startup logs and retry after correcting the startup failure.',
      ))
    } catch (error) {
      return replaceFailure(initial, routeFailure(
        'HOST_AUTO_START_FAILED',
        `Harness Web auto-start failed: ${error instanceof Error ? error.message : String(error)}`,
        'Inspect the recorded launcher, runtime permissions, and Harness Web startup logs before retrying.',
      ))
    } finally {
      await lease?.release().catch(() => false)
    }
  }

  private async validateLauncher(status: RelayStatusDocument, launcher: RelayHostLauncher): Promise<ProxyRouteFailure | null> {
    const validated = this.launcherContract.validate({
      profile: status.profile,
      dshHome: status.dshHome,
      descriptorFile: this.descriptorFile,
    }, launcher)
    if (validated === null) {
      return routeFailure(
        'HOST_AUTO_START_UNAVAILABLE',
        'The recorded Harness launcher contract failed strict validation.',
        'Start Harness Web manually from the official dsh CLI to refresh the launcher contract.',
      )
    }
    try {
      await Promise.all(validated.accessiblePaths.map(path => this.accessPath(path)))
      return null
    } catch {
      return routeFailure(
        'HOST_AUTO_START_UNAVAILABLE',
        'The recorded Node executable, dsh entry, or working directory is no longer available.',
        'Start Harness Web manually from the current dsh installation to refresh the launcher contract.',
      )
    }
  }

  private async waitForReady(inspect: () => Promise<ProxyInspection>, deadline: number): Promise<ProxyInspection> {
    let latest = await inspect()
    while (latest.failure !== null && this.now() < deadline) {
      if (latest.failure.reasonCode === 'STATUS_FAILED') return latest
      await this.delay(Math.min(250, Math.max(1, deadline - this.now())))
      latest = await inspect()
    }
    return latest
  }
}

function isRecoverable(inspection: ProxyInspection): boolean {
  return inspection.failure?.reasonCode === 'OWNER_DEAD'
    || (inspection.failure?.reasonCode === 'STATUS_NOT_READY' && inspection.status?.state === 'stopped')
}

function portFromStatus(status: RelayStatusDocument): number | null {
  try {
    const url = new URL(status.hostIdentity)
    const port = Number(url.port)
    return url.protocol === 'http:' && Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null
  } catch {
    return null
  }
}

function replaceFailure(inspection: ProxyInspection, failure: ProxyRouteFailure): ProxyInspection {
  return { ...inspection, descriptor: null, token: null, failure }
}

function routeFailure(
  reasonCode: ProxyRouteFailure['reasonCode'],
  message: string,
  remediation: string,
): ProxyRouteFailure {
  return { code: 'RELAY_ROUTE_UNAVAILABLE', reasonCode, message, retryable: true, remediation }
}

async function spawnBackgroundHarness(launcher: RelayHostLauncher): Promise<void> {
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    const child = spawn(launcher.command, launcher.args, backgroundSpawnOptions(launcher))
    child.once('error', rejectSpawn)
    child.once('spawn', () => {
      child.off('error', rejectSpawn)
      child.unref()
      resolveSpawn()
    })
  })
}

export function backgroundSpawnOptions(launcher: RelayHostLauncher, platform: NodeJS.Platform = process.platform) {
  return {
    cwd: launcher.cwd,
    env: { ...process.env, ...launcher.environment },
    // A detached Windows process requests its own console. That creation flag can defeat
    // windowsHide/CREATE_NO_WINDOW and flash a visible Node console during Relay recovery.
    detached: platform !== 'win32',
    stdio: 'ignore' as const,
    windowsHide: true,
  }
}

async function probeLoopbackPort(port: number): Promise<LoopbackPortState> {
  return new Promise(resolveProbe => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const settle = (state: LoopbackPortState): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveProbe(state)
    }
    socket.setTimeout(500, () => settle('unknown'))
    socket.once('connect', () => settle('occupied'))
    socket.once('error', error => {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      settle(code === 'ECONNREFUSED' ? 'free' : 'unknown')
    })
  })
}
