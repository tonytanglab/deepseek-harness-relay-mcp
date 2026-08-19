import { mkdir, readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { version } = JSON.parse(await readFile(new URL('../version.json', import.meta.url), 'utf8'))
const dist = new URL('../dist/', import.meta.url)
await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })
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
await Promise.all([
  build({
    ...common,
    entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
    outfile: fileURLToPath(new URL('../dist/dsh-relay.mjs', import.meta.url)),
    banner: { js: '#!/usr/bin/env node' },
  }),
  build({
    ...common,
    entryPoints: [fileURLToPath(new URL('../src/proxy-index.ts', import.meta.url))],
    outfile: fileURLToPath(new URL('../dist/dsh-relay-proxy.mjs', import.meta.url)),
    banner: { js: '#!/usr/bin/env node' },
  }),
  build({
    ...common,
    entryPoints: [fileURLToPath(new URL('../src/harness-entry.ts', import.meta.url))],
    outfile: fileURLToPath(new URL('../dist/dsh-relay-harness.mjs', import.meta.url)),
    external: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/schemastery',
      '@deepseek-ai/dsh-host-apiproxy',
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-permission-presets',
    ],
  }),
])
await run(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', fileURLToPath(new URL('../tsconfig.types.json', import.meta.url))])

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`declaration build exited with ${code}`)))
  })
}
