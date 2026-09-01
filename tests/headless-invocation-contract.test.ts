import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const skill = readFileSync(new URL('../skills/delegate-to-deepseek-harness/SKILL.md', import.meta.url), 'utf8')
const plugin = JSON.parse(readFileSync(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8')) as {
  interface?: { defaultPrompt?: string[] }
}

test('delegation skill forbids visible shell and temporary client fallbacks', () => {
  assert.match(skill, /only through the native MCP tools/iu)
  assert.match(skill, /\.tmp\/harness-\*-call\.mjs/iu)
  assert.match(skill, /never use `node`, PowerShell, Python, a terminal, or another shell client/iu)
  assert.match(skill, /continue from a new Codex task/iu)
})

test('plugin default prompt keeps Harness review and polling on managed background transport', () => {
  const prompt = plugin.interface?.defaultPrompt?.join(' ') ?? ''
  assert.match(prompt, /only through the plugin's native MCP tools/iu)
  assert.match(prompt, /Never create temporary Node, PowerShell, Python, or shell clients/iu)
  assert.match(prompt, /reload the updated plugin in a new Codex task/iu)
})
