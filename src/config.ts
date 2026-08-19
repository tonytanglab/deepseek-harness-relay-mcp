import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

export interface RelayConfig {
  hostUrl: string
  allowedWorkspaceRoots: string[]
  rpcTimeoutMs: number
  pollIntervalMs: number
  maxTaskCharacters: number
  maxAssistantTextBytes: number
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  stateFile: string
  persistPromptText: boolean
  clientPrincipalId: string
  permissionLeaseMs: number
  maxHistoryPages: number
  runStallMs: number
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const hostUrl = validateHostUrl(env.DSH_RELAY_HOST_URL ?? 'http://127.0.0.1:3080/')
  const roots = (env.DSH_RELAY_ALLOWED_WORKSPACE_ROOTS ?? '')
    .split(delimiter)
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => resolve(value))
  return {
    hostUrl,
    allowedWorkspaceRoots: roots,
    rpcTimeoutMs: integer(env.DSH_RELAY_RPC_TIMEOUT_MS, 30_000, 1_000, 120_000),
    pollIntervalMs: integer(env.DSH_RELAY_POLL_INTERVAL_MS, 750, 100, 5_000),
    maxTaskCharacters: integer(env.DSH_RELAY_MAX_TASK_CHARACTERS, 100_000, 1, 1_000_000),
    maxAssistantTextBytes: integer(env.DSH_RELAY_MAX_ASSISTANT_TEXT_BYTES, 256_000, 1_024, 4_000_000),
    maxImageBytes: integer(env.DSH_RELAY_MAX_IMAGE_BYTES, 5 * 1024 * 1024, 1, 50 * 1024 * 1024),
    maxImagesPerMessage: integer(env.DSH_RELAY_MAX_IMAGES, 20, 1, 100),
    maxMessageImageBytes: integer(env.DSH_RELAY_MAX_MESSAGE_IMAGE_BYTES, 100 * 1024 * 1024, 1, 500 * 1024 * 1024),
    stateFile: resolve(env.DSH_RELAY_STATE_FILE ?? join(env.LOCALAPPDATA ?? homedir(), 'dsh-relay', 'state.json')),
    persistPromptText: boolean(env.DSH_RELAY_PERSIST_PROMPT_TEXT, false),
    clientPrincipalId: nonEmpty(env.DSH_RELAY_CLIENT_PRINCIPAL_ID, 'local-user'),
    permissionLeaseMs: integer(env.DSH_RELAY_PERMISSION_LEASE_MS, 24 * 60 * 60 * 1_000, 60_000, 7 * 24 * 60 * 60 * 1_000),
    maxHistoryPages: integer(env.DSH_RELAY_MAX_HISTORY_PAGES, 100, 1, 10_000),
    runStallMs: integer(env.DSH_RELAY_RUN_STALL_MS, 5 * 60_000, 1_000, 24 * 60 * 60_000),
  }
}

function nonEmpty(raw: string | undefined, fallback: string): string {
  const value = (raw ?? fallback).trim()
  if (value.length === 0) throw new Error('invalid empty string setting')
  return value
}

function boolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`invalid boolean setting: ${raw}`)
}

export function validateHostUrl(input: string): string {
  const url = new URL(input)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('DSH Relay only connects to loopback HTTP Harness hosts')
  }
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.href
}

function integer(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid integer setting: ${raw}`)
  return value
}
