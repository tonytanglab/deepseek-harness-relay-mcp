import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { build } from 'esbuild'
import { acquireBuildLock, promoteArtifacts } from './build-lib.mjs'
import { readJsonFileStrict } from './strict-utf8.mjs'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const dist = join(repoRoot, 'dist')
const { version } = await readJsonFileStrict(new URL('../version.json', import.meta.url))
const staging = join(repoRoot, `.build-staging-${process.pid}-${randomUUID()}`)
const lockPath = join(repoRoot, '.build-lock')
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  sourcesContent: false,
  minify: true,
  define: { __DSH_RELAY_VERSION__: JSON.stringify(version) },
}
try {
  // Never remove the shared dist first: build into an isolated staging tree so
  // a failure leaves the last good build untouched, then promote atomically.
  await mkdir(staging, { recursive: true })
  await Promise.all([
    build({
      ...common,
      entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
      outfile: join(staging, 'dsh-relay.mjs'),
      banner: { js: '#!/usr/bin/env node' },
    }),
    build({
      ...common,
      entryPoints: [fileURLToPath(new URL('../src/proxy-index.ts', import.meta.url))],
      outfile: join(staging, 'dsh-relay-proxy.mjs'),
      banner: { js: '#!/usr/bin/env node' },
    }),
    build({
      ...common,
      entryPoints: [fileURLToPath(new URL('../src/harness-entry.ts', import.meta.url))],
      outfile: join(staging, 'dsh-relay-harness.mjs'),
      external: [
        '@deepseek-ai/cordis',
        '@deepseek-ai/schemastery',
      ],
    }),
  ])
  await run(process.execPath, [
    fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)),
    '-p',
    fileURLToPath(new URL('../tsconfig.types.json', import.meta.url)),
    '--outDir',
    join(staging, 'types'),
  ])
  const lease = await acquireBuildLock(lockPath)
  try {
    await promoteArtifacts(staging, dist)
  } finally {
    await lease.release()
  }
} finally {
  await rm(staging, { recursive: true, force: true })
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`declaration build exited with ${code}`)))
  })
}
