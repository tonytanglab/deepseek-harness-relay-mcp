import path from 'node:path'
import type { SetupPlatform, SetupIssue, StdioLauncherPlan, StdioLauncherRequest } from './types.js'

export class StdioLauncherPlanner {
  plan(request: StdioLauncherRequest): { launcher?: StdioLauncherPlan; issues: readonly SetupIssue[] } {
    const pathApi = pathFor(request.platform)
    const issues: SetupIssue[] = []
    const nodeExecutable = pathApi.normalize(request.nodeExecutable)
    const relayEntry = pathApi.normalize(request.relayEntry)

    if (!pathApi.isAbsolute(nodeExecutable)) {
      issues.push(error('LAUNCHER_NODE_NOT_ABSOLUTE', 'Node executable must be an absolute path.'))
    }
    const executableName = pathApi.basename(nodeExecutable).toLowerCase()
    if (executableName !== 'node' && executableName !== 'node.exe') {
      issues.push(error(
        'LAUNCHER_NOT_NODE',
        `Expected node or node.exe, but received ${executableName || '(empty)'}.`,
        'Resolve the real Node executable. Never pass pnpm.exe, pnpm.cmd, npx, or another shim as the ESM runtime.',
      ))
    }
    if (!pathApi.isAbsolute(relayEntry)) {
      issues.push(error('LAUNCHER_ENTRY_NOT_ABSOLUTE', 'DSH Relay entry must be an absolute path.'))
    }
    if (!['.mjs', '.js', '.cjs'].includes(pathApi.extname(relayEntry).toLowerCase())) {
      issues.push(error(
        'LAUNCHER_ENTRY_NOT_JAVASCRIPT',
        'DSH Relay entry must be a JavaScript module (.mjs, .js, or .cjs).',
      ))
    }
    if (issues.some(issue => issue.severity === 'error')) return { issues }

    return {
      launcher: {
        transport: 'stdio',
        command: nodeExecutable,
        args: [relayEntry],
        environment: sortedEnvironment(request.environment),
        resolution: 'absolute-node',
      },
      issues,
    }
  }
}

export function pathFor(platform: SetupPlatform): typeof path.win32 | typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix
}

function sortedEnvironment(environment: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  if (environment === undefined) return {}
  return Object.fromEntries(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)))
}

function error(code: string, message: string, remediation?: string): SetupIssue {
  return { code, severity: 'error', message, ...(remediation === undefined ? {} : { remediation }) }
}
