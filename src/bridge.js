import { randomUUID } from 'node:crypto'
import express, { Router } from 'express'
import { fileURLToPath } from 'node:url'
import { existsSync, realpathSync } from 'node:fs'
import { localOnly } from './local.js'

// The bridge between Claude (through the MCP server in mcp/server.js) and the Offerstack app.
// Resumes live in the browser, so the open app keeps this server up to date with a compact copy
// (the snapshot) and listens for commands on a server-sent event stream. Claude reads the snapshot
// and sends commands; the app applies them through its own store (so they save, sync and undo like
// any edit) and posts back the result. Nothing here is written to disk.
//
//   app    PUT  /api/bridge/snapshot        { resumes, vault, currentId }
//   app    GET  /api/bridge/events          SSE: { id, type, args } per command
//   app    POST /api/bridge/results/:id     { ok, result } | { ok: false, error }
//   claude GET  /api/bridge/snapshot        what the app last sent (409 when no app is open)
//   claude POST /api/bridge/commands        { type, args } → waits for the app's result

const COMMAND_TIMEOUT_MS = 20_000
const COMMANDS = new Set(['add_vault_bullets', 'update_vault_bullet', 'add_resume_bullets', 'replace_resume_bullet', 'set_resume_summary', 'open_resume'])

let snapshot = null // { resumes, vault, currentId, at }
const clients = new Set() // open app tabs (SSE responses)
const pending = new Map() // command id → { resolve, timer }

export const appConnected = () => clients.size > 0
export const mcpServerPath = fileURLToPath(new URL('../mcp/server.js', import.meta.url))

// The node to put in Claude Desktop's config. Prefer a stable link (e.g. Homebrew's /opt/homebrew/bin/node)
// over the versioned path we run from, so the config survives a Node upgrade.
function stableNode() {
  const real = (() => { try { return realpathSync(process.execPath) } catch { return process.execPath } })()
  for (const link of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    try { if (existsSync(link) && realpathSync(link) === real) return link } catch { /* ignore */ }
  }
  return process.execPath
}
const nodePath = stableNode()

// For tests.
export function _resetBridge() {
  snapshot = null
  for (const res of clients) res.end()
  clients.clear()
  for (const { timer } of pending.values()) clearTimeout(timer)
  pending.clear()
}

const notOpen = res => res.status(409).json({ error: { code: 'app_not_open', message: 'Offerstack isn’t open. Open http://localhost:5190 in your browser, then try again.' } })

export const bridge = Router()
bridge.use(localOnly)

bridge.get('/info', (_req, res) => res.json({ appConnected: appConnected(), snapshotAt: snapshot?.at ?? null, mcpServerPath, node: nodePath }))

bridge.put('/snapshot', express.json({ limit: '10mb' }), (req, res) => {
  const { resumes, vault, currentId } = req.body ?? {}
  if (!Array.isArray(resumes) || !vault) return res.status(400).json({ error: { code: 'invalid', message: 'Send { resumes, vault, currentId }.' } })
  snapshot = { resumes, vault, currentId: currentId ?? null, at: Date.now() }
  res.json({ ok: true })
})

bridge.get('/snapshot', (_req, res) => (appConnected() && snapshot ? res.json(snapshot) : notOpen(res)))

bridge.get('/events', (req, res) => {
  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  res.flushHeaders()
  res.write(': connected\n\n')
  clients.add(res)
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  req.on('close', () => { clearInterval(ping); clients.delete(res) })
})

bridge.post('/results/:id', express.json({ limit: '1mb' }), (req, res) => {
  const p = pending.get(req.params.id)
  if (p) { clearTimeout(p.timer); pending.delete(req.params.id); p.resolve(req.body ?? { ok: false, error: 'Empty result.' }) }
  res.json({ ok: true })
})

bridge.post('/commands', express.json({ limit: '1mb' }), async (req, res) => {
  const { type, args = {} } = req.body ?? {}
  if (!COMMANDS.has(type)) return res.status(400).json({ error: { code: 'invalid', message: `Unknown command: ${type}` } })
  if (!appConnected()) return notOpen(res)
  const id = randomUUID()
  const result = await new Promise(resolve => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'The app didn’t answer in time. Is the Offerstack tab still open?' }) }, COMMAND_TIMEOUT_MS)
    pending.set(id, { resolve, timer })
    // Only one tab applies it: the most recently opened one.
    const target = [...clients].at(-1)
    target.write(`data: ${JSON.stringify({ id, type, args })}\n\n`)
  })
  res.status(result.ok ? 200 : 422).json(result)
})
