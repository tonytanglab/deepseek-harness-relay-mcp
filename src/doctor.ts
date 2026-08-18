/** Direct-launch and workspace-policy diagnostics. Never starts MCP stdio. */

import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { PACKAGE_NAME, PACKAGE_VERSION, type ResolvedConfig } from './config.ts'

/** Structured doctor report returned to the model and `/relay-setup`. */
export interface DoctorReport {
  ok: boolean
  node: { version: string; execPath: string; available: boolean }
  package: { name: string; version: string }
  launcher: { entry: string | null; direct: boolean; exists: boolean; shell: false }
  workspacePolicy: { restricted: boolean; roots: string[] }
  credentials: { path: string; exists: boolean }
  dataDirectory: { path: string }
}

/**
 * Inspect the current Node executable, dsh entry, and configured paths.
 * @param config - resolved helper settings.
 * @param entry - `process.argv[1]` of the running dsh process.
 * @param execPath - `process.execPath`.
 * @param nodeVersion - `process.version`.
 * @returns a report that never includes credential file contents.
 */
export async function inspectRuntime(
  config: ResolvedConfig,
  entry: string | undefined,
  execPath: string,
  nodeVersion: string,
): Promise<DoctorReport> {
  const entryDirect = entry !== undefined && isAbsolute(entry)
  const entryExists = entry !== undefined && isAbsolute(entry) && await pathExists(entry)
  const nodeAvailable = await pathExists(execPath)
  const credentialsExist = await pathExists(config.credentialsPath)
  return {
    ok: nodeAvailable && entryExists,
    node: { version: nodeVersion, execPath, available: nodeAvailable },
    package: { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    launcher: { entry: entry ?? null, direct: entryDirect, exists: entryExists, shell: false },
    workspacePolicy: {
      restricted: config.allowedWorkspaceRoots.length > 0,
      roots: config.allowedWorkspaceRoots,
    },
    credentials: { path: config.credentialsPath, exists: credentialsExist },
    dataDirectory: { path: config.dataDirectory },
  }
}

/**
 * Test whether a path exists and is readable without opening its contents.
 * @param path - candidate file or directory.
 * @returns true when `access` succeeds.
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch (error) {
    // ENOENT and other access failures are the negative result; nothing else can recover here.
    void error
    return false
  }
}
