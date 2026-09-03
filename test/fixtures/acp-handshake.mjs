import readline from 'node:readline'

const mode = process.argv[2]
readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line)
    if (request.method === 'initialize' && mode !== 'hang-initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
            result: { protocolVersion: request.params.protocolVersion, agentCapabilities: {} } }) + '\n')
    }
    if (request.method === 'session/new' && mode === 'ready') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'test-session' } }) + '\n')
    }
})
