import { basename, isAbsolute, resolve } from 'node:path'
import type { RelayHostLauncher } from './types.js'

const nodeExecutablePattern = /^node(?:\.exe)?$/iu
const sourceEntryPattern = /(?:^|[\\/])apps[\\/]cli[\\/]src[\\/]bin\.ts$/iu
const builtEntryPattern = /(?:^|[\\/])(?:apps[\\/]cli|@deepseek-ai[\\/]dsh)[\\/]lib[\\/]bin\.js$/iu

export interface HarnessLauncherCaptureInput {
  command: string
  execArgv: readonly string[]
  entry: string | undefined
  cwd: string
  profile: string
  dshHome: string
  descriptorFile: string
}

export interface HarnessLauncherValidationInput {
  profile: string
  dshHome: string
  descriptorFile: string
}

export interface ValidatedHarnessLauncher {
  entry: string
  accessiblePaths: readonly [command: string, entry: string, cwd: string]
}

/** Owns capture and strict validation of restartable official dsh launch vectors. */
export class HarnessLauncherContractFacade {
  capture(input: HarnessLauncherCaptureInput): RelayHostLauncher | null {
    if (input.entry === undefined) return null
    const launcher: RelayHostLauncher = {
      command: input.command,
      args: [...input.execArgv, input.entry, '--profile', input.profile, '--no-open'],
      cwd: input.cwd,
      environment: {
        DSH_HOME: input.dshHome,
        DSH_PROFILE: input.profile,
        DSH_RELAY_ENDPOINT_DESCRIPTOR: input.descriptorFile,
      },
    }
    return this.validate({
      profile: input.profile,
      dshHome: input.dshHome,
      descriptorFile: input.descriptorFile,
    }, launcher) === null ? null : launcher
  }

  validate(input: HarnessLauncherValidationInput, launcher: RelayHostLauncher): ValidatedHarnessLauncher | null {
    if (!isAbsolute(launcher.command) || !nodeExecutablePattern.test(basename(launcher.command))
      || !isAbsolute(launcher.cwd)) return null
    const entry = officialDshEntry(launcher.args, input.profile)
    if (entry === null || !isAbsolute(entry)) return null
    const expectedEnvironment = resolve(launcher.environment.DSH_HOME) === resolve(input.dshHome)
      && launcher.environment.DSH_PROFILE === input.profile
      && resolve(launcher.environment.DSH_RELAY_ENDPOINT_DESCRIPTOR) === resolve(input.descriptorFile)
    if (!expectedEnvironment) return null
    return {
      entry,
      accessiblePaths: [launcher.command, entry, launcher.cwd],
    }
  }
}

function officialDshEntry(args: readonly string[], profile: string): string | null {
  if (args.length === 4 && builtEntryPattern.test(args[0] ?? '')
    && hasApplicationArgs(args, 1, profile)) return args[0] ?? null
  if (args.length === 6 && args[0] === '--import' && args[1] === 'tsx/esm'
    && sourceEntryPattern.test(args[2] ?? '') && hasApplicationArgs(args, 3, profile)) return args[2] ?? null
  return null
}

function hasApplicationArgs(args: readonly string[], offset: number, profile: string): boolean {
  return args[offset] === '--profile' && args[offset + 1] === profile && args[offset + 2] === '--no-open'
}
