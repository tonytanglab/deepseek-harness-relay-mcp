import type { DoctorCheck, DoctorCheckStatus, DoctorFacts, DoctorReport, SetupPlan } from './types.js'

export class SetupDoctor {
  diagnose(plan: SetupPlan, facts: DoctorFacts = {}): DoctorReport {
    const checks: DoctorCheck[] = [
      {
        id: 'setup-plan',
        status: plan.ready ? 'pass' : 'fail',
        summary: plan.ready ? 'Configuration plan is valid and ready for review.' : 'Configuration plan is blocked.',
        ...(plan.ready ? {} : { remediation: 'Resolve the errors returned in plan.issues.' }),
      },
      factCheck('node-executable', facts.nodeExecutableExists, 'Node executable exists.', 'Node executable was not found.'),
      factCheck('relay-entry', facts.relayEntryExists, 'Relay entry exists.', 'Relay entry was not found.'),
      factCheck('config-parent', facts.configParentWritable, 'Configuration parent is writable.', 'Configuration parent is not writable.'),
      factCheck('broker', facts.brokerReachable, 'Relay Broker is reachable.', 'Relay Broker is not reachable.'),
      factCheck('host', facts.hostReachable, 'Harness Host is reachable.', 'Harness Host is not reachable.'),
      factCheck('workspace', facts.workspaceExists, 'Workspace exists.', 'Workspace does not exist.'),
      factCheck('model', facts.modelAvailable, 'Requested model is available.', 'Requested model is unavailable.'),
      factCheck('permission', facts.permissionAvailable, 'Requested permission is available.', 'Requested permission is unavailable.'),
      factCheck('web-profile', facts.targetWebProfile, 'Target profile is the Harness web profile.', 'Internal Relay requires the Harness web profile.'),
      factCheck('bundle', facts.bundleInstalled, 'DSH Relay bundle is installed.', 'DSH Relay bundle is not installed.'),
      factCheck('http-route', facts.httpRouteReachable, 'Authenticated MCP route is reachable.', 'Authenticated MCP route is not reachable.'),
      factCheck('token-file', facts.tokenFileSecure, 'Token file permissions are restricted.', 'Token file permissions are not restricted to the current user.'),
      factCheck('authority-owner', facts.authorityOwnerHealthy, 'Authority owner is healthy.', 'Authority owner is missing or conflicts with another mode.'),
      factCheck('recursive-config', facts.recursiveConfigurationAbsent, 'No recursive Harness-to-Relay configuration was found.', 'Relay is configured into the same Harness MCP client and would recurse.'),
    ]
    const status = checks.some(check => check.status === 'fail')
      ? 'blocked'
      : checks.some(check => check.status === 'warn' || check.status === 'skipped') ? 'degraded' : 'healthy'
    return {
      schemaVersion: 1,
      client: plan.detection.client,
      scope: plan.detection.scope,
      status,
      planReady: plan.ready,
      checks,
      plan,
    }
  }
}

function factCheck(id: string, value: boolean | undefined, passing: string, failing: string): DoctorCheck {
  if (value === undefined) return { id, status: 'skipped', summary: 'Probe was not supplied; no filesystem or network access was performed.' }
  const status: DoctorCheckStatus = value ? 'pass' : 'fail'
  return {
    id,
    status,
    summary: value ? passing : failing,
    ...(value ? {} : { remediation: `Run the ${id} probe in an authorized setup executor, then retry doctor.` }),
  }
}
