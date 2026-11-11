import type * as acp from '@agentclientprotocol/sdk'

export function optionValues(option: acp.SessionConfigOption): Array<{ value: string; name: string }> {
    if (option.type !== 'select') return []
    const visit = (items: any[]): Array<{ value: string; name: string }> => items.flatMap(item =>
        typeof item.value === 'string' ? [{ value: item.value, name: item.name || item.value }] : Array.isArray(item.options) ? visit(item.options) : [])
    return visit(option.options)
}

export function selectionValue(kind: string, option: acp.SessionConfigOption, requested: string | boolean): string | boolean {
    if (option.type === 'boolean') {
        if (typeof requested === 'boolean') return requested
        if (['on', 'true', 'off', 'false'].includes(requested)) return requested === 'on' || requested === 'true'
        throw new Error(`Option ${option.id} requires a boolean`)
    }
    const offered = optionValues(option)
    if (offered.some(item => item.value === requested)) return requested
    let candidates = offered.filter(item => item.name === requested)
    if (kind === 'zcode') candidates = offered.filter(item => item.value.replace('\\', '/') === requested || item.value.split('\\').slice(1).join('\\') === requested)
    if (kind === 'minimax' && typeof requested === 'string') {
        candidates = offered.filter(item => {
            const parts = item.value.split(':')
            try {
                return parts[0] === 'm' && `${decodeURIComponent(parts[1])}/${decodeURIComponent(parts[2])}${parts[3] === 'v' ? '#' + decodeURIComponent(parts[4]) : ''}` === requested
            } catch { return false }
        })
    }
    if (candidates.length === 1) return candidates[0].value
    // Do not silently raise cost or downgrade thinking. The caller can select an offered value.
    if (requested === 'off' && offered.some(item => item.value === 'none')) return 'none'
    if (requested === 'max' && offered.some(item => item.value === 'xhigh')) return 'xhigh'
    throw new Error(`Unsupported ${option.id}: ${String(requested)}. Available: ${offered.map(item => item.value).join(', ')}`)
}

export function findOption(options: acp.SessionConfigOption[], category: 'model' | 'effort' | 'mode') {
    const ids = category === 'model' ? ['model'] : category === 'effort' ? ['thinking', 'thinkingEffort', 'thought', 'reasoning_effort', 'effort'] : ['mode']
    const candidates = category === 'mode' ? options.filter(option => !/permission/i.test(option.id)) : options
    return candidates.find(option => option.category === (category === 'effort' ? 'thought_level' : category)) || candidates.find(option => ids.includes(option.id))
}

export function unattendedMode(kind: string): string | undefined {
    return ({ kimi: 'yolo', gemini: 'yolo', claude: 'bypassPermissions', devin: 'bypass', zcode: 'yolo', dsh: 'danger-full-access' } as Record<string, string>)[kind]
}
