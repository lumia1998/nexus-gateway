import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { Role, TaskState } from '@a2a-js/sdk'
import { A2AClientRuntime, probeA2AAgent } from '../src/a2a/runtime.js'

test('A2A readiness discovers a v1 Agent Card through authenticated fetch', async () => {
    let base = ''
    let authorization = ''
    let requestedPath = ''
    const server = http.createServer((request, response) => {
        authorization = String(request.headers.authorization || '')
        requestedPath = request.url || ''
        if (authorization !== 'Bearer remote-secret') {
            response.writeHead(401).end('unauthorized')
            return
        }
        response.setHeader('Content-Type', 'application/json')
        response.end(
            JSON.stringify({
                name: 'Remote Research',
                description: 'A real A2A test agent',
                supportedInterfaces: [
                    {
                        url: base,
                        protocolBinding: 'JSONRPC',
                        tenant: '',
                        protocolVersion: '1.0'
                    }
                ],
                provider: { organization: 'Test', url: base },
                version: '1.2.3',
                capabilities: {
                    streaming: false,
                    pushNotifications: false,
                    extensions: []
                },
                securitySchemes: {},
                securityRequirements: [],
                defaultInputModes: ['text/plain'],
                defaultOutputModes: ['text/plain'],
                skills: [],
                signatures: []
            })
        )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
        const result = await probeA2AAgent('research', {
            protocol: 'a2a',
            agentUrl: base,
            auth: { type: 'bearer', value: 'remote-secret' },
            timeoutMs: 5_000
        })
        assert.equal(authorization, 'Bearer remote-secret')
        assert.equal(result.ready, true)
        assert.equal(result.name, 'Remote Research')
        assert.equal(result.version, '1.2.3')
        assert.equal(result.protocol, 'a2a')
        assert.equal(requestedPath, '/.well-known/agent-card.json')

        const directCard = await probeA2AAgent('research', {
            protocol: 'a2a',
            agentCardUrl: `${base}/custom/cards/research.json`,
            preferredTransport: 'jsonrpc',
            auth: { type: 'bearer', value: 'remote-secret' },
            timeoutMs: 5_000
        })
        assert.equal(directCard.ready, true)
        assert.equal(requestedPath, '/custom/cards/research.json')

        const rejected = await probeA2AAgent('research', {
            protocol: 'a2a',
            agentUrl: base,
            auth: { type: 'bearer', value: 'wrong-secret' },
            timeoutMs: 5_000
        })
        assert.equal(rejected.ready, false)
        assert.match(rejected.error || '', /401|fetch agent card/i)
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
        )
    }
})

test('A2A requests carry input files as raw Parts with filename and media type', () => {
    const runtime = new A2AClientRuntime(
        {
            protocol: 'a2a',
            agentCardUrl: 'http://127.0.0.1:8787/.well-known/agent-card.json',
            timeoutMs: 60_000
        },
        { id: 'session-1' } as any,
        30 * 60 * 1000
    )
    const request = (runtime as any).messageRequest('请分析附件', [
        {
            id: 'input-1',
            name: '需求.pdf',
            mediaType: 'application/pdf',
            bytes: Buffer.from([0, 255, 1])
        }
    ])
    assert.equal(request.message.parts[0].content.$case, 'text')
    assert.match(
        request.message.parts[1].content.value,
        /agent_nexus_completion_contract/
    )
    assert.equal(request.message.parts[2].content.$case, 'raw')
    assert.deepEqual(
        [...request.message.parts[2].content.value],
        [0, 255, 1]
    )
    assert.equal(request.message.parts[2].filename, '需求.pdf')
    assert.equal(request.message.parts[2].mediaType, 'application/pdf')
})

test('A2A message-only streams finish with proof, but task streams require a terminal status', async () => {
    const messageSink = createSink()
    const messageRuntime = runtimeWithResponses(messageSink, [
        {
            payload: {
                $case: 'message',
                value: {
                    messageId: 'message-1',
                    role: Role.ROLE_AGENT,
                    parts: [textPart('Finished and verified.')]
                }
            }
        }
    ])
    await messageRuntime.prompt('Work')
    assert.equal(messageSink.state, 'completed')
    assert.equal(messageSink.completion?.source, 'a2a_message_stream')

    const taskSink = createSink()
    const taskRuntime = runtimeWithResponses(taskSink, [
        {
            payload: {
                $case: 'statusUpdate',
                value: {
                    taskId: 'task-1',
                    contextId: 'context-1',
                    status: { state: TaskState.TASK_STATE_WORKING }
                }
            }
        }
    ])
    await taskRuntime.prompt('Work')
    assert.equal(taskSink.state, 'failed')
    assert.match(taskSink.error || '', /without a terminal task status/)
    assert.equal(taskSink.completion, undefined)
})

function runtimeWithResponses(sink: ReturnType<typeof createSink>, responses: any[]) {
    const runtime = new A2AClientRuntime(
        {
            protocol: 'a2a',
            agentCardUrl: 'http://127.0.0.1/agent-card.json',
            timeoutMs: 60_000
        },
        sink as any,
        60_000
    )
    ;(runtime as any).card = { defaultOutputModes: ['text/plain'] }
    ;(runtime as any).client = {
        async *sendMessageStream() {
            for (const response of responses) yield response
        }
    }
    return runtime
}

function createSink() {
    return {
        id: 'session-1',
        state: 'created',
        protocolSessionId: undefined as string | undefined,
        output: '',
        artifacts: [] as any[],
        completion: undefined as any,
        error: undefined as string | undefined,
        setProtocolSessionId(id: string) {
            this.protocolSessionId = id
        },
        setState(state: string, error?: string) {
            this.state = state
            this.error = error
            if (state !== 'completed') this.completion = undefined
        },
        completeTurn(proof: any) {
            if (!this.output.trim() && this.artifacts.length < 1) {
                this.setState('failed', 'missing result')
                return false
            }
            this.completion = structuredClone(proof)
            this.state = 'completed'
            return true
        },
        appendOutput(text: string) {
            this.output += text
        },
        addArtifact(artifact: any) {
            this.artifacts.push(structuredClone(artifact))
        },
        setPending(request: any) {
            this.state = request.kind === 'permission'
                ? 'permission_required'
                : 'input_required'
        },
        clearPending() {},
        emit() {}
    }
}

function textPart(value: string) {
    return {
        content: { $case: 'text', value },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain'
    }
}
