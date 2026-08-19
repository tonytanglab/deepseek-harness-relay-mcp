import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConfig } from '../src/config.js'
import { resolvePrompt } from '../src/prompt.js'

const config = resolveConfig({ DSH_RELAY_HOST_URL: 'http://127.0.0.1:3080/' })

test('resolves legacy text without retaining image data', () => {
  assert.deepEqual(resolvePrompt({ task: 'review this' }, config), {
    content: [{ type: 'text', text: 'review this' }], summary: 'review this', imageCount: 0,
  })
})

test('accepts canonical base64 and rejects data URLs', () => {
  const result = resolvePrompt({ content: [{ type: 'image', mediaType: 'image/png', data: 'YQ==' }] }, config)
  assert.equal(result.imageCount, 1)
  assert.equal(result.summary, '')
  assert.throws(() => resolvePrompt({ content: [{ type: 'image', mediaType: 'image/png', data: 'data:image/png;base64,YQ==' }] }, config), /canonical/)
})

test('requires exactly one prompt surface', () => {
  assert.throws(() => resolvePrompt({}, config), /exactly one/)
  assert.throws(() => resolvePrompt({ task: 'x', content: [{ type: 'text', text: 'y' }] }, config), /exactly one/)
})
