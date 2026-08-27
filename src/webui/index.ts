import type { ServerResponse } from 'node:http'
import { app } from './app.js'
import { markup } from './markup.js'
import { styles } from './styles.js'

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Agent Nexus</title>
  <style>${styles}</style>
</head>
<body>${markup}<script>${app}</script></body>
</html>`

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
        'Content-Security-Policy': "default-src 'none'; connect-src 'self'; img-src 'self' data:; media-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    })
    response.end(page)
}
