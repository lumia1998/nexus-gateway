import readline from 'node:readline'

let model = 'remote-default'
let mode = 'default'
let effort = 'low'
let cwd = ''
let pending
let clientCapabilities
let promptCount = 0
let fileRequest
const sessionId = 'native-mcp-session'
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
const result = (id, value) => send({ id, result: value })
const options = () => [
    { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: model, options: ['remote-default', 'explicit-model'].map(value => ({ value, name: value })) },
    { id: 'thinking', name: 'Thinking', type: 'select', category: 'thought_level', currentValue: effort, options: ['low', 'high'].map(value => ({ value, name: value })) }
]
const finish = request => {
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text',
        text: JSON.stringify({ message: request.params.prompt[0].text, model, mode, effort, promptCount }) } } } })
    result(request.id, { stopReason: 'end_turn' })
}
if (process.argv.includes('--version')) { console.log('MCP fixture 1.0.0'); process.exit(0) }
readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line)
    if (request.id === 'permission' && request.result) { finish(pending); pending = undefined; return }
    if (request.id === 'file-write') {
        if (request.error) { result(fileRequest.id, { stopReason: 'refusal' }); return }
        send({ id: 'file-read', method: 'fs/read_text_file', params: { sessionId, path: cwd + '/gemini-test.txt' } })
        return
    }
    if (request.id === 'file-read') {
        send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: request.result?.content || 'read failed' } } } })
        result(fileRequest.id, { stopReason: 'end_turn' }); return
    }
    switch (request.method) {
        case 'initialize':
            clientCapabilities = request.params.clientCapabilities
            result(request.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} }, loadSession: true } }); break
        case 'session/new':
        case 'session/resume':
            cwd = request.params.cwd
            result(request.id, { sessionId, configOptions: options(), modes: { currentModeId: mode, availableModes: ['default', 'plan', 'yolo'].map(id => ({ id, name: id })) } }); break
        case 'session/set_config_option':
            if (request.params.configId === 'model') model = request.params.value
            else effort = request.params.value
            result(request.id, { configOptions: options() }); break
        case 'session/set_mode': mode = request.params.modeId; result(request.id, {}); break
        case 'session/prompt':
            promptCount++
            if (request.params.prompt[0].text === 'hang') return
            if (request.params.prompt[0].text === 'permission') {
                pending = request
                send({ id: 'permission', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'inspect', title: 'Inspect project', status: 'pending' },
                    options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } })
            } else if (request.params.prompt[0].text === 'gemini-file') {
                if (!clientCapabilities?.fs?.writeTextFile) { result(request.id, { stopReason: 'refusal' }); return }
                fileRequest = request
                send({ id: 'file-write', method: 'fs/write_text_file', params: { sessionId, path: cwd + '/gemini-test.txt', content: 'gemini filesystem works' } })
            } else finish(request)
            break
        case 'session/cancel': process.exit(0)
    }
})
