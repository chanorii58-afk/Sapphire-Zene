'use strict';
/*
 * AI provider layer (OpenAI-compatible APIs: Groq, Cerebras, OpenRouter free models).
 *  - several keys + several models, rotated automatically
 *  - 429 -> that key+model cools down for the time the provider asks, then the next one is tried
 *  - dead / decommissioned models are blocked at runtime and the model list is refreshed from the provider
 *  - payloads are sanitised and trimmed so 400/413 errors do not happen
 */
const crypto = require('crypto');
const store = require('./store');

const PROVIDERS = {
  groq: {
    label: 'Groq',
    base: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
    keyRe: /^gsk_/,
    preferred: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'],
  },
  cerebras: {
    label: 'Cerebras',
    base: process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1',
    keyRe: /^csk-/,
    preferred: ['gpt-oss-120b', 'llama-3.3-70b', 'llama3.1-8b', 'qwen-3-32b'],
  },
  openrouter: {
    label: 'OpenRouter',
    base: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    keyRe: /^sk-or-/,
    preferred: [],
    freeOnly: true,
  },
};
const PROVIDER_ORDER = Object.keys(PROVIDERS);
const NOT_CHAT = /whisper|tts|guard|embed|moderation|orpheus|playai|transcribe|rerank|image|vision-only|safeguard/i;

const cool = new Map(); // "keyId|model" -> until
const keyBad = new Map(); // keyId -> until
const deadModel = new Map(); // "provider:model" -> until
const discovered = {}; // provider -> { ts, ids }
const keyInfo = {}; // keyId -> { lastOk, lastError, lastErrorAt, uses }
let rr = 0;
let refreshTimer = null;
let refreshedAt = 0;

const mask = (k) => (k.length > 10 ? k.slice(0, 4) + '…' + k.slice(-4) : '••••');
const keyId = (provider, key) => provider + ':' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);

function detectProvider(key) {
  for (const p of PROVIDER_ORDER) if (PROVIDERS[p].keyRe.test(key)) return p;
  return null;
}

function envKeys() {
  const out = [];
  const add = (prov, raw) => {
    String(raw || '')
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((k) => {
        const p = prov || detectProvider(k);
        if (p) out.push({ provider: p, key: k, source: 'env', label: '' });
      });
  };
  add('groq', process.env.GROQ_API_KEYS);
  add('groq', process.env.GROQ_API_KEY);
  add('cerebras', process.env.CEREBRAS_API_KEYS);
  add('cerebras', process.env.CEREBRAS_API_KEY);
  add('openrouter', process.env.OPENROUTER_API_KEYS);
  add('openrouter', process.env.OPENROUTER_API_KEY);
  add(null, process.env.AI_API_KEYS);
  return out;
}

function allKeys() {
  const cfg = store.get('config') || {};
  const dash = (cfg.keys || []).map((k) => ({ provider: k.provider, key: k.key, source: 'dashboard', label: k.label || '' }));
  const seen = new Set();
  const out = [];
  for (const k of envKeys().concat(dash)) {
    if (!k.key || seen.has(k.key) || !PROVIDERS[k.provider]) continue;
    seen.add(k.key);
    out.push(Object.assign({}, k, { id: keyId(k.provider, k.key) }));
  }
  return out;
}

function addKey(key, label) {
  key = String(key || '').trim();
  if (!/^\S{16,300}$/.test(key)) throw new Error('That does not look like an API key.');
  const provider = detectProvider(key);
  if (!provider) throw new Error('Unknown key type. Use a Groq key (gsk_…), Cerebras key (csk-…) or OpenRouter key (sk-or-…).');
  if (allKeys().some((k) => k.key === key)) throw new Error('That key is already added.');
  const cfg = store.get('config');
  if ((cfg.keys || []).length >= 8) throw new Error('You can add up to 8 keys in the dashboard.');
  cfg.keys = (cfg.keys || []).concat([{ provider, key, label: String(label || '').slice(0, 30), added: Date.now() }]);
  store.touch('config');
  refreshModels().catch(() => {});
  return provider;
}

function removeKey(id) {
  const cfg = store.get('config');
  const before = (cfg.keys || []).length;
  cfg.keys = (cfg.keys || []).filter((k) => keyId(k.provider, k.key) !== id);
  if (cfg.keys.length === before) throw new Error('Key not found (keys set in Render environment variables are removed there).');
  store.touch('config');
}

/* ---------- models ---------- */

function pickModels(provider, ids) {
  const prov = PROVIDERS[provider];
  const usable = ids.filter((id) => !NOT_CHAT.test(id));
  if (prov.freeOnly) {
    const ok = usable.filter((id) => /llama|gemma|mistral|qwen|gpt-oss/i.test(id) && !/vision|-vl|coder|thinking|reason|r1|image|audio/i.test(id));
    return ok.slice(0, 6);
  }
  const ordered = prov.preferred.filter((id) => usable.includes(id));
  return ordered.length ? ordered : usable.slice(0, 8);
}

function baseModels(provider) {
  const d = discovered[provider];
  if (d && d.ids.length) return pickModels(provider, d.ids);
  return PROVIDERS[provider].preferred.slice();
}

function modelList(provider, includeDisabled) {
  const cfg = store.get('config') || {};
  const m = cfg.models || {};
  const disabled = new Set(m.disabled || []);
  const custom = (m.custom || []).filter((x) => x.provider === provider).map((x) => x.id);
  const ids = custom.concat(baseModels(provider).filter((id) => !custom.includes(id)));
  return includeDisabled ? ids : ids.filter((id) => !disabled.has(provider + ':' + id));
}

async function refreshModels() {
  const keys = allKeys();
  for (const prov of PROVIDER_ORDER) {
    const k = keys.find((x) => x.provider === prov && (keyBad.get(x.id) || 0) <= Date.now());
    if (!k) continue;
    try {
      const res = await fetch(PROVIDERS[prov].base + '/models', {
        headers: { Authorization: 'Bearer ' + k.key },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const j = await res.json();
      let rows = Array.isArray(j.data) ? j.data : [];
      rows = rows.filter((r) => r && typeof r.id === 'string' && r.active !== false);
      if (PROVIDERS[prov].freeOnly) {
        rows = rows.filter((r) => /:free$/.test(r.id) || (r.pricing && Number(r.pricing.prompt) === 0 && Number(r.pricing.completion) === 0));
      }
      if (rows.length) discovered[prov] = { ts: Date.now(), ids: rows.map((r) => r.id) };
    } catch (e) {
      /* keep what we have */
    }
  }
  refreshedAt = Date.now();
}

function setModelEnabled(provider, id, enabled) {
  const cfg = store.get('config');
  cfg.models = cfg.models || { disabled: [], custom: [] };
  const tag = provider + ':' + id;
  const set = new Set(cfg.models.disabled || []);
  if (enabled) set.delete(tag);
  else set.add(tag);
  cfg.models.disabled = Array.from(set);
  if (enabled) deadModel.delete(tag);
  store.touch('config');
}

function addCustomModel(provider, id) {
  if (!PROVIDERS[provider]) throw new Error('Unknown provider.');
  id = String(id || '').trim();
  if (!/^[\w.\-:/]{2,100}$/.test(id)) throw new Error('That model name looks wrong.');
  const cfg = store.get('config');
  cfg.models = cfg.models || { disabled: [], custom: [] };
  if (!cfg.models.custom.some((m) => m.provider === provider && m.id === id)) cfg.models.custom.push({ provider, id });
  cfg.models.disabled = (cfg.models.disabled || []).filter((t) => t !== provider + ':' + id);
  deadModel.delete(provider + ':' + id);
  store.touch('config');
}

function removeCustomModel(provider, id) {
  const cfg = store.get('config');
  if (!cfg.models) return;
  cfg.models.custom = (cfg.models.custom || []).filter((m) => !(m.provider === provider && m.id === id));
  store.touch('config');
}

/* ---------- message hygiene ---------- */

function sanitizeMessages(msgs) {
  const out = [];
  for (const m of msgs || []) {
    if (!m || m.content == null) continue;
    const content = String(m.content).replace(/\u0000/g, '').trim();
    if (!content) continue;
    const role = m.role === 'system' || m.role === 'assistant' ? m.role : 'user';
    const prev = out[out.length - 1];
    if (prev && prev.role === role && role !== 'system') prev.content += '\n' + content;
    else out.push({ role, content });
  }
  while (out.length > 1 && out[0].role === 'system' && out[1].role === 'assistant') out.splice(1, 1);
  return out;
}

function trimMessagesToFit(msgs, maxChars) {
  const out = msgs.map((m) => ({ role: m.role, content: m.content }));
  const total = () => out.reduce((n, m) => n + m.content.length + 8, 0);
  while (total() > maxChars && out.length > 2) {
    const i = out.findIndex((m) => m.role !== 'system');
    if (i === -1 || i >= out.length - 1) break;
    out.splice(i, 1);
  }
  if (total() > maxChars && out[0] && out[0].role === 'system') {
    const over = total() - maxChars;
    out[0].content = out[0].content.slice(0, Math.max(1800, out[0].content.length - over));
  }
  if (total() > maxChars) {
    const last = out[out.length - 1];
    last.content = last.content.slice(0, Math.max(300, last.content.length - (total() - maxChars)));
  }
  return sanitizeMessages(out);
}

/* ---------- candidates + calling ---------- */

function candidates() {
  const now = Date.now();
  const keys = allKeys().filter((k) => (keyBad.get(k.id) || 0) <= now);
  const out = [];
  for (const prov of PROVIDER_ORDER) {
    const pk = keys.filter((k) => k.provider === prov);
    if (!pk.length) continue;
    const models = modelList(prov, false).filter((m) => (deadModel.get(prov + ':' + m) || 0) <= now);
    models.forEach((model, mi) => {
      for (let j = 0; j < pk.length; j++) {
        out.push({
          rank: mi + j / 100 + PROVIDER_ORDER.indexOf(prov) / 1000,
          provider: prov,
          key: pk[(j + rr) % pk.length],
          model,
        });
      }
    });
  }
  out.sort((a, b) => a.rank - b.rank);
  return out;
}

function mkErr(kind, message, extra) {
  const e = new Error(message);
  e.kind = kind;
  return Object.assign(e, extra || {});
}

async function callOnce(c, messages, opts, tight) {
  const prov = PROVIDERS[c.provider];
  const oss = /gpt-oss/i.test(c.model);
  const body = {
    model: c.model,
    messages: trimMessagesToFit(messages, tight ? 7000 : 14000),
    temperature: opts.temperature,
    max_tokens: oss ? opts.maxTokens + 700 : opts.maxTokens,
  };
  if (oss && c.provider === 'groq') body.reasoning_effort = 'low';
  const headers = { Authorization: 'Bearer ' + c.key.key, 'Content-Type': 'application/json' };
  if (c.provider === 'openrouter') headers['X-Title'] = 'Zene';
  let res;
  try {
    res = await fetch(prov.base + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    throw mkErr('server', e && e.name === 'TimeoutError' ? 'request timed out' : (e && e.message) || 'network error');
  }
  const raw = await res.text();
  let j = null;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    /* not json */
  }
  if (!res.ok) {
    const msg = (j && j.error && (j.error.message || j.error)) || raw.slice(0, 200) || 'HTTP ' + res.status;
    const m = String(msg);
    if (res.status === 429) {
      const ra = parseFloat(res.headers.get('retry-after'));
      throw mkErr('rate', m, { status: 429, retryAfter: Number.isFinite(ra) ? Math.min(Math.max(ra, 5), 3600) : 45 });
    }
    if (res.status === 401 || res.status === 403) throw mkErr('auth', m, { status: res.status });
    if (res.status === 404 || /model.*(not found|decommissioned|does not exist|deprecated|no longer)|not.*(have|granted).*access to model/i.test(m)) {
      throw mkErr('dead', m, { status: res.status });
    }
    if (res.status === 413 || /too large|reduce the length|context length|maximum context|tokens? per (minute|request).*(limit|exceed)/i.test(m)) {
      throw mkErr('toolarge', m, { status: res.status });
    }
    if (res.status >= 500) throw mkErr('server', m, { status: res.status });
    throw mkErr('bad', m, { status: res.status });
  }
  const choice = j && j.choices && j.choices[0];
  let text = choice && choice.message && choice.message.content;
  if (Array.isArray(text)) text = text.map((p) => (p && p.text) || '').join('');
  text = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  if (!text) throw mkErr('empty', 'the model returned nothing');
  return text;
}

function noteFailure(c, e) {
  const now = Date.now();
  const ck = c.key.id + '|' + c.model;
  const info = (keyInfo[c.key.id] = keyInfo[c.key.id] || { uses: 0 });
  info.lastError = e.kind + ': ' + String(e.message).slice(0, 140);
  info.lastErrorAt = now;
  switch (e.kind) {
    case 'rate':
      cool.set(ck, now + (e.retryAfter || 45) * 1000);
      break;
    case 'auth':
      keyBad.set(c.key.id, now + 30 * 60 * 1000);
      break;
    case 'dead':
      deadModel.set(c.provider + ':' + c.model, now + 6 * 3600 * 1000);
      break;
    case 'server':
      cool.set(ck, now + 20 * 1000);
      break;
    case 'empty':
      cool.set(ck, now + 10 * 1000);
      break;
    default:
      cool.set(ck, now + 30 * 1000);
  }
}

async function chat(o) {
  const opts = { maxTokens: o.maxTokens || 300, temperature: o.temperature == null ? 0.9 : o.temperature, timeoutMs: o.timeoutMs || 30000 };
  rr++;
  const cands = candidates();
  if (!cands.length) {
    const hasKeys = allKeys().length > 0;
    throw mkErr(hasKeys ? 'ALL_FAILED' : 'NO_KEYS', hasKeys ? 'All keys are currently blocked or invalid.' : 'No AI key is configured.', {
      code: hasKeys ? 'ALL_FAILED' : 'NO_KEYS',
      retryAfter: 30,
    });
  }
  const clean = sanitizeMessages(o.messages);
  let lastErr = null;
  let attempts = 0;
  let soonest = Infinity;
  for (const c of cands) {
    const until = cool.get(c.key.id + '|' + c.model) || 0;
    if (until > Date.now()) {
      soonest = Math.min(soonest, until);
      continue;
    }
    if (attempts >= 6) break;
    attempts++;
    try {
      let text;
      try {
        text = await callOnce(c, clean, opts, false);
      } catch (e) {
        if (e.kind === 'toolarge') text = await callOnce(c, clean, opts, true);
        else throw e;
      }
      const info = (keyInfo[c.key.id] = keyInfo[c.key.id] || { uses: 0 });
      info.lastOk = Date.now();
      info.uses++;
      return { text, model: c.model, provider: c.provider, keyId: c.key.id };
    } catch (e) {
      noteFailure(c, e);
      lastErr = e;
      if (e.kind === 'rate') soonest = Math.min(soonest, Date.now() + (e.retryAfter || 45) * 1000);
    }
  }
  const err = new Error(lastErr ? 'AI request failed: ' + lastErr.message : 'All models are cooling down.');
  err.code = 'ALL_FAILED';
  err.retryAfter = Number.isFinite(soonest) ? Math.max(5, Math.ceil((soonest - Date.now()) / 1000)) : 30;
  throw err;
}

/* ---------- status for the dashboard ---------- */

function status() {
  const now = Date.now();
  const keys = allKeys();
  const keyRows = keys.map((k) => ({
    id: k.id,
    provider: k.provider,
    masked: mask(k.key),
    label: k.label,
    source: k.source,
    state: (keyBad.get(k.id) || 0) > now ? 'invalid' : 'ok',
    lastOk: (keyInfo[k.id] && keyInfo[k.id].lastOk) || 0,
    lastError: (keyInfo[k.id] && keyInfo[k.id].lastError) || '',
    limited: Array.from(cool.entries())
      .filter(([ck, u]) => ck.startsWith(k.id + '|') && u > now)
      .map(([ck, u]) => ({ model: ck.split('|')[1], seconds: Math.ceil((u - now) / 1000) })),
  }));
  const cfg = store.get('config') || {};
  const disabled = new Set((cfg.models && cfg.models.disabled) || []);
  const custom = (cfg.models && cfg.models.custom) || [];
  const models = [];
  for (const prov of PROVIDER_ORDER) {
    if (!keys.some((k) => k.provider === prov)) continue;
    for (const id of modelList(prov, true)) {
      models.push({
        provider: prov,
        id,
        enabled: !disabled.has(prov + ':' + id),
        dead: (deadModel.get(prov + ':' + id) || 0) > now,
        custom: custom.some((m) => m.provider === prov && m.id === id),
      });
    }
  }
  return { keys: keyRows, models, refreshedAt, providers: PROVIDER_ORDER.map((p) => ({ id: p, label: PROVIDERS[p].label })) };
}

function init() {
  refreshModels().catch(() => {});
  if (!refreshTimer) refreshTimer = setInterval(() => refreshModels().catch(() => {}), 6 * 3600 * 1000);
}

module.exports = {
  init,
  chat,
  status,
  addKey,
  removeKey,
  refreshModels,
  setModelEnabled,
  addCustomModel,
  removeCustomModel,
  sanitizeMessages,
  trimMessagesToFit,
  hasKeys: () => allKeys().length > 0,
};
