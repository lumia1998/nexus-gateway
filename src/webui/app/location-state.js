// Navigation URLs contain only identifiers and filters, never task text or credentials.
export function readLocationState() {
  const [name, query] = location.hash.replace(/^#\/?/, '').split('?')
  const page = ['overview','runs','artifacts','agents','workspaces','keys','settings'].includes(name) ? name : 'overview'
  const params = new URLSearchParams(query || '')
  const states = ['running','input_required','permission_required','completed','failed','canceled']
  const id = (value) => value && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) ? value : undefined
  return { page, runAgent: id(params.get('agent')) || 'all', runStatus: states.includes(params.get('state')) ? params.get('state') : 'all',
    runPageSize: [50,100,200].includes(Number(params.get('limit'))) ? Number(params.get('limit')) : 50,
    runOffset: Math.min(10_000_000, Math.max(0, Math.floor(Number(params.get('offset')) || 0))), selectedRunId: id(params.get('run')),
    protocol: ['acp','a2a'].includes(params.get('protocol')) ? params.get('protocol') : 'all',
    status: ['ready','failed','disabled'].includes(params.get('status')) ? params.get('status') : 'all' }
}

export function writeLocationState(state) {
  const params = new URLSearchParams()
  if (state.page === 'runs') {
    if (state.runAgent !== 'all') params.set('agent', state.runAgent)
    if (state.runStatus !== 'all') params.set('state', state.runStatus)
    if (state.runPageSize !== 50) params.set('limit', String(state.runPageSize))
    if (state.runOffset) params.set('offset', String(state.runOffset))
  }
  if (state.page === 'agents') {
    if (state.protocol !== 'all') params.set('protocol', state.protocol)
    if (state.status !== 'all') params.set('status', state.status)
  }
  if (state.selectedRunId) params.set('run', state.selectedRunId)
  history.replaceState(null, '', '#/' + state.page + (params.size ? '?' + params : ''))
}
