#!/usr/bin/env node
// Offerstack MCP server: lets Claude (Desktop, Code or any MCP client) read your resumes and vault and
// push bullets back into Offerstack while you chat. It talks to the local Offerstack server, which
// relays to the app open in your browser (see src/bridge.js), so Offerstack must be running and open.
//
//   claude mcp add offerstack -- node /path/to/offerstack/api/mcp/server.js
//
// OFFERSTACK_API overrides the server address (default http://127.0.0.1:8787).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const API = (process.env.OFFERSTACK_API || 'http://127.0.0.1:8787').replace(/\/$/, '')

async function call(method, path, body) {
  let res
  try {
    res = await fetch(API + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  } catch {
    throw new Error(`Offerstack isn't running (nothing at ${API}). Start it with \`npm run dev\` in the offerstack/app folder.`)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error?.message || data?.error || `Offerstack returned ${res.status}`)
  return data
}

const snapshot = () => call('GET', '/api/bridge/snapshot')
const command = async (type, args) => (await call('POST', '/api/bridge/commands', { type, args })).result

const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] })
const tool = fn => async args => {
  try { return text(await fn(args)) } catch (e) { return { ...text(e.message), isError: true } }
}

const resumeOf = (snap, id) => {
  const r = snap.resumes.find(x => x.id === (id || snap.currentId)) ?? (!id ? snap.resumes[0] : null)
  if (!r) throw new Error(`No resume with id ${id}. Call list_resumes to see them.`)
  return r
}

const server = new McpServer({ name: 'offerstack', version: '0.1.0' }, {
  instructions: `Offerstack is the user's local resume workbench. The vault holds every bullet they have written, across all their resumes; each resume is built from it.
Use list_resumes, get_resume and search_vault to read before you write. Work with the user's own facts: never invent employers, titles, dates, tools or numbers. When a stronger bullet needs a metric they haven't given, ask them, or write a placeholder like [X]% for them to fill in.
Changes appear live in the app, where the user can undo them. Prefer add_to_vault for drafts the user wants to keep; edit a resume directly only when they ask.`,
})

server.registerTool('list_resumes', {
  title: 'List resumes',
  description: 'List the resumes in Offerstack (id, name, label, last edited). The one open in the app is marked current.',
  annotations: { readOnlyHint: true },
}, tool(async () => {
  const snap = await snapshot()
  return snap.resumes.map(r => ({ id: r.id, name: r.name, label: r.label || undefined, headline: r.headline || undefined, updated: new Date(r.updatedAt).toISOString().slice(0, 10), current: r.id === snap.currentId || undefined }))
}))

server.registerTool('get_resume', {
  title: 'Read a resume',
  description: 'Read one resume: its summary and every section, entry and bullet, with the ids needed to edit them. Defaults to the resume open in the app.',
  inputSchema: { resume_id: z.string().optional().describe('From list_resumes; omit for the open resume') },
  annotations: { readOnlyHint: true },
}, tool(async ({ resume_id }) => resumeOf(await snapshot(), resume_id)))

server.registerTool('search_vault', {
  title: 'Search the vault',
  description: 'Search the vault, the master list of everything the user has done across all resumes. Returns items (roles, projects, education…) with their bullets and tags. With no filters, returns the whole vault.',
  inputSchema: {
    query: z.string().optional().describe('Words that must all appear in the bullet or its item, e.g. "pricing experiment"'),
    tag: z.string().optional().describe('Only bullets with this tag, e.g. "Leadership"'),
    kind: z.string().optional().describe('Only items of this kind: experience, projects, education, skills…'),
    limit: z.number().int().min(1).max(500).optional().describe('Most bullets to return (default 200)'),
  },
  annotations: { readOnlyHint: true },
}, tool(async ({ query, tag, kind, limit = 200 }) => {
  const { vault } = await snapshot()
  const words = (query || '').toLowerCase().split(/\s+/).filter(Boolean)
  let left = limit
  const items = []
  for (const item of vault.items) {
    if (kind && item.kind !== kind) continue
    const head = `${item.title} ${item.subtitle} ${(item.roles ?? []).join(' ')}`.toLowerCase()
    const bullets = item.bullets.filter(b =>
      (!tag || b.tags.some(t => t.toLowerCase() === tag.toLowerCase()))
      && words.every(w => b.text.toLowerCase().includes(w) || head.includes(w)))
    if (!bullets.length && (words.length || tag)) continue
    items.push({ ...item, bullets: bullets.slice(0, Math.max(0, left)) })
    left -= bullets.length
    if (left <= 0) break
  }
  return { tags: vault.tags, items, truncated: left < 0 || undefined }
}))

server.registerTool('add_to_vault', {
  title: 'Add bullets to the vault',
  description: 'Save bullets to the vault under a company, project or other item, so they can be used in any resume. Give item_id for an existing item (from search_vault), or a title to find or create one. Bullets already in that item are skipped.',
  inputSchema: {
    bullets: z.array(z.string().min(3)).min(1).max(20).describe('Plain-text bullets'),
    item_id: z.string().optional(),
    title: z.string().optional().describe('The company (for experience), project, school…'),
    role: z.string().optional().describe('For experience: the job title these bullets belong to'),
    kind: z.enum(['experience', 'projects', 'education', 'certificates', 'awards', 'organisations', 'publications', 'courses', 'other']).optional().describe('Default experience'),
    tags: z.array(z.string()).optional().describe('Existing tag labels to add, e.g. ["Leadership"]'),
  },
}, tool(async args => {
  if (!args.item_id && !args.title) throw new Error('Give item_id or a title.')
  return command('add_vault_bullets', args)
}))

server.registerTool('update_vault_bullet', {
  title: 'Edit a vault bullet',
  description: 'Rewrite one bullet in the vault (ids from search_vault). Keep the user\'s facts and numbers.',
  inputSchema: { item_id: z.string(), bullet_id: z.string(), text: z.string().min(3) },
}, tool(args => command('update_vault_bullet', args)))

server.registerTool('add_bullets_to_resume', {
  title: 'Add bullets to a resume',
  description: 'Add bullets to one entry (a role, project…) of a resume. entry_id comes from get_resume.',
  inputSchema: {
    entry_id: z.string(),
    bullets: z.array(z.string().min(3)).min(1).max(12),
    resume_id: z.string().optional().describe('Omit for the open resume'),
    position: z.enum(['start', 'end']).optional().describe('Default end'),
  },
}, tool(args => command('add_resume_bullets', args)))

server.registerTool('replace_resume_bullet', {
  title: 'Replace a resume bullet',
  description: 'Replace one bullet in a resume entry. index is the bullet\'s index from get_resume.',
  inputSchema: { entry_id: z.string(), index: z.number().int().min(0), text: z.string().min(3), resume_id: z.string().optional() },
}, tool(args => command('replace_resume_bullet', args)))

server.registerTool('set_resume_summary', {
  title: 'Set the summary',
  description: 'Replace the profile summary of a resume.',
  inputSchema: { text: z.string().min(10), resume_id: z.string().optional() },
}, tool(args => command('set_resume_summary', args)))

server.registerTool('open_resume', {
  title: 'Open a resume in the app',
  description: 'Show a resume in the Offerstack app (for example after editing it), so the user sees the change.',
  inputSchema: { resume_id: z.string() },
}, tool(args => command('open_resume', args)))

await server.connect(new StdioServerTransport())
