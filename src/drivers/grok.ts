import type { AgentdDriverConfig } from '../types.js'
import { createStdioAcpDriver } from './stdio.js'

export function createGrokDriver(id: string, config: AgentdDriverConfig) {
    return createStdioAcpDriver(id, config, {
        name: 'Grok Build',
        description: 'Grok Build through its native ACP stdio agent',
        command: 'grok',
        // The xAI CLI documents `--no-auto-update` for `grok agent stdio` in
        // scripts and CI, which is exactly how this gateway launches it.
        args: ['--no-auto-update', 'agent', 'stdio'],
        probeArgs: ['version']
    })
}
