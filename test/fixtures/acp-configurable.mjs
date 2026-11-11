import readline from 'node:readline'

let model = 'test/model-a'
let effort = 'low'
let mode = 'default'
let sessionId = 'native-session'
let pending
const configOptions = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
    options: [{ group: 'test', name: 'Test', options: ['test/model-a', 'test/model-b'].map(value => ({ value, name: value })) }] },
  { id: 'thinking', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: effort,
    options: (model === 'test/model-b' ? ['low', 'max'] : ['low', 'high']).map(value => ({ value, name: value })) }
]
const modes = () => ({ currentModeId: mode, availableModes: [{ id: 'default', name: 'Default' }, { id: 'yolo', name: 'Unattended' }] })
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n')
const result = (id, value) => send({ id, result: value })
const finish = id => {
  send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${model} ${effort} ${mode}` } } } })
  result(id, { stopReason: 'end_turn' })
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.id === 'permission' && request.result) { finish(pending); pending = undefined; return }
  switch (request.method) {
    case 'initialize': result(request.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} }, loadSession: true } }); break
    case 'session/new': result(request.id, { sessionId, configOptions: configOptions(), modes: modes() }); break
    case 'session/resume':
    case 'session/load':
      sessionId = request.params.sessionId
      if (sessionId === 'missing') send({ id: request.id, error: { code: -32602, message: 'Missing session' } })
      else result(request.id, { configOptions: configOptions(), modes: modes() })
      break
    case 'session/set_config_option':
      if (request.params.configId === 'model') { model = request.params.value; effort = 'low' }
      else effort = request.params.value
      result(request.id, { configOptions: configOptions() }); break
    case 'session/set_mode': mode = request.params.modeId; result(request.id, {}); break
    case 'session/prompt': {
      const prompt = request.params.prompt[0].text
      if (prompt === 'hang') return
      if (prompt.startsWith('permission')) {
        pending = request.id
        send({ id: 'permission', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'write', title: 'Write file', status: 'pending' },
          options: [{ optionId: 'always', name: 'Always', kind: 'allow_always' }] } })
      } else finish(request.id)
      break
    }
    case 'session/cancel': process.exit(0)
  }
})
