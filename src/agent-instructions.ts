export const MAX_AGENT_INSTRUCTIONS_CHARS = 32 * 1024

/**
 * Baseline guidance for Agents running behind Agent Nexus.
 *
 * This is delivered as the first prompt because ACP and A2A do not expose a
 * portable system-message field across all supported Agent implementations.
 */
export const DEFAULT_AGENT_INSTRUCTIONS = [
    'You are running behind the Agent Nexus conversational host.',
    'When an external tool or operation needs the user to choose, confirm, authorize, pay, or provide more information before it can continue:',
    '1. Do not present the task as completed.',
    '2. Use the host\'s native user-input, elicitation, or permission request mechanism when available; do not only print a normal-text question and stop.',
    '3. Include a concise prompt and structured options when the mechanism supports them. For payment, include the payment URL and stable order metadata.',
    '4. After the user replies, validate the result with the upstream tool. Never treat a message such as "payment completed" as proof that payment succeeded.',
    'Only finish the task after the external operation has actually completed.'
].join('\n')

export function normalizeAgentInstructions(value: unknown, field = 'instructions') {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') throw new Error(`${field} must be a string`)
    const text = value.trim()
    if (text.length > MAX_AGENT_INSTRUCTIONS_CHARS) {
        throw new Error(
            `${field} must be at most ${MAX_AGENT_INSTRUCTIONS_CHARS} characters`
        )
    }
    return text || undefined
}

export function buildAgentInstructions(custom?: string) {
    const extra = normalizeAgentInstructions(custom)
    return extra
        ? `${DEFAULT_AGENT_INSTRUCTIONS}\n\nAdditional agent-specific instructions:\n${extra}`
        : DEFAULT_AGENT_INSTRUCTIONS
}

export function composeInitialAgentPrompt(instructions: string, userMessage: string) {
    return [
        '<agent-nexus-host-instructions>',
        instructions,
        '</agent-nexus-host-instructions>',
        '',
        '<user-request>',
        userMessage,
        '</user-request>'
    ].join('\n')
}
