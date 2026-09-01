import type { ServerResponse } from 'node:http'
import { markup } from './markup.js'
import { styles } from './styles.js'
import { sources } from './app/sources.js'

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Agent Nexus</title>
  <style>${styles}</style>
  <script type="module" defer src="/ui/app.js"></script>
</head>
<body>${markup}</body>
</html>`

const entryModule = `import './app/main.js'\n`

const modules: Record<string, string> = { '/ui/app.js': entryModule }
for (const [name, source] of Object.entries(sources)) {
    modules['/ui/app/' + name + '.js'] = source
}

export function redirectToAgentdWebUi(response: ServerResponse) {
    response.writeHead(302, {
        Location: '/ui/',
        'Cache-Control': 'no-store'
    })
    response.end()
}

export function writeAgentdWebUi(response: ServerResponse) {
    response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(page),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
            "default-src 'none'; connect-src 'self'; img-src 'self' data:; media-src 'self' data:; style-src 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    })
    response.end(page)
}

export function writeAgentdWebUiModule(response: ServerResponse, pathname: string) {
    const source = modules[pathname]
    if (!source) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        response.end('Not found')
        return
    }
    response.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    })
    response.end(source)
}
