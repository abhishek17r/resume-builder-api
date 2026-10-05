import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Resume HTML → PDF with the Chrome (or Chromium / Edge / Brave) already on this computer, driven over
// the DevTools protocol: vector text you can select and search, exactly as the app's preview renders it.
// One headless browser is started on first use and closed after a few idle minutes.

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge'],
  win32: [
    `${process.env['PROGRAMFILES'] ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ],
}
export const findChrome = () => [process.env.CHROME_PATH, ...(CANDIDATES[process.platform] ?? [])].find(p => p && existsSync(p)) ?? null

const IDLE_MS = 3 * 60_000
let browser = null // { proc, port, profile, idle }
let launching = null // one start at a time, even for simultaneous requests

async function launch() {
  const exe = findChrome()
  if (!exe) throw Object.assign(new Error('No Chrome, Chromium, Edge or Brave found. Set CHROME_PATH, or use the print dialog.'), { status: 501, code: 'no_browser' })
  const profile = mkdtempSync(join(tmpdir(), 'offerstack-pdf-'))
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  const port = await new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error('The browser for PDFs didn’t start in time.')), 15_000)
    proc.stderr.on('data', d => {
      out += d
      const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(out)
      if (m) { clearTimeout(timer); resolve(Number(m[1])) }
    })
    proc.on('exit', () => { clearTimeout(timer); reject(new Error('The browser for PDFs closed unexpectedly.')) })
  })
  const b = { proc, port, profile, idle: null }
  proc.on('exit', () => {
    if (browser === b) browser = null
    // Chrome may still be flushing its profile as it exits: retry, and never let cleanup crash the server.
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* temp dir; the OS cleans it */ }
  })
  return b
}

// Stop the PDF browser (also used by tests so the process can exit).
export function closePdfBrowser() {
  if (!browser) return
  clearTimeout(browser.idle)
  browser.proc.kill()
  browser = null
}
const close = closePdfBrowser
process.on('exit', close)

// A tiny DevTools client for one page.
async function openPage(port) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('Couldn’t talk to the PDF browser.')) })
  let id = 0
  const pending = new Map()
  ws.onmessage = e => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id
    pending.set(n, m => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)))
    ws.send(JSON.stringify({ id: n, method, params }))
  })
  const done = async () => {
    ws.close()
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {})
  }
  return { send, done }
}

/** html (a complete document) → PDF bytes. The document sets its own page size with @page. */
export async function renderPdf(html) {
  browser ??= await (launching ??= launch().finally(() => { launching = null }))
  clearTimeout(browser.idle)
  const page = await openPage(browser.port)
  try {
    await page.send('Page.enable')
    const { frameTree } = await page.send('Page.getFrameTree')
    await page.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html })
    // Wait for stylesheets (e.g. Google Fonts CSS), then for the fonts they declare and the images, so the
    // PDF uses the resume's real typefaces. fonts.ready alone can resolve before the font CSS has arrived.
    await page.send('Runtime.evaluate', {
      expression: `Promise.race([(async () => {
        const loaded = el => new Promise(r => { el.onload = el.onerror = r })
        await Promise.all([...document.querySelectorAll('link[rel="stylesheet"]')].map(l => (l.sheet ? 0 : loaded(l))))
        document.body.offsetHeight
        await new Promise(r => setTimeout(r, 50))
        await document.fonts.ready
        await Promise.all([...document.images].map(i => (i.complete ? 0 : loaded(i))))
      })(), new Promise(r => setTimeout(r, 10000))])`,
      awaitPromise: true,
    })
    const { data } = await page.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 })
    return Buffer.from(data, 'base64')
  } finally {
    await page.done()
    if (browser) { browser.idle = setTimeout(close, IDLE_MS); browser.idle.unref() }
  }
}
