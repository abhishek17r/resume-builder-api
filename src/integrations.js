import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Bring-your-own AI providers, configured from the app's Integrations page.
// Saved on this machine only, in <data dir>/integrations.json (git-ignored, readable by your user only).
// Keys are never sent back to the browser: the API returns a masked hint instead.

// kind: how we talk to it. 'openai-compatible' covers anything that speaks the OpenAI chat API.
export const PRESETS = {
  openai: {
    label: 'OpenAI', kind: 'openai', needsKey: true, baseURL: '',
    models: ['gpt-5.5', 'gpt-5-mini'], keyUrl: 'https://platform.openai.com/api-keys',
    blurb: 'GPT models through the OpenAI API.',
  },
  anthropic: {
    label: 'Anthropic', kind: 'anthropic', needsKey: true, baseURL: '',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'], keyUrl: 'https://console.anthropic.com/settings/keys',
    blurb: 'Claude models through the Anthropic API.',
  },
  gemini: {
    label: 'Google Gemini', kind: 'openai-compatible', needsKey: true, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'], keyUrl: 'https://aistudio.google.com/apikey',
    blurb: 'Gemini through Google’s OpenAI-compatible endpoint.',
  },
  openrouter: {
    label: 'OpenRouter', kind: 'openai-compatible', needsKey: true, baseURL: 'https://openrouter.ai/api/v1',
    models: [], keyUrl: 'https://openrouter.ai/keys',
    blurb: 'One key for hundreds of models from many providers.',
  },
  groq: {
    label: 'Groq', kind: 'openai-compatible', needsKey: true, baseURL: 'https://api.groq.com/openai/v1',
    models: [], keyUrl: 'https://console.groq.com/keys',
    blurb: 'Very fast inference for open models.',
  },
  ollama: {
    label: 'Ollama', kind: 'openai-compatible', needsKey: false, baseURL: 'http://localhost:11434/v1',
    models: ['llama3.1', 'qwen2.5'], keyUrl: 'https://ollama.com/download',
    blurb: 'Models running on your own computer. Nothing leaves your machine.',
  },
  custom: {
    label: 'Custom endpoint', kind: 'openai-compatible', needsKey: false, baseURL: '',
    models: [], keyUrl: '',
    blurb: 'Any OpenAI-compatible API: LM Studio, vLLM, Together, a company gateway…',
  },
}

const dataDir = () => resolve(process.env.OFFERSTACK_DATA || '.data')
const dataFile = () => join(dataDir(), 'integrations.json')

let state = null
function load() {
  if (state) return state
  try { state = existsSync(dataFile()) ? JSON.parse(readFileSync(dataFile(), 'utf8')) : null } catch { state = null }
  state ??= { active: null, providers: {} }
  state.providers ??= {}
  return state
}
function persist() {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
  writeFileSync(dataFile(), JSON.stringify(state, null, 2), { mode: 0o600 })
  try { chmodSync(dataFile(), 0o600) } catch { /* not supported everywhere */ }
}

const hint = key => (key ? `••••${key.slice(-4)}` : '')

// The saved config for one provider, with its preset's defaults filled in.
export function configOf(id) {
  const preset = PRESETS[id]
  const saved = load().providers[id]
  if (!preset || !saved) return null
  return { id, kind: preset.kind, label: preset.label, apiKey: saved.apiKey || '', baseURL: saved.baseURL || preset.baseURL, model: saved.model || preset.models[0] || '' }
}

// What the browser may see: everything except the key itself.
export function listIntegrations() {
  const s = load()
  return Object.entries(PRESETS).map(([id, p]) => {
    const saved = s.providers[id]
    return {
      id, ...p,
      configured: !!saved,
      hasKey: !!saved?.apiKey,
      keyHint: hint(saved?.apiKey),
      model: saved?.model || '',
      baseURL: saved?.baseURL || p.baseURL,
      active: s.active === id,
      updatedAt: saved?.updatedAt ?? null,
    }
  })
}

export function saveIntegration(id, { apiKey, model, baseURL }) {
  const s = load()
  const prev = s.providers[id] ?? {}
  s.providers[id] = {
    apiKey: apiKey === undefined ? prev.apiKey ?? '' : apiKey.trim(), // omitted = keep the saved key
    model: (model ?? prev.model ?? '').trim(),
    baseURL: (baseURL ?? prev.baseURL ?? '').trim(),
    updatedAt: Date.now(),
  }
  persist()
}

export function removeIntegration(id) {
  const s = load()
  delete s.providers[id]
  if (s.active === id) s.active = null
  persist()
}

export function setActive(id) {
  const s = load()
  s.active = id && s.providers[id] ? id : null
  persist()
}

export const activeId = () => load().active

// For tests: forget what's cached so the file is read again.
export function _reset() { state = null }
