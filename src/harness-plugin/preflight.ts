export const REQUIRED_HARNESS_SERVICES = [
  'apiProxy',
  'webServer',
  'sessions',
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
export function preflightHarnessProfile(probe: HarnessProfileProbe): HarnessProfilePreflight {
  if (probe.profile !== 'web') {
    return {
      ready: false,
      code: 'HARNESS_WEB_PROFILE_REQUIRED',
      missingServices: [],
      message: `DSH Relay requires the Harness web profile; received ${probe.profile}`,
    }
  }
  const available = new Set(probe.availableServices)
  const missingServices = REQUIRED_HARNESS_SERVICES.filter(service => !available.has(service))
  if (missingServices.length > 0) {
    return {
      ready: false,
      code: 'HARNESS_SERVICES_MISSING',
      missingServices,
      message: `Harness web profile is missing required services: ${missingServices.join(', ')}`,
    }
  }
  return { ready: true, code: 'READY', missingServices: [], message: 'Harness web profile can host DSH Relay' }
}
