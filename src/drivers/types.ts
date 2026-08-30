import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentdAgentView, PermissionPolicy } from '../types.js'

export interface AgentDriver {
    id: string
    name: string
    description?: string
    command: string
    args: string[]
    env: NodeJS.ProcessEnv
    permissionPolicy: PermissionPolicy
    permissionTimeoutMs: number
    /** The spawned Agent owns a dedicated process group that can be terminated as a tree. */
    ownsProcessGroup?: boolean

    probe(): Promise<AgentdAgentView>
    spawn(workspace: string): ChildProcessWithoutNullStreams
}
