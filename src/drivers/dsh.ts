import type { AgentdDriverConfig } from '../types.js'
import { createStdioAcpDriver } from './stdio.js'

export function createDshDriver(id: string, config: AgentdDriverConfig) {
    return createStdioAcpDriver(id, config, {
        name: 'DeepSeek Harness',
        description: 'DeepSeek Harness through its native ACP stdio profile',
        command: 'dsh',
        args: ['--profile', 'acp'],
        probeArgs: ['--version']
    })
}
