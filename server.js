'use strict';
const express = require('express');
const cookieSession = require('cookie-session');
const crypto = require('crypto');
const path = require('path');

const store = require('./store');
const ai = require('./ai');
const brain = require('./brain');
const bot = require('./discord-bot');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const VERSION = '1.0.0';
const DISCORD = (process.env.DISCORD_API_BASE || 'https://discord.com').replace(/\/+$/, '');

/* ---------- helpers ---------- */

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, n) => String(v == null ? '' : v).slice(0, n);

function limiter(max, windowMs) {
  const hits = new Map();
  const f = (key) => {
    const now = Date.now();
    const a = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (a.length >= max) {
      hits.set(key, a);
      return false;
    }
    a.push(now);
    hits.set(key, a);
    return true;
  };
  f.sweep = () => {
    const now = Date.now();
    for (const [k, a] of hits) if (!a.some((t) => now - t < windowMs)) hits.delete(k);
  };
  return f;
}
const loginLimit = limiter(8, 10 * 60 * 1000);
const gwLimit = limiter(240, 60 * 1000);
const gwChatLimit = limiter(30, 60 * 1000);
const gwFailLimit = limiter(20, 10 * 60 * 1000);
const webChatLimit = limiter(30, 60 * 1000);
setInterval(() => [loginLimit, gwLimit, gwChatLimit, gwFailLimit, webChatLimit].forEach((l) => l.sweep()), 5 * 60 * 1000).unref();

async function main() {
  await store.init();
  brain.init();

  const config = store.get('config');
  if (!config.sessionSecret) {
    config.sessionSecret = crypto.randomBytes(32).toString('hex');
    store.touch('config');
  }
  if (!config.gatewayKey) {
    config.gatewayKey = 'zk_' + crypto.randomBytes(18).toString('hex');
    store.touch('config');
  }
  const sessionSecret = process.env.SESSION_SECRET || config.sessionSecret;
  const gatewayKey = () => process.env.GATEWAY_KEY || store.get('config').gatewayKey;
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  const oauthOn = !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
  const baseUrl = (req) => PUBLIC_URL || req.protocol + '://' + req.get('host');

  ai.init();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
    );
    next();
  });
  const smallJson = express.json({ limit: '1mb' });
  const bigJson = express.json({ limit: '12mb' });
  app.use((req, res, next) => (req.path === '/api/import' ? bigJson(req, res, next) : smallJson(req, res, next)));
  app.use(
    cookieSession({
      name: 'zene',
      keys: [sessionSecret],
      maxAge: 30 * 24 * 3600 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: PUBLIC_URL.startsWith('https://'),
    })
  );

  /* ---------- public ---------- */

  app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));
  app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  /* ---------- login ---------- */

  const ownerLogin = (req, id, name) => {
    req.session = { user: { id: String(id), name: str(name, 40) }, at: Date.now() };
  };

  app.post(
    '/auth/login',
    wrap(async (req, res) => {
      if (!adminPassword) return res.status(404).json({ error: 'Password login is not set up. Set ADMIN_PASSWORD on Render.' });
      if (!loginLimit(req.ip)) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes.' });
      if (!safeEqual(str(req.body && req.body.password, 200), adminPassword)) return res.status(401).json({ error: 'Wrong password.' });
      ownerLogin(req, 'admin', brain.cfg().ownerName);
      res.json({ ok: true });
    })
  );

  app.post('/auth/logout', (req, res) => {
    req.session = null;
    res.json({ ok: true });
  });

  app.get('/auth/discord', (req, res) => {
    if (!oauthOn) return res.status(404).send('Discord login is not set up.');
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    const q = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: baseUrl(req) + '/auth/callback',
      response_type: 'code',
      scope: 'identify',
      state,
    });
    res.redirect(DISCORD + '/oauth2/authorize?' + q.toString());
  });

  app.get(
    '/auth/callback',
    wrap(async (req, res) => {
      if (!oauthOn) return res.status(404).send('Discord login is not set up.');
      const { code, state } = req.query;
      if (!code || !state || !req.session || !req.session.oauthState || !safeEqual(state, req.session.oauthState)) {
        return res.status(400).send('Login expired. Go back and try again.');
      }
      const tok = await fetch(DISCORD + '/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.DISCORD_CLIENT_ID,
          client_secret: process.env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: baseUrl(req) + '/auth/callback',
        }),
        signal: AbortSignal.timeout(15000),
      }).then((r) => r.json());
      if (!tok.access_token) return res.status(400).send('Discord did not accept the login.');
      const me = await fetch(DISCORD + '/api/users/@me', {
        headers: { Authorization: 'Bearer ' + tok.access_token },
        signal: AbortSignal.timeout(15000),
      }).then((r) => r.json());
      if (!me || !me.id || !brain.isOwnerDiscord(me.id)) {
        req.session = null;
        return res.status(403).send('This is a private site.');
      }
      ownerLogin(req, me.id, me.global_name || me.username);
      res.redirect('/');
    })
  );

  /* ---------- gateway (Roblox script) ---------- */

  const gw = express.Router();
  gw.use((req, res, next) => {
    const given = str(req.get('x-zene-key') || (req.body && req.body.key), 200);
    if (!given || !safeEqual(given, gatewayKey())) {
      if (!gwFailLimit(req.ip)) return res.status(429).json({ ok: false, error: 'slow down' });
      return res.status(401).json({ ok: false, error: 'bad key' });
    }
    if (!gwLimit(req.ip)) return res.status(429).json({ ok: false, error: 'rate limited' });
    next();
  });

  const robloxScope = (b) => 'roblox:' + str((b.game && (b.game.jobId || b.game.placeId)) || 'unknown', 60);

  gw.get('/ping', (req, res) => {
    res.json({ ok: true, name: brain.cfg().name, mood: brain.getMood().name, version: VERSION, hasBrain: ai.hasKeys() });
  });

  gw.post(
    '/chat',
    wrap(async (req, res) => {
      const b = req.body || {};
      const p = b.player || {};
      const text = str(b.message, 500).trim();
      if (!text || !p.name) return res.status(400).json({ ok: false, error: 'player.name and message are required' });
      if (!gwChatLimit(req.ip)) return res.status(429).json({ ok: false, error: 'too many chats' });
      const g = b.game || {};
      brain.setRobloxStatus({ user: undefined, game: g.name, placeId: g.placeId, jobId: g.jobId, players: b.playerCount });
      const owner = brain.isOwnerRoblox(p.name);
      try {
        const r = await brain.respond({
          surface: 'roblox',
          scope: robloxScope(b),
          mode: b.mode === 'ambient' ? 'ambient' : 'direct',
          speaker: { key: 'roblox:' + str(p.userId || p.name, 30), name: str(p.displayName || p.name, 40), owner },
          text,
          context: { game: str(g.name, 60), playerCount: Number(b.playerCount) || 0, nearby: Array.isArray(b.nearby) ? b.nearby.slice(0, 5).map((n) => str(n, 32)) : [] },
        });
        res.json({ ok: true, reply: r.silent ? null : r.text, silent: !!r.silent, mood: r.mood, isOwner: owner });
      } catch (e) {
        const code = e.code || 'ERROR';
        res.status(code === 'NO_KEYS' || code === 'ALL_FAILED' || code === 'BUSY' ? 503 : 500).json({ ok: false, error: code, retryAfter: e.retryAfter || 10 });
      }
    })
  );

  gw.post('/events', (req, res) => {
    const b = req.body || {};
    const scope = robloxScope(b);
    const events = Array.isArray(b.events) ? b.events.slice(0, 40) : [];
    for (const ev of events) {
      if (ev && ev.type === 'chat' && ev.name && ev.text) brain.ambientLog(scope, str(ev.display || ev.name, 32), str(ev.text, 200));
    }
    res.json({ ok: true, count: events.length });
  });

  gw.post('/heartbeat', (req, res) => {
    const b = req.body || {};
    brain.setRobloxStatus({
      user: str(b.user, 40),
      game: str(b.game, 80),
      placeId: str(b.placeId, 20),
      jobId: str(b.jobId, 60),
      players: Number(b.players) || 0,
      doing: str(b.doing, 100),
    });
    res.json({ ok: true, mood: brain.getMood().name });
  });

  gw.get('/poll', (req, res) => {
    brain.setRobloxStatus({ user: req.query.user ? str(req.query.user, 40) : undefined });
    const after = req.query.after === undefined ? null : Number(req.query.after);
    const r = brain.pollOutbox(after == null || !Number.isFinite(after) ? Infinity : after);
    res.json({ ok: true, latest: r.latest, items: after == null ? [] : r.items, mood: brain.getMood().name });
  });

  gw.get('/knowledge', (req, res) => {
    const q = str(req.query.q, 200);
    const items = q ? brain.searchKnowledge(q, 5) : [];
    res.json({ ok: true, items: items.map((e) => ({ title: e.title, text: e.text })) });
  });

  gw.post('/knowledge', (req, res) => {
    const b = req.body || {};
    try {
      const item = brain.addKnowledge({ title: b.title, text: b.text, source: 'roblox' });
      res.json({ ok: true, id: item.id });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.use('/gateway', gw);

  /* ---------- dashboard API ---------- */

  const api = express.Router();

  api.get('/me', (req, res) => {
    const u = req.session && req.session.user;
    res.json({ authed: !!u, user: u || null, methods: { password: !!adminPassword, discord: oauthOn } });
  });

  api.use((req, res, next) => {
    if (!(req.session && req.session.user)) return res.status(401).json({ error: 'Not signed in.' });
    if (req.method !== 'GET') {
      if (req.is('application/json') === false) return res.status(415).json({ error: 'JSON only.' });
      const origin = req.get('origin');
      if (origin) {
        let host = '';
        try {
          host = new URL(origin).host;
        } catch (e) {
          /* invalid origin header */
        }
        if (host !== req.get('host')) return res.status(403).json({ error: 'Cross-site request blocked.' });
      }
    }
    next();
  });

  api.get('/state', (req, res) => {
    res.json({
      version: VERSION,
      config: brain.publicConfig(),
      mood: brain.getMood(),
      moods: brain.MOODS,
      counts: brain.stats(),
      storage: store.info(),
      ai: ai.status(),
      discord: bot.status(),
      roblox: brain.robloxStatus(),
      gateway: { url: baseUrl(req), key: gatewayKey(), keyFromEnv: !!process.env.GATEWAY_KEY },
      ownerDiscordIdsFromEnv: !!process.env.OWNER_DISCORD_ID,
    });
  });

  api.post(
    '/chat',
    wrap(async (req, res) => {
      if (!webChatLimit('web')) return res.status(429).json({ error: 'Slow down a little.' });
      const text = str(req.body && req.body.message, 1200).trim();
      if (!text) return res.status(400).json({ error: 'Say something first.' });
      try {
        const r = await brain.respond({
          surface: 'web',
          scope: 'web:owner',
          speaker: { key: 'web:owner', name: brain.cfg().ownerName, owner: true },
          text,
        });
        res.json({ reply: r.text, mood: r.mood, model: r.model });
      } catch (e) {
        const msg =
          e.code === 'NO_KEYS'
            ? 'No AI key yet. Add one under Brain, then Models.'
            : e.code === 'ALL_FAILED'
            ? `Every model is busy or limited right now. Try again in about ${e.retryAfter || 30}s.`
            : e.code === 'BUSY'
            ? 'Still thinking about your last messages. One moment.'
            : 'Something went wrong while thinking.';
        res.status(503).json({ error: msg });
      }
    })
  );

  api.get('/chat/history', (req, res) => {
    res.json({ items: brain.recent('web:owner', 40) });
  });

  api.get('/memory', (req, res) => {
    res.json(brain.listMemory({ q: req.query.q, surface: req.query.surface, limit: req.query.limit, offset: req.query.offset }));
  });
  api.delete('/memory/:id', (req, res) => {
    res.json({ ok: brain.deleteMemory(parseInt(req.params.id, 10)) });
  });
  api.post('/memory/wipe', (req, res) => {
    const b = req.body || {};
    if (b.confirm !== 'WIPE') return res.status(400).json({ error: 'Type WIPE to confirm.' });
    res.json({ removed: brain.wipeMemory({ surface: b.surface || '' }) });
  });

  api.get('/people', (req, res) => res.json({ items: brain.listPeople() }));
  api.put('/people', (req, res) => {
    try {
      brain.setPersonNotes(str(req.body.key, 80), str(req.body.notes, 300));
      res.json({ ok: true });
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  api.get('/knowledge', (req, res) => res.json({ items: store.get('knowledge').slice().reverse() }));
  api.post('/knowledge', (req, res) => {
    try {
      res.json({ item: brain.addKnowledge(req.body || {}) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  api.put('/knowledge/:id', (req, res) => {
    try {
      res.json({ item: brain.updateKnowledge(parseInt(req.params.id, 10), req.body || {}) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  api.delete('/knowledge/:id', (req, res) => res.json({ ok: brain.deleteKnowledge(parseInt(req.params.id, 10)) }));

  api.put('/config', (req, res) => {
    try {
      brain.updateConfig(req.body || {});
      res.json({ config: brain.publicConfig() });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  api.post('/mood', (req, res) => {
    brain.setMood(str(req.body.mood, 20));
    res.json({ mood: brain.getMood() });
  });

  api.get('/models', (req, res) => res.json(ai.status()));
  api.post(
    '/models/refresh',
    wrap(async (req, res) => {
      await ai.refreshModels();
      res.json(ai.status());
    })
  );
  api.put('/models/toggle', (req, res) => {
    ai.setModelEnabled(str(req.body.provider, 20), str(req.body.id, 100), !!req.body.enabled);
    res.json(ai.status());
  });
  api.post('/models/custom', (req, res) => {
    try {
      ai.addCustomModel(str(req.body.provider, 20), req.body.id);
      res.json(ai.status());
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  api.delete('/models/custom', (req, res) => {
    ai.removeCustomModel(str(req.body.provider, 20), str(req.body.id, 100));
    res.json(ai.status());
  });
  api.post('/keys', (req, res) => {
    try {
      const provider = ai.addKey(req.body.key, req.body.label);
      res.json({ provider, ai: ai.status() });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  api.delete('/keys/:id', (req, res) => {
    try {
      ai.removeKey(req.params.id);
      res.json({ ai: ai.status() });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  api.post('/roblox/say', (req, res) => {
    const text = str(req.body.text, 400).trim();
    if (!text) return res.status(400).json({ error: 'Write something for her to say.' });
    res.json({ item: brain.pushOutbox('say', text, 'dashboard') });
  });
  api.post('/roblox/order', (req, res) => {
    const text = str(req.body.text, 400).trim();
    if (!text) return res.status(400).json({ error: 'Write the order first.' });
    res.json({ item: brain.pushOutbox('order', text, 'dashboard') });
  });
  api.get('/roblox/log', (req, res) => {
    const mem = brain.listMemory({ surface: 'roblox', limit: 30 });
    res.json({ items: mem.items, outbox: store.get('outbox').items.slice(-10).reverse() });
  });
  api.post('/gateway/regenerate', (req, res) => {
    if (process.env.GATEWAY_KEY) return res.status(400).json({ error: 'The key is set in Render environment variables. Change it there.' });
    store.get('config').gatewayKey = 'zk_' + crypto.randomBytes(18).toString('hex');
    store.touch('config');
    res.json({ key: store.get('config').gatewayKey });
  });

  api.get('/export', (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="zene-backup-' + new Date().toISOString().slice(0, 10) + '.json"');
    res.json(store.exportAll());
  });
  api.post('/import', (req, res) => {
    try {
      store.importAll(req.body);
      res.json({ ok: true, counts: brain.stats() });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  api.post('/danger/wipe', (req, res) => {
    const b = req.body || {};
    if (b.confirm !== 'WIPE') return res.status(400).json({ error: 'Type WIPE to confirm.' });
    const what = b.what;
    if (what === 'memory') {
      brain.wipeMemory({});
    } else if (what === 'knowledge') {
      store.get('knowledge').length = 0;
      store.touch('knowledge');
    } else if (what === 'people') {
      const p = store.get('people');
      Object.keys(p).forEach((k) => delete p[k]);
      store.touch('people');
    } else if (what === 'everything') {
      brain.wipeMemory({});
      store.get('knowledge').length = 0;
      const p = store.get('people');
      Object.keys(p).forEach((k) => delete p[k]);
      ['knowledge', 'people'].forEach((n) => store.touch(n));
    } else {
      return res.status(400).json({ error: 'Unknown wipe target.' });
    }
    res.json({ ok: true, counts: brain.stats() });
  });

  app.use('/api', api);

  /* ---------- errors ---------- */

  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too large.' });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad JSON.' });
    console.error('[error]', req.method, req.path, err && err.message);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  const server = app.listen(PORT, () => {
    console.log(`[zene] listening on :${PORT} (storage: ${store.info().mode}${PUBLIC_URL ? ', url ' + PUBLIC_URL : ''})`);
    if (!store.info().persistent) console.warn('[zene] WARNING: no Upstash configured. Memory is kept in ./data and will be lost when Render restarts.');
    if (!adminPassword && !oauthOn) console.warn('[zene] WARNING: set ADMIN_PASSWORD (or Discord OAuth) or you cannot log in to the dashboard.');
    if (!ai.hasKeys()) console.warn('[zene] No AI key yet. Set GROQ_API_KEY or add one in the dashboard.');
    bot.start();
  });

  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return;
    closing = true;
    console.log(`[zene] ${sig}: saving and shutting down`);
    server.close();
    await bot.stop();
    await store.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message ? e.message : e));

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
