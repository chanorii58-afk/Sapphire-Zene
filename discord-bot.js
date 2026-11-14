'use strict';
/*
 * Zene's Discord side. Talks when addressed (mention, reply, DM, or her name), can quietly read her home
 * channels, may chime in or speak on her own ("free will") when you turn that on, and relays
 * z.say / z.order to the Roblox script. Everything goes through the same brain as the website and Roblox.
 */
const brain = require('./brain');

let Discord = null;
try {
  Discord = require('discord.js');
} catch (e) {
  Discord = null;
}

const state = { enabled: false, online: false, tag: '', guilds: 0, error: '' };
let client = null;
let botId = null;

const userHits = new Map(); // userId -> [timestamps]
const lastSent = new Map(); // channelId -> ts of Zene's last message
const lastFail = new Map(); // channelId -> ts of last "brain is down" notice
const ambientTimers = new Map();
let lastFreewill = 0;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function split(text, max) {
  max = max || 1900;
  const out = [];
  let s = String(text);
  while (s.length > max) {
    let i = s.lastIndexOf('\n', max);
    if (i < max * 0.5) i = s.lastIndexOf(' ', max);
    if (i < max * 0.5) i = max;
    out.push(s.slice(0, i).trim());
    s = s.slice(i).trim();
  }
  if (s) out.push(s);
  return out;
}

function allowed(userId) {
  const now = Date.now();
  const a = (userHits.get(userId) || []).filter((t) => now - t < 30000);
  if (a.length >= 6) {
    userHits.set(userId, a);
    return false;
  }
  a.push(now);
  userHits.set(userId, a);
  return true;
}

function startTyping(channel) {
  let stopped = false;
  const tick = () => {
    if (stopped || !channel || typeof channel.sendTyping !== 'function') return;
    channel.sendTyping().catch(() => {});
  };
  tick();
  const t = setInterval(tick, 8000);
  return () => {
    stopped = true;
    clearInterval(t);
  };
}

async function send(msg, text) {
  const parts = split(text);
  const opts = { allowedMentions: { parse: [], repliedUser: false } };
  for (let i = 0; i < parts.length; i++) {
    const payload = Object.assign({ content: parts[i] }, opts);
    if (i === 0 && msg.guild && typeof msg.reply === 'function') await msg.reply(payload);
    else await msg.channel.send(payload);
  }
  lastSent.set(msg.channelId || msg.channel.id, Date.now());
}

function placeOf(msg) {
  if (!msg.guild) return 'a private DM';
  const ch = msg.channel && msg.channel.name ? ' #' + msg.channel.name : '';
  return `server "${msg.guild.name}"${ch}`;
}

function brainDownText(e) {
  if (e && e.code === 'NO_KEYS') return 'my brain is not connected yet (no AI key). someone needs to add one in the dashboard.';
  if (e && e.code === 'BUSY') return 'one at a time, please. my brain is queueing.';
  const s = e && e.retryAfter ? Math.min(e.retryAfter, 600) : 30;
  return `i am out of thinking power for a moment. try me again in about ${s}s.`;
}

/* ---------- commands ---------- */

const HELP = [
  'talk to me by mentioning me, replying to me, saying my name, or in DMs.',
  'z.mood: how i feel right now',
  'z.status: what i am doing in Roblox',
  'owner only: z.say <text> (i say it in Roblox), z.order <text> (i get it as an order in Roblox), z.learn <title> | <text>, z.home (toggle this channel as a home channel), z.freewill on|off, z.forget (wipe my memory of this channel)',
].join('\n');

async function handleCommand(msg, cmd, arg, owner) {
  const ownerName = brain.cfg().ownerName;
  const ownerOnly = ['say', 'order', 'learn', 'home', 'freewill', 'forget'];
  if (ownerOnly.includes(cmd) && !owner) return `that one is just for ${ownerName}.`;
  const channelId = msg.channelId || msg.channel.id;
  switch (cmd) {
    case 'help':
      return HELP;
    case 'mood':
      return `feeling ${brain.getMood().name}.`;
    case 'status': {
      const r = brain.robloxStatus();
      if (!r.online) return 'not in Roblox right now.';
      return `in Roblox${r.game ? ' playing ' + r.game : ''}${r.doing ? ', ' + r.doing : ''}.`;
    }
    case 'say':
      if (!arg) return 'say what?';
      brain.pushOutbox('say', arg, 'discord');
      return 'queued. i will say it in Roblox.';
    case 'order':
      if (!arg) return 'order what?';
      brain.pushOutbox('order', arg, 'discord');
      return 'order sent to Roblox.';
    case 'learn': {
      const [title, ...rest] = arg.split('|');
      const text = rest.join('|').trim();
      if (!text) return 'use: z.learn <title> | <what to remember>';
      brain.addKnowledge({ title: title.trim(), text, source: 'discord' });
      return 'learned it.';
    }
    case 'home': {
      const c = brain.cfg().discord;
      const i = c.homeChannels.indexOf(channelId);
      if (i === -1) c.homeChannels.push(channelId);
      else c.homeChannels.splice(i, 1);
      brain.updateConfig({ discord: { homeChannels: c.homeChannels } });
      return i === -1 ? 'this is a home channel now. i will read along here.' : 'not a home channel anymore.';
    }
    case 'freewill': {
      const on = /^(on|true|yes|1)$/i.test(arg.trim());
      brain.updateConfig({ discord: { freewill: on } });
      return on ? 'free will on. i might talk on my own in home channels.' : 'free will off.';
    }
    case 'forget': {
      const n = brain.wipeMemory({ scope: 'discord:' + channelId });
      return `forgot ${n} messages from this channel.`;
    }
    default:
      return null;
  }
}

/* ---------- main handler ---------- */

async function handleMessage(msg) {
  if (!msg || !msg.author || msg.author.bot || msg.webhookId) return;
  const c = brain.cfg();
  const channelId = msg.channelId || (msg.channel && msg.channel.id);
  const isDM = !msg.guild;
  const home = !isDM && c.discord.homeChannels.includes(channelId);
  const owner = brain.isOwnerDiscord(msg.author.id);
  const botName = (client && client.user && client.user.username) || 'zene';

  let clean = String(msg.cleanContent != null ? msg.cleanContent : msg.content || '');
  clean = clean.replace(new RegExp('@' + escapeRe(botName), 'ig'), '').trim();
  for (const a of msg.attachments ? Array.from(msg.attachments.values ? msg.attachments.values() : []) : []) {
    clean += ` [attachment: ${a.name || 'file'}]`;
  }
  clean = clean.trim();
  if (!clean) return;

  const name = (msg.member && msg.member.displayName) || msg.author.globalName || msg.author.username || 'someone';
  const scope = 'discord:' + channelId;
  const speaker = { key: 'discord:' + msg.author.id, name, owner };

  const cmd = /^z\.(\w+)\s*([\s\S]*)$/i.exec(clean);
  if (cmd) {
    const reply = await handleCommand(msg, cmd[1].toLowerCase(), cmd[2].trim(), owner);
    if (reply) await send(msg, reply);
    return;
  }

  const mentioned = !!(msg.mentions && typeof msg.mentions.has === 'function' && botId && msg.mentions.has(botId, { ignoreEveryone: true, ignoreRoles: true }));
  const repliedToMe = !!(msg.mentions && msg.mentions.repliedUser && botId && msg.mentions.repliedUser.id === botId);
  const nameHit = new RegExp('\\b' + escapeRe(c.name) + '\\b', 'i').test(clean);
  const addressed = isDM || mentioned || repliedToMe || nameHit;

  if (!addressed) {
    if (home && c.discord.passive) {
      brain.note({ surface: 'discord', scope, key: speaker.key, name, text: clean });
      scheduleAmbient(msg, channelId, scope);
    }
    return;
  }

  if (!owner && !allowed(msg.author.id)) return;

  const stop = startTyping(msg.channel);
  try {
    const r = await brain.respond({ surface: 'discord', scope, speaker, text: clean, context: { place: placeOf(msg) } });
    if (!r.silent && r.text) await send(msg, r.text);
  } catch (e) {
    const now = Date.now();
    if (now - (lastFail.get(channelId) || 0) > 60000) {
      lastFail.set(channelId, now);
      await send(msg, brainDownText(e)).catch(() => {});
    }
  } finally {
    stop();
  }
}

/* ---------- ambient chime-ins and free will ---------- */

function scheduleAmbient(msg, channelId, scope) {
  const chime = brain.cfg().discord.chime;
  if (!chime || chime <= 0) return;
  clearTimeout(ambientTimers.get(channelId));
  ambientTimers.set(
    channelId,
    setTimeout(async () => {
      ambientTimers.delete(channelId);
      try {
        if (Date.now() - (lastSent.get(channelId) || 0) < 45000) return;
        if (Math.random() > brain.cfg().discord.chime) return;
        const r = await brain.respond({ surface: 'discord', scope, kind: 'react', mode: 'ambient', speaker: {}, context: { place: placeOf(msg) } });
        if (!r.silent && r.text) {
          for (const part of split(r.text)) await msg.channel.send({ content: part, allowedMentions: { parse: [] } });
          lastSent.set(channelId, Date.now());
        }
      } catch (e) {
        /* stay quiet on failures */
      }
    }, 5000)
  );
}

async function freewillTick() {
  const d = brain.cfg().discord;
  if (!client || !d.freewill || !d.homeChannels.length) return;
  const now = Date.now();
  if (now - lastFreewill < d.freewillMinutes * 60000) return;
  lastFreewill = now;
  const channels = d.homeChannels.slice().sort(() => Math.random() - 0.5);
  for (const id of channels) {
    if (now - (lastSent.get(id) || 0) < d.freewillGapMinutes * 60000) continue;
    const scope = 'discord:' + id;
    const last = brain.recent(scope, 1)[0];
    if (last && last.r === 'z' && now - last.ts < 3 * 3600000) continue; // do not talk to yourself
    try {
      const ch = await client.channels.fetch(id);
      if (!ch || typeof ch.send !== 'function') continue;
      const r = await brain.respond({ surface: 'discord', scope, kind: 'freewill', mode: 'ambient', speaker: {}, context: { place: ch.guild ? `server "${ch.guild.name}" #${ch.name}` : '' } });
      if (!r.silent && r.text) {
        for (const part of split(r.text)) await ch.send({ content: part, allowedMentions: { parse: [] } });
        lastSent.set(id, Date.now());
      }
    } catch (e) {
      /* try again next tick */
    }
    return; // at most one channel per tick
  }
}

function updatePresence() {
  if (!client || !client.user || !Discord) return;
  const r = brain.robloxStatus();
  const text = r.online ? (r.game ? 'Roblox: ' + r.game : 'Roblox') : 'chatting with chat';
  try {
    client.user.setPresence({ activities: [{ name: text.slice(0, 100), type: Discord.ActivityType.Playing }], status: 'online' });
  } catch (e) {
    /* ignore */
  }
}

function start() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    state.error = 'DISCORD_BOT_TOKEN is not set.';
    return null;
  }
  state.enabled = true;
  if (!Discord) {
    state.error = 'discord.js is not installed.';
    return null;
  }
  const { Client, GatewayIntentBits, Partials, Events } = Discord;
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel, Partials.Message],
  });
  client.once(Events.ClientReady, () => {
    botId = client.user.id;
    state.online = true;
    state.tag = client.user.tag;
    state.guilds = client.guilds.cache.size;
    state.error = '';
    updatePresence();
    setInterval(updatePresence, 60000);
    setInterval(() => freewillTick().catch(() => {}), 60000);
    console.log('[discord] logged in as', client.user.tag);
  });
  client.on(Events.MessageCreate, (m) => handleMessage(m).catch((e) => console.error('[discord] handler error:', e.message)));
  client.on(Events.Error, (e) => {
    state.error = e.message;
  });
  client.on(Events.ShardDisconnect, () => {
    state.online = false;
  });
  client.on(Events.ShardResume, () => {
    state.online = true;
  });
  client.login(token).catch((e) => {
    state.error = e.message;
    console.error('[discord] login failed:', e.message);
  });
  return client;
}

function status() {
  return Object.assign({}, state, { guilds: client && client.guilds ? client.guilds.cache.size : state.guilds, homeChannels: brain.cfg().discord.homeChannels.length });
}

async function stop() {
  try {
    if (client) await client.destroy();
  } catch (e) {
    /* ignore */
  }
}

module.exports = { start, stop, status, handleMessage, _setBotId: (id) => (botId = id) };
