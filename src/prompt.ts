import type { PromptPart, TaskScopeDeclaration } from './types.js'
import type { RelayConfig } from './config.js'

export function resolvePrompt(input: { task?: string; content?: PromptPart[] }, config: RelayConfig): {
  content: PromptPart[]
  summary: string
  imageCount: number
} {
  if ((input.task === undefined) === (input.content === undefined)) throw new Error('provide exactly one of task or content')
  const content = input.task === undefined ? input.content ?? [] : [{ type: 'text' as const, text: input.task }]
  if (content.length === 0) throw new Error('content must not be empty')
  let imageCount = 0
  let imageBytes = 0
  let textCharacters = 0
  for (const part of content) {
    if (part.type === 'text') {
      textCharacters += part.text.length
      continue
    }
    imageCount += 1
    const bytes = validateBase64(part.data)
    if (bytes > config.maxImageBytes) throw new Error(`one image exceeds ${config.maxImageBytes} bytes`)
    imageBytes += bytes
  }
  if (textCharacters > config.maxTaskCharacters) throw new Error(`prompt text exceeds ${config.maxTaskCharacters} characters`)
  if (imageCount > config.maxImagesPerMessage) throw new Error(`prompt exceeds ${config.maxImagesPerMessage} images`)
  if (imageBytes > config.maxMessageImageBytes) throw new Error(`prompt images exceed ${config.maxMessageImageBytes} bytes total`)
  const summary = content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
  return { content, summary, imageCount }
}

export function appendTaskScope(
  input: { task?: string; content?: PromptPart[] },
  scope?: TaskScopeDeclaration,
  authorizationBasis?: 'explicit-user-request',
): { task?: string; content?: PromptPart[] } {
  if (scope === undefined && authorizationBasis === undefined) return input
  const declaration = [
    'Delegated task metadata:',
    ...(authorizationBasis === undefined ? [] : [
      `authorizationBasis: ${authorizationBasis}`,
      'The caller records that the user explicitly selected Harness to inspect this authorized workspace. This evidence does not authorize any broader workspace, scope, permission, provider, or external action.',
    ]),
    ...(scope === undefined ? [] : [
      'Task scope declaration (instructions only; not a filesystem access control):',
      `reviewTargets: ${JSON.stringify(scope.reviewTargets)}`,
      `contextReadScope: ${JSON.stringify(scope.contextReadScope)}`,
      `excludedPaths: ${JSON.stringify(scope.excludedPaths)}`,
      `writeScope: ${JSON.stringify(scope.writeScope)}`,
      'Treat reviewTargets as the subjects of the review, not as a read whitelist. Read or search within contextReadScope only as needed to verify the targets. Do not read excludedPaths. Do not write outside writeScope.',
    ]),
  ].join('\n')
  if (input.task !== undefined) return { task: `${input.task}\n\n${declaration}` }
  return { content: [...(input.content ?? []), { type: 'text', text: declaration }] }
}

function validateBase64(data: string): number {
  if (data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new Error('image data must be canonical RFC 4648 base64 without a data URL prefix')
  }
  const buffer = Buffer.from(data, 'base64')
  if (buffer.toString('base64') !== data) throw new Error('image data must be canonical RFC 4648 base64')
  return buffer.byteLength
}
