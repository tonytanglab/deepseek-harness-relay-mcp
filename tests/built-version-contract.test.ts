import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyBuiltRelayVersion } from '../scripts/verify-built-relay-version.mjs'

test('local Codex install gate rejects a fresh manifest beside stale proxy artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-relay-built-version-'))
  try {
    await mkdir(join(root, '.codex-plugin'), { recursive: true })
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'version.json'), '{"version":"1.2.3"}\n', 'utf8')
    await writeFile(join(root, 'package.json'), '{"version":"1.2.3"}\n', 'utf8')
    await writeFile(join(root, '.codex-plugin', 'plugin.json'), '{"version":"1.2.3+codex.test"}\n', 'utf8')
    await writeFile(join(root, 'dist', 'dsh-relay.mjs'), 'const version="1.2.3"\n', 'utf8')
    await writeFile(join(root, 'dist', 'dsh-relay-harness.mjs'), 'const version="1.2.3"\n', 'utf8')
    await writeFile(
      join(root, 'dist', 'dsh-relay-proxy.mjs'),
      'const version="1.2.3", tools=["list_capabilities","start_review","wait_run"]\n',
      'utf8',
    )

    assert.deepEqual(await verifyBuiltRelayVersion(root), {
      version: '1.2.3',
      artifacts: 3,
      requiredProxyTools: 3,
    })

    await writeFile(
      join(root, 'dist', 'dsh-relay-proxy.mjs'),
      'const version="1.2.2", tools=["list_capabilities","start_review","wait_run"]\n',
      'utf8',
    )
    await assert.rejects(() => verifyBuiltRelayVersion(root), /build artifact is stale/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
