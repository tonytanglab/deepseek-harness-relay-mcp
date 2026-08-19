import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RelayStateStore } from '../src/state-store.js'

const workerSource = String.raw`
  import { RelayStateStore } from './src/state-store.ts'
  const [statePath, serviceId] = process.argv.slice(1)
  if (!statePath || !serviceId) throw new Error('missing worker arguments')
  const state = {
    schemaVersion: 2,
    services: [{
      serviceId,
      workspaceId: 'workspace-' + serviceId,
      workspace: 'C:\\workspace\\' + serviceId,
      status: 'running',
      webUrl: 'http://127.0.0.1:3080/',
      browserOpened: false,
      browserError: null,
      managedProcess: false,
      processId: null,
      attachedAt: '2026-08-19T00:00:00.000Z',
      stoppedAt: null,
    }],
    runs: [],
    operations: [],
    permissionLeases: [],
  }
  await new RelayStateStore(statePath).save(state)
`

test('separate Node processes serialize writes without losing unique records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-process-state-'))
  const statePath = join(directory, 'state.json')
  const ids = Array.from({ length: 6 }, (_, index) => `service-${index + 1}`)

  await Promise.all(ids.map(id => runWorker(statePath, id)))

  const loaded = await new RelayStateStore(statePath).load()
  assert.deepEqual(loaded?.services.map(item => item.serviceId).sort(), [...ids].sort())
  await rm(directory, { recursive: true, force: true })
})

function runWorker(statePath: string, serviceId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      workerSource,
      statePath,
      serviceId,
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`state worker ${serviceId} exited ${code}: ${stderr}`))
    })
  })
}
