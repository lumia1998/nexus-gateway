import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { A2AClientRuntime } from '../src/a2a/runtime.js'
import { AcpProcessRuntime } from '../src/acp/runtime.js'

test('injects Agent Nexus interaction guidance into the first ACP prompt only', async () => {
    const sink = createSink()
    const runtime = new AcpProcessRuntime(
        driver(),
        sink as any,
        16 * 1024,
        1000,
        'Use Chinese for user-facing confirmations.'
    )
    const prompts: any[] = []
    ;(runtime as any).connection = {
        agent: {
            async request(_method: unknown, params: any) {
                if (params?.prompt) prompts.push(params.prompt)
                return { stopReason: 'end_turn' }
            }
        }
    }

    await runtime.prompt('帮我下单')
    await runtime.prompt('堂食')

    assert.equal(prompts.length, 2)
    assert.match(prompts[0][0].text, /agent-nexus-host-instructions/)
    assert.match(prompts[0][0].text, /elicitation|permission request/)
    assert.match(prompts[0][0].text, /Use Chinese for user-facing confirmations\./)
    assert.match(prompts[0][0].text, /<user-request>\n帮我下单/)
    assert.equal(prompts[1][0].text, '堂食')
})

test('injects Agent Nexus interaction guidance into the first A2A message only', async () => {
    const sink = createSink()
    const runtime = new A2AClientRuntime(
        {
            protocol: 'a2a',
            agentCardUrl: 'http://127.0.0.1:8787/.well-known/agent-card.json',
            instructions: 'Ask for confirmation before irreversible actions.'
        },
        sink as any,
        1000
    )
    const requests: any[] = []
    ;(runtime as any).card = { defaultOutputModes: ['text/plain'] }
    ;(runtime as any).client = {
        async *sendMessageStream(request: any) {
            requests.push(request)
        }
    }

    await runtime.prompt('帮我下单')
    await runtime.prompt('支付完成')

    assert.equal(requests.length, 2)
    const firstText = requests[0].message.parts[0].content.value
    assert.match(firstText, /agent-nexus-host-instructions/)
    assert.match(firstText, /Ask for confirmation before irreversible actions\./)
    assert.match(firstText, /<user-request>\n帮我下单/)
    assert.equal(requests[1].message.parts[0].content.value, '支付完成')
})

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

    await runtime.respondPending('1')
    assert.deepEqual(await response, {
        outcome: { outcome: 'selected', optionId: 'allow' }
    })
    assert.equal(sink.state, 'running')
    assert.equal(sink.pendingRequest, undefined)
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
    assert.deepEqual(blocks, [
        { type: 'text', text: '看这张图' },
        { type: 'image', data: Buffer.from([0, 255, 1]).toString('base64'), mimeType: 'image/png' }
    ])
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
        states: [] as string[],
        events: [] as Array<{ type: string; data: any }>,
        artifacts: [] as any[],
        setAcpSessionId(id: string) {
            this.acpSessionId = id
        },
        setState(state: string) {
            this.state = state
            this.states.push(state)
        },
        appendOutput() {},
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
