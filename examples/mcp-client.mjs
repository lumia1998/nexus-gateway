import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const endpoint = process.env.NEXUS_MCP_URL
const token = process.env.NEXUS_API_KEY
if (!endpoint || !token) throw new Error('Set NEXUS_MCP_URL and NEXUS_API_KEY')
const client = new Client({ name: 'nexus-example', version: '1.0.0' })
const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    if (result.isError) throw new Error(result.content[0].text)
    return result.structuredContent || JSON.parse(result.content[0].text)
}
try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    console.log(await call('list_agents'))
    const [agentId, message] = process.argv.slice(2)
    if (agentId && message) {
        // Persist this ID if your client needs to retry after a lost HTTP response.
        const requestId = randomUUID()
        console.log('request_id:', requestId)
        const receipt = await call('dispatch_task', { agent_id: agentId, message, request_id: requestId })
        console.log(receipt)
        while (true) {
            const task = await call('get_task', { task_id: receipt.task_id, wait_seconds: 30 })
            console.log(task)
            if (task.pending_request || ['completed', 'failed', 'canceled'].includes(task.state)) break
        }
    }
} finally { await client.close() }
