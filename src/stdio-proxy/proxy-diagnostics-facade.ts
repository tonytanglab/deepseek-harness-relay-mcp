import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RelayStatusFacade, type RelayStatusDocument } from '../relay-runtime/index.js'
import { readEndpointDescriptor } from './descriptor-reader.js'
import type {
  ProxyDoctorReport,
  ProxyRouteFailure,
  ProxyRouteReasonCode,
  RelayEndpointDescriptor,
} from './types.js'

const tokenPattern = /^[A-Za-z0-9_-]{43,256}$/u

interface ProxyInspection {
  status: RelayStatusDocument | null
  descriptor: RelayEndpointDescriptor | null
  token: string | null
  tokenFile: ProxyDoctorReport['tokenFile']
  failure: ProxyRouteFailure | null
}

/** Local, credential-safe diagnostics used even when the embedded route is unavailable. */
export class ProxyDiagnosticsFacade {
  readonly statusFile: string

  constructor(
    private readonly descriptorFile: string,
    statusFile?: string,
  ) {
    this.statusFile = statusFile ?? join(dirname(descriptorFile), 'relay-status.json')
  }

  async inspect(): Promise<ProxyInspection> {
    let status: RelayStatusDocument | null
    try {
      status = await new RelayStatusFacade(this.statusFile).read()
    } catch (error) {
      return emptyInspection(failure('STATUS_INVALID', errorText(error), true,
        'Restart the Harness web profile so Relay can replace the invalid status sidecar.'))
    }
    if (status === null) {
      return emptyInspection(failure('STATUS_MISSING', 'Relay status sidecar is missing.', true,
        'Start or reload the Harness web profile with the embedded Relay plugin installed.'))
    }
    if (status.state === 'failed') {
      const detail = status.lastError
      return inspection(status, null, null, emptyToken(), failure(
        'STATUS_FAILED',
        detail === null ? 'Embedded Relay startup failed.' : `${detail.code}: ${detail.message}`,
        true,
        detail?.remediation ?? 'Correct the reported startup failure, then reload the Harness web profile.',
      ))
    }
    if (status.state !== 'ready') {
      return inspection(status, null, null, emptyToken(), failure(
        'STATUS_NOT_READY',
        `Embedded Relay status is ${status.state}.`,
        true,
        status.state === 'stopped' ? 'Start the Harness web profile.' : 'Wait for Relay startup to finish, then retry.',
      ))
    }

    let descriptor: RelayEndpointDescriptor
    try {
      descriptor = await readEndpointDescriptor(this.descriptorFile)
    } catch (error) {
      const reason = isCode(error, 'ENOENT') ? 'DESCRIPTOR_MISSING' : 'DESCRIPTOR_INVALID'
      return inspection(status, null, null, emptyToken(), failure(
        reason,
        reason === 'DESCRIPTOR_MISSING' ? 'Relay endpoint descriptor is missing.' : errorText(error),
        true,
        'Reload the Harness web profile so Relay can publish a fresh endpoint descriptor.',
      ))
    }
    if (descriptor.authorityId !== status.authorityId
      || descriptor.ownerEpoch !== status.ownerEpoch
      || descriptor.mode !== status.mode) {
      return inspection(status, descriptor, null, emptyToken(), failure(
        'STALE_ENDPOINT_DESCRIPTOR',
        'Relay status and endpoint descriptor identify different authority lifecycles.',
        true,
        'Reload the Harness web profile and wait for a matching ready status and endpoint epoch.',
      ))
    }

    let rawToken: string
    try {
      rawToken = await readFile(descriptor.tokenFilePath, { encoding: 'utf8' })
    } catch (error) {
      return inspection(status, descriptor, null, { exists: !isCode(error, 'ENOENT'), readable: false, valid: false }, failure(
        'TOKEN_UNREADABLE',
        'Relay token file is missing or unreadable.',
        true,
        'Reload Relay and ensure the token file is readable only by the current user.',
      ))
    }
    const token = rawToken.trim()
    if (!tokenPattern.test(token)) {
      return inspection(status, descriptor, null, { exists: true, readable: true, valid: false }, failure(
        'TOKEN_INVALID',
        'Relay token file has an invalid format.',
        true,
        'Remove the invalid runtime credential and reload the Harness web profile to create a new token.',
      ))
    }
    return inspection(status, descriptor, token, { exists: true, readable: true, valid: true }, null)
  }

  async doctor(relayVersion: string, connected: boolean, lastError: ProxyRouteFailure | null): Promise<ProxyDoctorReport> {
    const inspected = await this.inspect()
    const routeFailure = inspected.failure ?? lastError
    return {
      schemaVersion: 1,
      ok: inspected.failure === null && connected && lastError === null,
      relayVersion,
      mode: 'stdio-proxy',
      descriptorFile: this.descriptorFile,
      statusFile: this.statusFile,
      status: inspected.status,
      endpoint: sanitizeEndpoint(inspected.descriptor),
      tokenFile: inspected.tokenFile,
      remote: { connected, lastError },
      errorCode: routeFailure?.reasonCode ?? null,
      remediation: routeFailure?.remediation ?? null,
    }
  }

  remoteFailure(error: unknown): ProxyRouteFailure {
    const text = errorText(error)
    const remoteCode = errorDataCode(error)
    const httpCode = numericCode(error)
    if (remoteCode === 'DRAINING' || httpCode === 503 || /\b503\b|drain/iu.test(text)) {
      return failure('REMOTE_DRAINING', 'Embedded Relay route is draining.', true,
        'Wait for the Harness web profile restart to finish, then retry.')
    }
    if (remoteCode === 'UNAUTHORIZED' || httpCode === 401 || /\b401\b|unauthori[sz]ed|authentication/iu.test(text)) {
      return failure('AUTHENTICATION_FAILED', 'Embedded Relay rejected the runtime credential.', true,
        'Reload Relay so the endpoint descriptor and token file are republished together.')
    }
    if (httpCode === 404 || httpCode === 405 || /\b404\b|\b405\b|not found|method not allowed/iu.test(text)) {
      return failure('POST_ROUTE_MISSING', 'Embedded Relay POST route is not mounted.', true,
        'Reload the Harness web profile and verify the Relay plugin reached ready state.')
    }
    return failure('REMOTE_UNAVAILABLE', 'Embedded Relay route is unavailable.', true,
      'Run the local doctor, correct the reported runtime state, then retry.')
  }
}

export type { ProxyInspection }

function inspection(
  status: RelayStatusDocument | null,
  descriptor: RelayEndpointDescriptor | null,
  token: string | null,
  tokenFile: ProxyDoctorReport['tokenFile'],
  routeFailure: ProxyRouteFailure | null,
): ProxyInspection {
  return { status, descriptor, token, tokenFile, failure: routeFailure }
}

function emptyInspection(routeFailure: ProxyRouteFailure): ProxyInspection {
  return inspection(null, null, null, emptyToken(), routeFailure)
}

function emptyToken(): ProxyDoctorReport['tokenFile'] {
  return { exists: false, readable: false, valid: false }
}

function sanitizeEndpoint(descriptor: RelayEndpointDescriptor | null): ProxyDoctorReport['endpoint'] {
  if (descriptor === null) return null
  const { tokenFilePath: _tokenFilePath, ...safe } = descriptor
  return safe
}

function failure(
  reasonCode: ProxyRouteReasonCode,
  message: string,
  retryable: boolean,
  remediation: string,
): ProxyRouteFailure {
  return { code: 'RELAY_ROUTE_UNAVAILABLE', reasonCode, message, retryable, remediation }
}

function errorDataCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('data' in error)) return undefined
  const data = error.data
  return typeof data === 'object' && data !== null && 'code' in data ? data.code : undefined
}

function numericCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null
  return typeof error.code === 'number' ? error.code : null
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
