'use strict';
/*
 * Persistence layer.
 *  - Upstash Redis (REST) when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set.
 *    Render's free disk is wiped on every restart, so this is what keeps Zene's memory alive.
 *  - Otherwise plain JSON files in ./data (fine locally, or on a Render disk).
 * Each collection lives under its own key. Upstash values are gzipped to stay under its request size limit.
 * A collection that failed to load is never written back, so a network blip at boot cannot wipe real data.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PREFIX = process.env.STORE_PREFIX || 'zene:';
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, '');
const UP_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const MODE = UP_URL && UP_TOKEN ? 'upstash' : 'file';

const DEFAULTS = {
  config: () => ({}),
  memory: () => [],
  knowledge: () => [],
  people: () => ({}),
  state: () => ({ memSeq: 0, kSeq: 0, mood: null }),
  outbox: () => ({ lastId: 0, items: [] }),
};
const NAMES = Object.keys(DEFAULTS);

const data = {};
const loaded = {};
const dirty = new Set();
const meta = { lastSave: 0, lastError: '', loadError: '' };
let flushTimer = null;
let flushing = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function encode(obj) {
  const json = JSON.stringify(obj);
  if (MODE === 'file') return json;
  return 'gz1:' + zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 6 }).toString('base64');
}

function decode(str) {
  if (str == null) return null;
  if (str.startsWith('gz1:')) return JSON.parse(zlib.gunzipSync(Buffer.from(str.slice(4), 'base64')).toString('utf8'));
  return JSON.parse(str);
}

async function up(cmd) {
  const res = await fetch(UP_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error('upstash: ' + (j.error || res.status));
  return j.result;
}

async function readRaw(name) {
  if (MODE === 'upstash') return up(['GET', PREFIX + name]);
  try {
    return fs.readFileSync(path.join(DATA_DIR, name + '.json'), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function writeRaw(name, str) {
  if (MODE === 'upstash') {
    await up(['SET', PREFIX + name, str]);
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, name + '.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, str);
  fs.renameSync(tmp, file);
}

async function loadOne(name) {
  try {
    const raw = await readRaw(name);
    data[name] = raw == null ? DEFAULTS[name]() : decode(raw);
    if (data[name] == null) data[name] = DEFAULTS[name]();
    loaded[name] = true;
    return true;
  } catch (e) {
    meta.loadError = name + ': ' + e.message;
    if (!data[name]) data[name] = DEFAULTS[name]();
    loaded[name] = false;
    return false;
  }
}

async function init() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const n of NAMES) if (!loaded[n]) await loadOne(n);
    if (NAMES.every((n) => loaded[n])) break;
    if (attempt < 3) await sleep(2500);
  }
  if (NAMES.every((n) => loaded[n])) meta.loadError = '';
  if (!flushTimer) {
    flushTimer = setInterval(() => {
      retryLoads().catch(() => {});
      flush().catch(() => {});
    }, 4000);
  }
}

async function retryLoads() {
  for (const n of NAMES) {
    if (!loaded[n]) await loadOne(n);
  }
  if (NAMES.every((n) => loaded[n])) meta.loadError = '';
}

function get(name) {
  return data[name];
}

function touch(name) {
  dirty.add(name);
}

async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    for (const name of Array.from(dirty)) {
      if (!loaded[name]) continue;
      dirty.delete(name);
      let payload;
      try {
        payload = encode(data[name]);
        await writeRaw(name, payload);
        meta.lastSave = Date.now();
        meta.lastError = '';
      } catch (e) {
        dirty.add(name);
        meta.lastError = name + ': ' + e.message;
      }
    }
  } finally {
    flushing = false;
  }
}

function info() {
  return {
    mode: MODE,
    persistent: MODE === 'upstash',
    lastSave: meta.lastSave,
    lastError: meta.lastError,
    loadError: meta.loadError,
    unloaded: NAMES.filter((n) => !loaded[n]),
    pending: dirty.size,
  };
}

function exportAll() {
  const cfg = JSON.parse(JSON.stringify(data.config || {}));
  delete cfg.keys;
  delete cfg.sessionSecret;
  delete cfg.gatewayKey;
  return {
    app: 'zene',
    version: 1,
    exportedAt: new Date().toISOString(),
    collections: {
      config: cfg,
      memory: data.memory,
      knowledge: data.knowledge,
      people: data.people,
      state: data.state,
    },
  };
}

function importAll(payload) {
  if (!payload || payload.app !== 'zene' || typeof payload.collections !== 'object') {
    throw new Error('This is not a Zene backup file.');
  }
  const c = payload.collections;
  const isArr = Array.isArray;
  const isObj = (v) => v && typeof v === 'object' && !isArr(v);
  if (c.memory !== undefined && !isArr(c.memory)) throw new Error('Backup memory is malformed.');
  if (c.knowledge !== undefined && !isArr(c.knowledge)) throw new Error('Backup knowledge is malformed.');
  if (c.people !== undefined && !isObj(c.people)) throw new Error('Backup people is malformed.');
  if (c.config !== undefined && !isObj(c.config)) throw new Error('Backup config is malformed.');
  for (const n of ['config', 'memory', 'knowledge', 'people']) {
    if (!loaded[n]) throw new Error('Storage is not ready (' + n + ' failed to load). Try again in a minute.');
  }
  if (c.memory) data.memory = c.memory.filter((e) => e && typeof e.t === 'string' && typeof e.id === 'number');
  if (c.knowledge) data.knowledge = c.knowledge.filter((e) => e && typeof e.text === 'string' && typeof e.id === 'number');
  if (c.people) data.people = c.people;
  if (c.config) {
    const cur = data.config || {};
    data.config = Object.assign({}, c.config, {
      keys: cur.keys || [],
      sessionSecret: cur.sessionSecret,
      gatewayKey: cur.gatewayKey,
    });
  }
  const st = data.state;
  const maxMem = data.memory.reduce((m, e) => Math.max(m, e.id), 0);
  const maxK = data.knowledge.reduce((m, e) => Math.max(m, e.id), 0);
  st.memSeq = Math.max(st.memSeq || 0, maxMem);
  st.kSeq = Math.max(st.kSeq || 0, maxK);
  for (const n of ['config', 'memory', 'knowledge', 'people', 'state']) touch(n);
}

async function shutdown() {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  await Promise.race([flush(), sleep(6000)]);
}

module.exports = { init, get, touch, flush, info, exportAll, importAll, shutdown, NAMES };
