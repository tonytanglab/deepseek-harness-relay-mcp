import { spawn } from 'node:child_process'

export function sessionUrl(base: string, sessionId: string): string {
  const url = new URL('/', base)
  url.searchParams.set('sessionId', sessionId)
  return url.href
}

export async function openUrl(input: string): Promise<void> {
  const url = new URL(input)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new Error('browser opener accepts loopback HTTP URLs only')
  const executable = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const child = spawn(executable, [url.href], { stdio: 'ignore', windowsHide: true })
    child.once('error', rejectOpen)
    child.once('spawn', () => {
      child.unref()
      resolveOpen()
    })
  })
}
