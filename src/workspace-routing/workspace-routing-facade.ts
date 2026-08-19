import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type {
  WorkspaceHostClient,
  WorkspaceCatalog,
  WorkspacePolicy,
  WorkspaceResolution,
  WorkspaceSummary,
  WorkspaceView,
} from './types.js'

export class WorkspaceRoutingFacade {
  constructor(
    private readonly client: WorkspaceHostClient,
    private readonly configuredRoots: string[],
  ) {}

  async listRegistered(): Promise<WorkspaceCatalog> {
    const listed = await this.client.listWorkspaces()
    return {
      items: listed.items.map(workspace => ({
        ...workspace,
        sessionIds: [...workspace.sessionIds],
      })),
      archivedSessionIds: [...(listed.archivedSessionIds ?? [])],
    }
  }

  async describePolicy(): Promise<WorkspacePolicy> {
    const catalog = await this.listRegistered()
    return {
      mode: this.configuredRoots.length > 0 ? 'configured-roots' : 'harness-registry',
      roots: [...this.configuredRoots],
      registered: catalog.items.map(toSummary),
      archivedSessionIds: catalog.archivedSessionIds,
    }
  }

  async resolve(input: string): Promise<WorkspaceResolution> {
    const path = await canonicalDirectory(input)
    if (this.configuredRoots.length === 0) {
      const registered = (await this.listRegistered()).items
      const workspace = registered.find(item => samePath(item.path, path))
      if (workspace === undefined) {
        throw new Error('workspace is not registered in Harness; add it in Harness or configure DSH_RELAY_ALLOWED_WORKSPACE_ROOTS')
      }
      return { path: workspace.path, workspace }
    }

    const roots = await Promise.all(this.configuredRoots.map(root => canonicalDirectory(root)))
    if (!roots.some(root => contains(root, path))) {
      throw new Error('workspace is outside DSH_RELAY_ALLOWED_WORKSPACE_ROOTS')
    }
    const registered = (await this.listRegistered()).items
    const workspace = registered.find(item => samePath(item.path, path)) ?? null
    return { path: workspace?.path ?? path, workspace }
  }

  async findById(workspaceId: string): Promise<WorkspaceView> {
    const workspace = (await this.listRegistered()).items.find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) throw new Error(`Harness workspace is no longer registered: ${workspaceId}`)
    return workspace
  }
}

async function canonicalDirectory(input: string): Promise<string> {
  if (!isAbsolute(input)) throw new Error('workspace must be an absolute path')
  const resolved = await realpath(input)
  if (!(await stat(resolved)).isDirectory()) throw new Error('workspace must be a directory')
  return resolved
}

function contains(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight
}

function toSummary(workspace: WorkspaceView): WorkspaceSummary {
  return {
    workspaceId: workspace.workspaceId,
    path: workspace.path,
    title: workspace.title,
    sessionCount: workspace.sessionIds.length,
  }
}
