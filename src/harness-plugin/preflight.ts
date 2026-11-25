export const REQUIRED_HARNESS_SERVICES = [
  'connection',
  'agents',
  'typertGateway',
  'webServer',
  'sessions',
  'sessionController',
  'workspaceController',
  'settingsController',
  'agentPresets',
  'permissionPresets',
] as const

export interface HarnessProfileProbe {
  profile: string
  availableServices: readonly string[]
}

export interface HarnessProfilePreflight {
  ready: boolean
  code: 'READY' | 'HARNESS_WEB_PROFILE_REQUIRED' | 'HARNESS_SERVICES_MISSING'
  missingServices: string[]
  message: string
}

/**
 * Fail before profile mutation when the target cannot host the Relay bundle.
 * @param probe - Profile and service facts collected by setup/doctor.
 * @returns Machine-readable preflight result.
 */
const SUPPORTED_HARNESS_PROFILES = new Set(['web', 'desktop'])

export function preflightHarnessProfile(probe: HarnessProfileProbe): HarnessProfilePreflight {
  if (!SUPPORTED_HARNESS_PROFILES.has(probe.profile)) {
    return {
      ready: false,
      code: 'HARNESS_WEB_PROFILE_REQUIRED',
      missingServices: [],
      message: `DSH Relay requires the Harness web or desktop profile; received ${probe.profile}`,
    }
  }
  const available = new Set(probe.availableServices)
  const missingServices = REQUIRED_HARNESS_SERVICES.filter(service => !available.has(service))
  if (missingServices.length > 0) {
    return {
      ready: false,
      code: 'HARNESS_SERVICES_MISSING',
      missingServices,
      message: `Harness ${probe.profile} profile is missing required services: ${missingServices.join(', ')}`,
    }
  }
  return { ready: true, code: 'READY', missingServices: [], message: `Harness ${probe.profile} profile can host DSH Relay` }
}
