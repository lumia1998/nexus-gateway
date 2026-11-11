import { permissionPolicies, type AgentSessionOptions } from './types.js'

export function parseSessionOptions(input: unknown): AgentSessionOptions {
    if (input === undefined) return {}
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('options must be an object')
    const source = input as Record<string, unknown>
    const result: AgentSessionOptions = {}
    for (const key of Object.keys(source)) {
        if (!['model', 'effort', 'mode', 'permissionPolicy', 'configOptions'].includes(key)) throw new Error(`Unsupported session option: ${key}`)
    }
    for (const key of ['model', 'effort', 'mode'] as const) {
        if (source[key] === undefined) continue
        if (typeof source[key] !== 'string' || !source[key].trim() || source[key].length > 256) throw new Error(`Invalid ${key}`)
        result[key] = source[key].trim()
    }
    if (source.permissionPolicy !== undefined) {
        if (!(permissionPolicies as readonly unknown[]).includes(source.permissionPolicy)) throw new Error('Invalid permissionPolicy')
        result.permissionPolicy = source.permissionPolicy as AgentSessionOptions['permissionPolicy']
    }
    if (source.configOptions !== undefined) {
        const values = source.configOptions
        if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 32) throw new Error('Invalid configOptions')
        result.configOptions = Object.create(null)
        for (const [key, value] of Object.entries(values)) {
            if (['__proto__', 'constructor', 'prototype'].includes(key) || key.length > 128 ||
                (typeof value !== 'string' && typeof value !== 'boolean') || (typeof value === 'string' && value.length > 256)) throw new Error('Invalid config option')
            result.configOptions![key] = value
        }
    }
    return result
}
