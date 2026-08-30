import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { AcpProcessRuntime } from '../src/acp/runtime.js'
import { terminateProcessTree } from '../src/process-tree.js'

test('permission requests remain pending after invalid input and accept an option', async () => {
    const sink = createSink()
    const runtime = new AcpProcessRuntime(driver(), sink as any)
    const response = (runtime as any).requestPermission({
        toolCall: {
            toolCallId: 'tool-1',
            title: 'Write package.json'
        },
        options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'deny', name: 'Reject', kind: 'reject_once' }
        ]
    })
    assert.equal(sink.state, 'permission_required')
    assert.equal(sink.pendingRequest?.options?.[0].id, 'allow')
    await assert.rejects(() => runtime.respondPending('not-an-option'), /option id\/name/)
    assert.equal(sink.state, 'permission_required')
    assert.equal(sink.pendingRequest?.id, (runtime as any).pending.request.id)

    await assert.rejects(
        () =>
            runtime.respondPending({
                requestId: 'stale-request',
                optionId: 'allow'
            }),
        /no longer matches/
    )
    assert.equal(sink.state, 'permission_required')

    await runtime.respondPending({
        requestId: sink.pendingRequest.id,
        optionId: 'allow'
    })
    assert.deepEqual(await response, {
        outcome: { outcome: 'selected', optionId: 'allow' }
    })
    assert.equal(sink.state, 'running')
    assert.equal(sink.pendingRequest, undefined)

    const acceptSink = createSink()
    const acceptRuntime = new AcpProcessRuntime(driver(), acceptSink as any)
    const accepted = (acceptRuntime as any).requestPermission({
        toolCall: { toolCallId: 'tool-2', title: 'Run tests' },
        options: [
            { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' }
        ]
    })
    await acceptRuntime.respondPending({
        requestId: acceptSink.pendingRequest.id,
        action: 'accept'
    })
    assert.deepEqual(await accepted, {
        outcome: { outcome: 'selected', optionId: 'allow' }
    })
})

test('a canceled prompt cannot overwrite the terminal canceled state', async () => {
    const sink = createSink()
    const runtime = new AcpProcessRuntime(driver(), sink as any)
    let finish!: (value: unknown) => void
    ;(runtime as any).connection = {
        agent: {
            request: () => new Promise((resolve) => {
                finish = resolve
            })
        }
    }
    const prompt = runtime.prompt('Work')
    await Promise.resolve()
    sink.setState('canceled')
    finish({ stopReason: 'end_turn' })
    await prompt
    assert.equal(sink.state, 'canceled')
    assert.equal(sink.states.includes('completed'), false)
})

test('only ACP end_turn creates a verified completion proof', async () => {
    const sink = createSink()
    const runtime = new AcpProcessRuntime(driver(), sink as any)
    ;(runtime as any).connection = {
        agent: {
            async request() {
                sink.appendOutput('Work completed.')
                return { stopReason: 'end_turn' }
            }
        }
    }

    await runtime.prompt('Work')
    assert.equal(sink.state, 'completed')
    assert.deepEqual(sink.completion, {
        source: 'acp_prompt_response',
        stopReason: 'end_turn'
    })
})

test('ACP token and turn limits are incomplete rather than successful', async () => {
    for (const stopReason of ['max_tokens', 'max_turn_requests']) {
        const sink = createSink()
        const runtime = new AcpProcessRuntime(driver(), sink as any)
        ;(runtime as any).connection = {
            agent: {
                async request() {
                    sink.appendOutput('Partial output')
                    return { stopReason }
                }
            }
        }

        await runtime.prompt('Work')
        assert.equal(sink.state, 'failed')
        assert.match(sink.error || '', new RegExp(stopReason))
        assert.equal(sink.completion, undefined)
    }
})

test('cancel remains terminal when the ACP notification fails', async () => {
    const sink = createSink()
    sink.state = 'running'
    const runtime = new AcpProcessRuntime(driver(), sink as any)
    let closed = false
    ;(runtime as any).connection = {
        agent: {
            async notify() {
                throw new Error('connection closed')
            }
        },
        close() {
            closed = true
        }
    }
    await runtime.cancel()
    assert.equal(sink.state, 'canceled')
    assert.equal(closed, true)
    assert.match(String(sink.events[0]?.data?.text), /connection closed/)
})

test('Agent process disposal is bounded and reaches a terminal child process', async () => {
    const child = spawn(
        process.execPath,
        ['-e', 'setInterval(() => undefined, 1000)'],
        {
            detached: process.platform !== 'win32',
            stdio: 'ignore'
        }
    )
    assert.ok(child.pid)

    await terminateProcessTree(child, {
        ownsProcessGroup: process.platform !== 'win32',
        graceMs: 100
    })

    assert.equal(child.exitCode !== null || child.signalCode !== null, true)
})

test('a timed out permission request remains failed after the prompt returns', async () => {
    const sink = createSink()
    const runtime = new AcpProcessRuntime(
        { ...driver(), permissionTimeoutMs: 5 },
        sink as any
    )
    ;(runtime as any).connection = {
        agent: {
            async request() {
                await (runtime as any).requestPermission({
                    toolCall: {
                        toolCallId: 'tool-timeout',
                        title: 'Write package.json'
                    },
                    options: [
                        {
                            optionId: 'deny',
                            name: 'Reject',
                            kind: 'reject_once'
                        }
                    ]
                })
                return { stopReason: 'end_turn' }
            }
        }
    }

    await runtime.prompt('Work')
    assert.equal(sink.state, 'failed')
    assert.equal(sink.states.includes('completed'), false)
})

test('chunks and flushes stderr that does not contain newlines', async () => {
    const sink = createSink()
    const runtime = new AcpProcessRuntime(driver(), sink as any, 8)
    const stderr = new PassThrough()
    ;(runtime as any).captureStderr({ stderr })
    const ended = new Promise<void>((resolve) => stderr.once('end', resolve))
    const output = 'abcdefghijklmnopqrstuvwxyz'

    stderr.end(output)
    await ended

    const chunks = sink.events
        .filter((event) => event.type === 'terminal_output')
        .map((event) => String(event.data?.text || ''))
    assert.ok(chunks.length > 1)
    assert.ok(chunks.every((chunk) => chunk.length <= 8))
    assert.equal(chunks.join(''), output)
})

test('captures image content from ACP tool updates as an artifact', () => {
    const sink = createSink()
    const runtime = new AcpProcessRuntime(driver(), sink as any)

    ;(runtime as any).sessionUpdate({
        update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-image',
            title: 'Read /tmp/opencode-image.png',
            content: [
                {
                    type: 'content',
                    content: {
                        type: 'image',
                        mimeType: 'image/png',
                        data: 'aGVsbG8='
                    }
                }
            ]
        }
    })

    assert.deepEqual(sink.artifacts, [
        {
            id: 'tool:tool-image:0',
            name: 'opencode-image.png',
            filename: 'opencode-image.png',
            mediaType: 'image/png',
            bytesBase64: 'aGVsbG8=',
            url: undefined,
            metadata: { sourceId: 'tool:tool-image:0' }
        }
    ])
})

test('maps supported ACP image input to an inline prompt block', async () => {
    const sink = createSink()
    const runtime = new AcpProcessRuntime(driver(), sink as any)
    ;(runtime as any).promptCapabilities = { image: true }
    const blocks = await (runtime as any).promptBlocks('看这张图', [
        {
            id: 'input-1',
            name: '截图.png',
            mediaType: 'image/png',
            bytes: Buffer.from([0, 255, 1])
        }
    ])
    assert.deepEqual(blocks[0], { type: 'text', text: '看这张图' })
    assert.match(String((blocks[1] as any).text), /agent_nexus_completion_contract/)
    assert.deepEqual(blocks[2], {
        type: 'image',
        data: Buffer.from([0, 255, 1]).toString('base64'),
        mimeType: 'image/png'
    })
})

function driver() {
    return {
        id: 'opencode',
        name: 'OpenCode',
        command: 'opencode',
        args: ['acp'],
        env: {},
        permissionPolicy: 'ask' as const,
        permissionTimeoutMs: 1000,
        async probe() {
            throw new Error('not used')
        },
        spawn() {
            throw new Error('not used')
        }
    }
}

function createSink() {
    return {
        state: 'created' as string,
        acpSessionId: 'acp-1',
        pendingRequest: undefined as any,
        completion: undefined as any,
        output: '',
        error: undefined as string | undefined,
        states: [] as string[],
        events: [] as Array<{ type: string; data: any }>,
        artifacts: [] as any[],
        setAcpSessionId(id: string) {
            this.acpSessionId = id
        },
        setState(state: string, error?: string) {
            this.state = state
            this.error = error
            this.states.push(state)
        },
        completeTurn(proof: any) {
            this.completion = structuredClone(proof)
            this.setState('completed')
            return true
        },
        appendOutput(text: string) {
            this.output += text
        },
        addArtifact(artifact: any) {
            this.artifacts.push(structuredClone(artifact))
        },
        setPending(request: any) {
            this.pendingRequest = structuredClone(request)
            this.setState(request.kind === 'permission' ? 'permission_required' : 'input_required')
        },
        clearPending() {
            this.pendingRequest = undefined
        },
        emit(type: string, data?: unknown) {
            this.events.push({ type, data })
        }
    }
}
