const mode = process.argv[2]
process.stdin.resume()
process.stdin.on('end', () => {
  const send = value => process.stdout.write(JSON.stringify(value) + '\n')
  if (mode === 'hang') { setInterval(() => {}, 1000); return }
  if (mode === 'agy') {
    send({ event: 'init', conversation_id: 'agy-session' })
    send({ event: 'result', status: 'SUCCESS', response: 'Native Antigravity result' })
  } else {
    send({ type: 'thread.started', thread_id: 'codex-thread' })
    send({ type: 'item.completed', item: { type: 'agent_message', text: 'Native Codex result' } })
    if (mode !== 'incomplete') send({ type: 'turn.completed' })
  }
})
