#!/usr/bin/env node
/**
 * Repeatable data-plane capacity smoke test.
 *
 * Usage:
 *   node scripts/quota-sse-benchmark.mjs --url http://127.0.0.1:8787 \
 *     --key nx_sk_... --agent codex --sessions 32 --sse 16 --slow-ms 5000
 *
 * The script intentionally reports only timings/statuses. It never prints
 * the API key, task text, response bodies, or server headers.
 */

const args = parseArgs(process.argv.slice(2))
const base = String(args.url || process.env.NEXUS_URL || 'http://127.0.0.1:8787').replace(/\/$/, '')
const key = String(args.key || process.env.NEXUS_API_KEY || '')
const agent = String(args.agent || process.env.NEXUS_AGENT || '')
const sessionCount = positive(args.sessions, 16)
const sseCount = positive(args.sse, 8)
const slowMs = positive(args['slow-ms'], 2_000)
if (!key || !agent) {
  console.error('Provide --key and --agent (or NEXUS_API_KEY and NEXUS_AGENT).')
  process.exitCode = 2
} else {
  await run()
}

async function run() {
  const headers = { Authorization: `Bearer ${key}` }
  const started = Date.now()
  const sessionResults = await Promise.all(Array.from({ length: sessionCount }, async () => {
    const begin = Date.now()
    const response = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: agent })
    })
    let session
    if (response.ok) {
      try { session = await response.json() } catch {}
    }
    return { status: response.status, elapsedMs: Date.now() - begin, session }
  }))
  const usable = sessionResults.map((item) => item.session).filter((item) => item?.id)
  const controllers = []
  const sse = await Promise.all(Array.from({ length: sseCount }, async (_, index) => {
    const begin = Date.now()
    const session = usable[index % Math.max(1, usable.length)]
    if (!session) return { status: 0, elapsedMs: Date.now() - begin }
    const controller = new AbortController()
    controllers.push(controller)
    try {
      const response = await fetch(`${base}/v1/sessions/${encodeURIComponent(session.id)}/events`, {
        headers,
        signal: controller.signal
      })
      return { status: response.status, elapsedMs: Date.now() - begin }
    } catch {
      return { status: 0, elapsedMs: Date.now() - begin }
    }
  }))
  // A real slow-consumer run needs a known session ID. Keep any successful
  // sessions open while the caller's configured timeout exercises the server.
  await new Promise((resolve) => setTimeout(resolve, slowMs))
  controllers.forEach((controller) => controller.abort())
  await Promise.all(usable.map((session) => fetch(`${base}/v1/sessions/${encodeURIComponent(session.id)}`, {
    method: 'DELETE', headers
  }).catch(() => undefined)))
  const summary = {
    durationMs: Date.now() - started,
    sessions: summarize(sessionResults),
    sse: summarize(sse),
    slowConsumerWaitMs: slowMs
  }
  console.log(JSON.stringify(summary, null, 2))
}

function summarize(values) {
  const sorted = values.map((item) => item.elapsedMs).sort((a, b) => a - b)
  return {
    attempted: values.length,
    accepted: values.filter((item) => item.status >= 200 && item.status < 300).length,
    quotaRejected: values.filter((item) => item.status === 429).length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    statuses: Object.fromEntries(values.reduce((map, item) => {
      map.set(item.status, (map.get(item.status) || 0) + 1)
      return map
    }, new Map()))
  }
}

function percentile(sorted, value) {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * value))]
}

function positive(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function parseArgs(values) {
  const result = {}
  for (let index = 0; index < values.length; index++) {
    const value = values[index]
    if (!value.startsWith('--')) continue
    const key = value.slice(2)
    result[key] = values[index + 1]?.startsWith('--') ? true : values[++index]
  }
  return result
}
