import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AgentDriver } from './drivers/types.js'
import type { AgentSessionRuntime, AgentSessionSink } from './session-contract.js'
import type { AgentRuntimeView, AgentSessionOptions, AgentdInputAttachment } from './types.js'
import { parseSessionOptions } from './runtime-options.js'
import { terminateProcessTree } from './process-tree.js'
import { TURN_COMPLETION_CONTRACT } from './completion-contract.js'

/** Native JSONL backends: one process per turn, native IDs preserve conversation. */
export class CliProcessRuntime implements AgentSessionRuntime {
    private child?: ChildProcessWithoutNullStreams
    private workspace = ''
    private disposed = false
    private options: AgentSessionOptions
    private lastActivityAt = Date.now()
    constructor(private driver: AgentDriver, private sink: AgentSessionSink, private taskTimeoutMs: number, options: AgentSessionOptions = {}) {
        const config: AgentSessionOptions = driver.config || {}
        this.options = { model: config.model, effort: config.effort, mode: config.mode, permissionPolicy: driver.permissionPolicy, ...options }
    }

    async start(workspace = '') {
        if (this.disposed) throw new Error('CLI runtime is disposed')
        this.workspace = workspace
        this.validate(this.options)
        this.sink.setState('created')
    }

    private validate(options: AgentSessionOptions) {
        // These print interfaces cannot forward interactive approvals. Never silently bypass ask/deny.
        if (options.permissionPolicy !== 'bypass') throw new Error('Native CLI execution requires permissionPolicy=bypass; use the ACP driver for remote permission decisions')
        if (options.mode && options.mode !== 'default') throw new Error('Native CLI does not support session mode selection')
        if (Object.keys(options.configOptions || {}).length) throw new Error('Native CLI does not support ACP configOptions')
        if (options.effort && !['off', 'low', 'medium', 'high', 'max', 'xhigh'].includes(options.effort)) throw new Error('Unsupported CLI effort')
    }

    async configure(input: AgentSessionOptions) {
        if (this.child) throw new Error('Cannot configure an active turn')
        const next = { ...this.options, ...parseSessionOptions(input) }
        this.validate(next)
        this.options = next
        this.sink.emit('session_options', this.view())
    }

    view(): AgentRuntimeView {
        return { driver: this.driver.kind, status: this.disposed ? 'stopped' : this.child ? 'ready' : 'suspended', resumable: Boolean(this.sink.protocolSessionId), options: structuredClone(this.options), lastActivityAt: this.lastActivityAt }
    }
    isAvailable() { return !this.disposed }

    private argv() {
        const { model, effort } = this.options
        const native = this.sink.protocolSessionId
        if (this.driver.kind === 'codex-cli') {
            const args = [...this.driver.args, 'exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']
            if (model) args.push('-m', model)
            if (effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort === 'off' ? 'none' : effort === 'max' ? 'xhigh' : effort)}`)
            if (native) args.push('resume', native)
            args.push('-')
            return args
        }
        const args = [...this.driver.args]
        if (model) args.push('--model', model)
        if (effort) args.push('--effort', effort === 'off' ? 'low' : effort === 'xhigh' ? 'max' : effort)
        args.push('--add-dir', this.workspace)
        args.push(...(native ? ['--conversation', native] : ['--new-project']))
        args.push('-p', '', '--input-format', 'stream-json', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--print-timeout', `${Math.ceil(this.taskTimeoutMs / 1000)}s`)
        return args
    }

    async prompt(message: string, attachments: AgentdInputAttachment[] = []) {
        if (this.disposed || this.child) throw new Error('CLI runtime is unavailable')
        if (attachments.length) throw new Error('Native CLI attachments are not supported; use an ACP driver')
        this.sink.setState('running')
        const child = this.driver.spawn(this.workspace, this.options, this.argv())
        this.child = child
        this.lastActivityAt = Date.now()
        const started = Date.now()
        let buffer = ''
        let completed = false
        let success = false
        let failed: string | undefined
        let finalText = ''
        let timer: NodeJS.Timeout | undefined
        try {
            await new Promise<void>((resolve, reject) => {
                child.stdout.setEncoding('utf8')
                child.stderr.setEncoding('utf8')
                const consume = (line: string) => {
                    if (!line.trim()) return
                    let event: any
                    try { event = JSON.parse(line) } catch { throw new Error('CLI returned invalid JSONL') }
                    this.lastActivityAt = Date.now()
                    if (this.driver.kind === 'codex-cli') {
                        if (event.type === 'thread.started' && typeof event.thread_id === 'string') this.sink.setProtocolSessionId(event.thread_id)
                        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
                            finalText = String(event.item.text || '')
                            this.sink.replaceOutput(finalText)
                            this.sink.emit('assistant_chunk', { content: { type: 'text', text: finalText } })
                        } else if (event.type?.startsWith('item.')) this.sink.emit('tool_update', event.item)
                        if (event.type === 'turn.completed') completed = true
                        if (event.type === 'turn.failed') failed = String(event.error?.message || 'CLI turn failed')
                        if (event.type === 'error') this.sink.emit('terminal_output', { stream: 'stderr', text: String(event.message || event.error?.message || 'CLI error').slice(0, 4096) })
                    } else {
                        const payload = event.result && typeof event.result === 'object' ? event.result : event
                        const native = payload.conversationId || payload.conversation_id || event.conversation_id || event.conversationId || event.init?.conversation_id || event.init?.conversationId || event.step_update?.conversation_id
                        if (typeof native === 'string') this.sink.setProtocolSessionId(native)
                        const delta = event.step_update?.text_delta || event.text_delta || event.delta
                        if (typeof delta === 'string') {
                            this.sink.appendOutput(delta)
                            this.sink.emit('assistant_chunk', { content: { type: 'text', text: delta } })
                        } else if (event.step_update) this.sink.emit('tool_update', event.step_update)
                        if (event.event === 'result' || ['result', 'final', 'turn_complete', 'completed'].includes(event.type) ||
                            ['SUCCESS', 'ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING'].includes(event.status) && ('response' in event || 'error' in event)) {
                            completed = payload.status === 'SUCCESS' && !payload.error
                            if (!completed) failed = String(payload.error || payload.status || 'Missing CLI completion status')
                            const text = payload.response || payload.text || (typeof payload.result === 'string' ? payload.result : '')
                            if (typeof text === 'string' && text) { finalText = text; this.sink.replaceOutput(text) }
                        }
                    }
                }
                child.stdout.on('data', (chunk: string) => {
                    try {
                        buffer += chunk
                        if (buffer.length > 4 * 1024 * 1024) throw new Error('CLI JSONL frame exceeds 4 MiB')
                        let newline: number
                        while ((newline = buffer.indexOf('\n')) >= 0) {
                            const line = buffer.slice(0, newline)
                            buffer = buffer.slice(newline + 1)
                            consume(line)
                        }
                    } catch (error) { reject(error) }
                })
                child.stderr.on('data', (text: string) => this.sink.emit('terminal_output', { stream: 'stderr', text: text.slice(-16_384) }))
                child.stdin.on('error', reject)
                child.once('error', reject)
                child.once('close', code => {
                    try {
                        consume(buffer)
                        if (code !== 0) throw new Error(`CLI process exited with code ${code}`)
                        if (failed) throw new Error(failed)
                        if (!completed) throw new Error('CLI exited without a successful completion event')
                        resolve()
                    } catch (error) { reject(error) }
                })
                timer = setInterval(() => {
                    const stall = this.driver.config?.stallTimeoutMs ?? 600_000
                    if (Date.now() - started >= this.taskTimeoutMs) reject(new Error('CLI task deadline exceeded'))
                    else if (stall > 0 && Date.now() - this.lastActivityAt >= stall) reject(new Error('CLI stalled: no protocol progress'))
                }, 250)
                timer.unref?.()
                const prompt = `${message}\n\n${TURN_COMPLETION_CONTRACT}`
                child.stdin.end(this.driver.kind === 'codex-cli' ? prompt : JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } }) + '\n')
            })
            success = true
        } catch (error) {
            if (!this.disposed) this.sink.setState('failed', error instanceof Error ? error.message : String(error))
        } finally {
            if (timer) clearInterval(timer)
            await terminateProcessTree(child, { ownsProcessGroup: this.driver.ownsProcessGroup })
            if (this.child === child) this.child = undefined
        }
        if (success && !this.disposed) this.sink.completeTurn({ source: 'cli_result', stopReason: 'end_turn' })
    }
    async respondPending() { throw new Error('Native CLI does not expose interactive requests') }
    async cancel() { this.sink.setState('canceled'); await this.dispose() }
    async dispose() {
        this.disposed = true
        if (this.child) await terminateProcessTree(this.child, { ownsProcessGroup: this.driver.ownsProcessGroup })
    }
}
