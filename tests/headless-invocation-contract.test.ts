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

test('delegation skill keeps Harness browser opening opt-in', () => {
  assert.match(skill, /Keep Harness headless by default/iu)
  assert.match(skill, /without calling `open_run`, setting `openBrowser: true`, or opening the OS browser/iu)
  assert.match(skill, /only when the user explicitly asks to open or show the Harness page/iu)
  assert.doesNotMatch(skill, /On the first successful run[^\n]*call `open_run`/iu)
})

test('named review requests carry exact routing and existing authorization without reconfirmation', () => {
  assert.match(skill, /Every `start_review` call must pass the exact `provider`, exact `model`, and `authorizationBasis: explicit-user-request`/u)
  assert.match(skill, /Do not ask for a second disclosure or consent confirmation solely because/u)
  assert.match(skill, /Do not ask the user to repeat the same authorization/u)
  const prompts = plugin.interface?.defaultPrompt ?? []
  assert.match(prompts.join(' '), /pass exact provider\/model and authorizationBasis[\s\S]*do not reconfirm/iu)
})

test('plugin default prompt keeps Harness review and polling on managed background transport', () => {
  const prompts = plugin.interface?.defaultPrompt ?? []
  assert.ok(prompts.length > 0 && prompts.length <= 3)
  for (const prompt of prompts) {
    assert.ok(prompt.length <= 128, `Codex ignores starter prompts longer than 128 characters: ${prompt.length}`)
  }
  const prompt = prompts.join(' ')
  assert.match(prompt, /only through the plugin's native MCP tools/iu)
  assert.match(prompt, /Never create temporary Node, PowerShell, Python, or shell clients/iu)
  assert.match(prompt, /reload the updated plugin in a new Codex task/iu)
})
