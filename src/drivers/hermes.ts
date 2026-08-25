import type { AgentdDriverConfig } from '../types.js'
import { createStdioAcpDriver } from './stdio.js'

export function createHermesDriver(id: string, config: AgentdDriverConfig) {
    return createStdioAcpDriver(id, config, {
        name: 'Hermes Agent',
        description: 'Hermes Agent through its native ACP stdio server',
        command: 'hermes',
        args: ['acp'],
        probeArgs: ['acp', '--check']
    })
}
