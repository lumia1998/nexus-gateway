import type { AgentdDriverConfig } from '../types.js'
import { createStdioAcpDriver, type StdioAcpDriverDefaults } from './stdio.js'

/** Launch presets only. Product-specific session behaviour lives in acp/selection. */
const presets: Record<string, StdioAcpDriverDefaults> = {
    kimi: { name: 'Kimi Code', description: 'Kimi Code native ACP', command: 'kimi', args: ['acp'] },
    gemini: { name: 'Gemini CLI', description: 'Gemini CLI native ACP (gemini --acp)', command: 'gemini', args: ['--acp'] },
    cursor: { name: 'Cursor Agent', description: 'Cursor Agent native ACP', command: 'cursor-agent', args: ['acp'] },
    devin: { name: 'Devin CLI', description: 'Devin CLI native ACP', command: 'devin', args: ['acp'] },
    zcode: { name: 'ZCode', description: 'ZCode through zcode-acp-server', command: 'zcode-acp-server', args: [] },
    minimax: { name: 'MiniMax Code', description: 'MiniMax Code native ACP', command: 'mcode', args: ['acp'] },
    antigravity: { name: 'Antigravity', description: 'Antigravity CLI stream-json', command: 'agy', args: [] },
    'codex-cli': { name: 'Codex CLI', description: 'Codex exec JSONL without an ACP adapter', command: 'codex', args: [] }
}

export function createCatalogDriver(id: string, config: AgentdDriverConfig) {
    const defaults = presets[config.driver]
    if (!defaults) throw new Error(`Unsupported driver: ${config.driver}`)
    const driver = createStdioAcpDriver(id, config, defaults)
    // Devin Desktop's host marker prevents standalone CLI authentication.
    if (config.driver === 'devin') delete driver.env.ACP_BACKEND
    return driver
}
