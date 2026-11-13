'use strict';
/*
 * Zene's Discord side. Talks when addressed (mention, reply, DM, or her name), can quietly read her home
 * channels, may chime in or speak on her own ("free will") when you turn that on, and relays
 * z.say / z.order to the Roblox script. Everything goes through the same brain as the website and Roblox.
 *
 * She can also: look at pictures and videos (vision.js), use custom emojis, react to messages by mood or
 * by choice, send pictures from her library or draw one (draw.js), and be steered in secret with the
 * owner-only /zene slash command (replies only you can see).
 */
const brain = require('./brain');
const media = require('./media');
const vision = require('./vision');
const drawing = require('./draw');

let Discord = null;
try {
  Discord = require('discord.js');
} catch (e) {
  Discord = null;
}

const state = { enabled: false, online: false, tag: '', guilds: 0, error: '', invite: '', slash: { registered: 0, error: '' } };
let client = null;
let botId = null;

const userHits = new Map(); // userId -> [timestamps]
const lastSent = new Map(); // channelId -> ts of Zene's last message
const lastFail = new Map(); // channelId -> ts of last "brain is down" notice
const lastVisual = new Map(); // channelId -> ts of her last picture
const lastReactAsk = new Map(); // channelId -> ts of her last "should I react?" thought
const drawHits = new Map(); // userId -> [timestamps]
const reactTimes = []; // timestamps of recent reactions
const reactAsks = []; // timestamps of recent "should I react?" model calls
const ambientTimers = new Map();
let lastFreewill = 0;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

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

/*
 * Sends text (and optionally files). Her :emoji: names become real custom emojis here.
 * msg: a message to reply to, or a bare { channel } to just post.
 */
async function send(msg, text, extra) {
  const files = extra && extra.files && extra.files.length ? extra.files : null;
  const plain = !!(extra && extra.plain);
  const parts = text ? split(media.resolveText(text)) : [];
  if (!parts.length && files) parts.push('');
  const opts = { allowedMentions: { parse: [], repliedUser: false } };
  for (let i = 0; i < parts.length; i++) {
    const payload = Object.assign({}, opts);
    if (parts[i]) payload.content = parts[i];
    if (i === 0 && files) payload.files = files;
    const canReply = i === 0 && !plain && msg.guild && typeof msg.reply === 'function';
    try {
      if (canReply) await msg.reply(payload);
      else await msg.channel.send(payload);
    } catch (e) {
      if (!files || i !== 0) throw e;
      // no permission to attach files here: say the words anyway
      delete payload.files;
      if (!payload.content) throw e;
      if (canReply) await msg.reply(payload);
      else await msg.channel.send(payload);
    }
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

/* ---------- reactions ---------- */

async function doReact(msg, arg) {
  if (!msg || typeof msg.react !== 'function') return 0;
  const now = Date.now();
  while (reactTimes.length && now - reactTimes[0] > 60000) reactTimes.shift();
  if (reactTimes.length >= 10) return 0; // never spam the API
  let n = 0;
  for (const r of media.resolveReactions(arg, 2)) {
    try {
      await msg.react(r.unicode || media.emojiString(r.custom));
      if (r.custom) media.bumpUse(r.custom.id);
      reactTimes.push(Date.now());
      n++;
      await sleep(350);
    } catch (e) {
      /* missing permission, or an emoji that no longer exists: skip it */
    }
  }
  return n;
}

// She is reading a home channel. Mood and a coin flip decide whether she even thinks about reacting;
// then one small model call decides yes or no, and which emoji.
function maybeReactAmbient(msg, name, text, owner) {
  const d = brain.cfg().discord;
  if (!d.reactions || typeof msg.react !== 'function') return;
  if (String(text).replace(/\[attachment:[^\]]*\]/g, '').trim().length < 4 && !/\[attachment:/.test(text)) return;
  const ch = msg.channelId || (msg.channel && msg.channel.id);
  const now = Date.now();
  if (now - (lastReactAsk.get(ch) || 0) < 20000) return;
  while (reactAsks.length && now - reactAsks[0] > 600000) reactAsks.shift();
  if (reactAsks.length >= 12) return;
  if (Math.random() >= brain.reactChance(owner)) return;
  lastReactAsk.set(ch, now);
  reactAsks.push(now);
  setTimeout(async () => {
    try {
      const args = await brain.decideReaction({ name, text });
      if (args.length) await doReact(msg, args.join(' '));
    } catch (e) {
      /* stay quiet */
    }
  }, 700 + Math.floor(Math.random() * 2500));
}

/* ---------- pictures she sends ---------- */

async function imageFile(img) {
  if (img.kind === 'vault') {
    if (!client) return null;
    const ch = await client.channels.fetch(img.channelId);
    const m = await ch.messages.fetch(img.messageId);
    const a = m.attachments && m.attachments.first ? m.attachments.first() : null;
    if (!a) return null;
    return { files: [{ attachment: a.url, name: a.name || img.name || 'zene.png' }] };
  }
  if (/\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(img.url)) return { files: [{ attachment: img.url, name: (img.name || 'zene') + '' }] };
  return { link: img.url }; // not a plain picture file: a link lets Discord make its own preview
}

function visualAllowed(msg, type) {
  const ch = msg.channelId || (msg.channel && msg.channel.id);
  const now = Date.now();
  if (now - (lastVisual.get(ch) || 0) < (type === 'draw' ? 60000 : 30000)) return false;
  if (type === 'draw') {
    const uid = msg.author && msg.author.id;
    if (!(uid && brain.isOwnerDiscord(uid))) {
      const a = (drawHits.get(uid || 'x') || []).filter((t) => now - t < 15 * 60000);
      if (a.length >= 3) return false;
      a.push(now);
      drawHits.set(uid || 'x', a);
    }
  }
  return true;
}

// -> { files, link } or null
async function prepareVisual(a) {
  const d = brain.cfg().discord;
  if (a.type === 'image') {
    if (!d.images) return null;
    const img = media.findImage(a.arg);
    if (!img) return null;
    const f = await imageFile(img);
    if (f) media.bumpImage(img.id);
    return f;
  }
  if (a.type === 'draw') {
    if (!d.draw || !drawing.enabled()) return null;
    const out = await drawing.draw(a.arg);
    return { files: [{ attachment: out.buffer, name: out.name }] };
  }
  return null;
}

/*
 * Turns what the brain returned into Discord actions: her words, one picture, and reactions.
 * msg is the message she is answering (reactions go on it). o.plain posts without replying.
 */
async function deliver(msg, r, o) {
  o = o || {};
  const actions = (r && r.actions) || [];
  let extra = { plain: !!o.plain };
  let link = '';
  const visual = actions.find((a) => a.type === 'image' || a.type === 'draw');
  if (visual && visualAllowed(msg, visual.type)) {
    try {
      const v = await prepareVisual(visual);
      if (v) {
        if (v.files) extra.files = v.files;
        if (v.link) link = v.link;
        lastVisual.set(msg.channelId || msg.channel.id, Date.now());
      }
    } catch (e) {
      /* the picture failed (service down, library entry gone): carry on with words */
    }
  }
  const text = [r && !r.silent ? r.text : '', link].filter(Boolean).join('\n');
  if (text || extra.files) await send(msg, text, extra);
  if (!o.noReact) for (const a of actions) if (a.type === 'react') await doReact(msg, a.arg);
}

/* ---------- invite link ---------- */

function invitePerms() {
  const P = Discord.PermissionFlagsBits;
  return [P.ViewChannel, P.SendMessages, P.SendMessagesInThreads, P.ReadMessageHistory, P.AddReactions, P.EmbedLinks, P.AttachFiles, P.UseExternalEmojis, P.CreateGuildExpressions].filter((x) => x !== undefined);
}

function inviteUrl() {
  if (!client || !client.application || !Discord) return '';
  try {
    return client.generateInvite({ scopes: [Discord.OAuth2Scopes.Bot, Discord.OAuth2Scopes.ApplicationsCommands], permissions: invitePerms() });
  } catch (e) {
    return '';
  }
}

function syncEmojis() {
  if (!client || !client.emojis) return;
  try {
    media.setGuildEmojis(Array.from(client.emojis.cache.values()).map((e) => ({ id: e.id, name: e.name, animated: e.animated, guild: e.guild && e.guild.name })));
  } catch (e) {
    /* ignore */
  }
}

/* ---------- prefix commands ---------- */

const HELP = [
  'talk to me by mentioning me, replying to me, saying my name, or in DMs. send me pictures or videos and i will look.',
  'z.mood: how i feel right now',
  'z.status: what i am doing in Roblox',
  'owner only: z.say <text> (i say it in Roblox), z.order <text> (i get it as an order in Roblox), z.learn <title> | <text>, z.home (toggle this channel as a home channel), z.freewill on|off, z.forget (wipe my memory of this channel)',
  'owner only: z.emoji list|add|meaning|remove|steal, z.image list|add|remove|send|vault, z.toggle reactions|vision|images|draw on|off, z.invite',
  'owner only, and invisible: the /zene slash command (say, react, image, draw, do, roblox, mood, status).',
].join('\n');

const ON = /^(on|true|yes|1)$/i;

async function emojiCommand(msg, arg) {
  const [subRaw, ...restArr] = arg.trim().split(/\s+/);
  const sub = (subRaw || 'list').toLowerCase();
  const rest = restArr.join(' ');
  const [left, ...after] = rest.split('|');
  const meaning = after.join('|').trim();
  const custom = media.parseCustom(rest);
  switch (sub) {
    case 'list': {
      const all = media.allEmojis();
      if (!all.length) return 'no custom emojis yet. add some with z.emoji add <:name:id> | what it means, or just use some in chat and i will pick them up.';
      const saved = all.filter((e) => e.source !== 'server').length;
      return `i know ${all.length} custom emoji${all.length === 1 ? '' : 's'} (${saved} saved, ${all.length - saved} from my servers): ` + all.slice(0, 30).map((e) => media.emojiString(e)).join(' ');
    }
    case 'add': {
      if (!custom.length) return 'use: z.emoji add <:name:id> | what it means. (paste the emoji itself; i need to see its id.)';
      let n = 0;
      for (const e of custom) {
        const lib = media.learnEmoji(e, 'owner');
        if (lib && meaning) media.setEmojiMeaning(media.emojiString(e), meaning);
        n++;
      }
      return `added ${n} emoji${n === 1 ? '' : 's'}${meaning ? ' (meaning: ' + meaning + ')' : ''}. i can use ${n === 1 ? 'it' : 'them'} anywhere, as long as i have Use External Emojis there.`;
    }
    case 'meaning': {
      const name = left.trim().split(/\s+/)[0];
      if (!name || !meaning) return 'use: z.emoji meaning <name> | what it means';
      try {
        media.setEmojiMeaning(name, meaning);
        return 'got it.';
      } catch (e) {
        return e.message;
      }
    }
    case 'remove': {
      const ref = custom[0] ? media.emojiString(custom[0]) : rest.trim().split(/\s+/)[0];
      return media.removeEmoji(ref) ? 'removed from my library.' : 'i do not have that one saved.';
    }
    case 'steal': {
      if (!msg.guild || !msg.guild.emojis) return 'run this in a server.';
      const att = msg.attachments && msg.attachments.values ? Array.from(msg.attachments.values())[0] : null;
      let url = '';
      let name = '';
      if (custom[0]) {
        url = `https://cdn.discordapp.com/emojis/${custom[0].id}.${custom[0].animated ? 'gif' : 'png'}?size=128`;
        name = rest.replace(/<a?:[^>]+>/g, '').trim().split(/\s+/)[0] || custom[0].name;
      } else if (att) {
        url = att.url;
        name = rest.trim().split(/\s+/)[0] || String(att.name || 'emoji').replace(/\.\w+$/, '');
      } else return 'use: z.emoji steal <:name:id> [new name]   or attach a picture and use: z.emoji steal <name>';
      name = name.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32);
      if (name.length < 2) name = 'zene_' + name;
      try {
        const e = await msg.guild.emojis.create({ attachment: url, name });
        media.learnEmoji({ id: e.id, name: e.name, animated: e.animated }, 'owner');
        syncEmojis();
        return `made ${e.toString()} in this server.`;
      } catch (e) {
        return /permission|Missing/i.test(e.message) ? 'i cannot add emojis here. i need the Create Expressions permission (re-invite me with z.invite).' : 'that did not work: ' + clip(e.message, 120);
      }
    }
    default:
      return 'z.emoji list | add <:emoji:> | meaning <name> | what | remove <name> | steal <:emoji:> [name]';
  }
}

async function imageCommand(msg, arg) {
  const [subRaw, ...restArr] = arg.trim().split(/\s+/);
  const sub = (subRaw || 'list').toLowerCase();
  const rest = restArr.join(' ');
  switch (sub) {
    case 'list': {
      const imgs = media.listImages();
      const vault = media.getVault();
      return (imgs.length ? `my pictures (${imgs.length}): ` + imgs.map((i) => i.tag).join(', ') : 'no pictures yet. attach one and use: z.image add <tag> <what it is>') + (vault ? '' : '\ntip: make a private channel, go there, and type z.image vault so my pictures are kept safely.');
    }
    case 'vault': {
      const ch = msg.channelId || msg.channel.id;
      if (media.getVault() === ch) {
        media.setVault('');
        return 'this is not my vault anymore. pictures already saved stay where they are.';
      }
      media.setVault(ch);
      return 'this channel is my vault now. i keep copies of the pictures you add here. keep it private and do not delete things in it.';
    }
    case 'remove': {
      return media.removeImage(rest.trim().split(/\s+/)[0]) ? 'removed.' : 'no picture with that tag.';
    }
    case 'send': {
      const img = media.findImage(rest.trim().split(/\s+/)[0]);
      if (!img) return 'no picture with that tag.';
      const f = await imageFile(img);
      if (!f) return 'i could not load that picture. it may have been deleted from my vault.';
      await send(msg, f.link || '', { files: f.files, plain: false });
      return null;
    }
    case 'add': {
      const words = rest.trim().split(/\s+/).filter(Boolean);
      const tag = words.shift();
      if (!tag) return 'use: z.image add <tag> <short description>, with a picture attached (or a https link).';
      const urlIdx = words.findIndex((w) => /^https:\/\/\S+$/i.test(w));
      const link = urlIdx >= 0 ? words.splice(urlIdx, 1)[0] : '';
      let desc = words.join(' ');
      const att = msg.attachments && msg.attachments.values ? Array.from(msg.attachments.values()).find((a) => /^image\//i.test(a.contentType || '') || /\.(png|jpe?g|gif|webp)$/i.test(a.name || '')) : null;
      if (!att && !link) return 'attach a picture to that message, or paste a https link to one.';
      let entry;
      try {
        if (att) {
          const vaultId = media.getVault();
          let channelId = msg.channelId || msg.channel.id;
          let messageId = msg.id;
          if (vaultId && client) {
            const vault = await client.channels.fetch(vaultId);
            const sent = await vault.send({ content: `saved as "${media.cleanTag(tag)}"`, files: [{ attachment: att.url, name: att.name || 'zene.png' }] });
            channelId = vault.id;
            messageId = sent.id;
          }
          if (!desc && vision && brain.cfg().discord.vision) {
            try {
              desc = (await vision.describeImages([{ id: att.id, url: att.url, proxyUrl: att.proxyURL }])).slice(0, 90);
            } catch (e) {
              /* fine without */
            }
          }
          entry = media.addImage({ tag, desc, kind: 'vault', channelId, messageId, name: att.name });
          return `saved "${entry.tag}".` + (vaultId ? '' : ' i am pointing at your message, so do not delete it. (z.image vault in a private channel keeps my own copy.)');
        }
        entry = media.addImage({ tag, desc, kind: 'url', url: link });
        return `saved "${entry.tag}".`;
      } catch (e) {
        return e.message;
      }
    }
    default:
      return 'z.image list | add <tag> <description> (attach a picture) | remove <tag> | send <tag> | vault';
  }
}

async function handleCommand(msg, cmd, arg, owner) {
  const ownerName = brain.cfg().ownerName;
  const ownerOnly = ['say', 'order', 'learn', 'home', 'freewill', 'forget', 'emoji', 'image', 'toggle', 'invite'];
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
      const on = ON.test(arg.trim());
      brain.updateConfig({ discord: { freewill: on } });
      return on ? 'free will on. i might talk on my own in home channels.' : 'free will off.';
    }
    case 'forget': {
      const n = brain.wipeMemory({ scope: 'discord:' + channelId });
      return `forgot ${n} messages from this channel.`;
    }
    case 'emoji':
      return emojiCommand(msg, arg);
    case 'image':
      return imageCommand(msg, arg);
    case 'toggle': {
      const [what, val] = arg.trim().split(/\s+/);
      const key = { reactions: 'reactions', reaction: 'reactions', vision: 'vision', images: 'images', image: 'images', draw: 'draw', drawing: 'draw' }[String(what || '').toLowerCase()];
      if (!key || !val) return 'use: z.toggle reactions|vision|images|draw on|off';
      brain.updateConfig({ discord: { [key]: ON.test(val) } });
      return `${key} ${ON.test(val) ? 'on' : 'off'}.`;
    }
    case 'invite': {
      const u = inviteUrl();
      return u ? 'use this link to re-authorize me with everything i need (reactions, pictures, external emojis, the /zene command). pick this server and press Authorise:\n' + u : 'i am not fully started yet. try again in a minute.';
    }
    default:
      return null;
  }
}

/* ---------- what came with a message ---------- */

const IMG_EXT = /\.(png|jpe?g|webp|gif)(\?|$)/i;
const VID_EXT = /\.(mp4|mov|webm|mkv|m4v)(\?|$)/i;

function collectMedia(msg) {
  const items = [];
  const push = (x) => {
    if (items.length < 6) items.push(x);
  };
  const atts = msg.attachments && msg.attachments.values ? Array.from(msg.attachments.values()) : [];
  for (const a of atts) {
    const ct = String(a.contentType || '').toLowerCase();
    const nm = String(a.name || '');
    if (/^image\/(png|jpe?g|webp|gif)/.test(ct) || (!ct && IMG_EXT.test(nm))) push({ kind: 'image', id: a.id, url: a.url, proxyUrl: a.proxyURL, name: nm, size: a.size });
    else if (/^video\//.test(ct) || (!ct && VID_EXT.test(nm))) push({ kind: 'video', id: a.id, url: a.url, proxyUrl: a.proxyURL, name: nm, size: a.size });
  }
  const stickers = msg.stickers && msg.stickers.values ? Array.from(msg.stickers.values()) : [];
  for (const s of stickers) {
    if ([1, 2, 4].includes(s.format) && s.url) push({ kind: 'image', id: 'st' + s.id, url: s.url, name: s.name });
    else push({ kind: 'note', note: `A sticker called "${clip(s.name, 40)}".` });
  }
  for (const e of msg.embeds || []) {
    const th = e.image || e.thumbnail;
    const u = th && (th.proxyURL || th.url);
    if (u) push({ kind: 'image', id: 'em' + u, url: u, proxyUrl: th.proxyURL || null, name: 'preview' });
    const label = [e.provider && e.provider.name, e.title].filter(Boolean).join(': ');
    if (label) push({ kind: 'note', note: `A link preview was attached: ${clip(label.replace(/\s+/g, ' '), 110)}.` });
  }
  return items;
}

function mediaMarkers(msg) {
  const atts = msg.attachments && msg.attachments.values ? Array.from(msg.attachments.values()) : [];
  return atts.map((a) => ` [attachment: ${a.name || 'file'}]`).join('');
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

  // custom emojis she sees people use become hers to use
  for (const e of media.parseCustom(msg.content || '')) {
    try {
      media.learnEmoji(e, 'seen');
    } catch (err) {
      /* library full of saved ones */
    }
  }

  let text = String(msg.cleanContent != null ? msg.cleanContent : msg.content || '');
  text = text.replace(new RegExp('@' + escapeRe(botName), 'ig'), '').trim();
  const markers = mediaMarkers(msg);
  let clean = (text + markers).trim();
  const hasStickers = !!(msg.stickers && msg.stickers.size);
  if (!clean && hasStickers) clean = '[sticker]';
  if (!clean) return;

  const name = (msg.member && msg.member.displayName) || msg.author.globalName || msg.author.username || 'someone';
  const scope = 'discord:' + channelId;
  const speaker = { key: 'discord:' + msg.author.id, name, owner };

  const cmd = /^z\.(\w+)\s*([\s\S]*)$/i.exec(text);
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
      maybeReactAmbient(msg, name, clean, owner);
    }
    return;
  }

  if (!owner && !allowed(msg.author.id)) return;

  const stop = startTyping(msg.channel);
  try {
    // link previews (GIFs, videos) arrive a moment after the message does
    if (!msg.attachments?.size && !(msg.embeds && msg.embeds.length) && /https?:\/\//i.test(text) && typeof msg.fetch === 'function' && c.discord.vision) {
      await sleep(1500);
      try {
        const fresh = await msg.fetch();
        if (fresh && fresh.embeds) msg.embeds = fresh.embeds;
      } catch (e) {
        /* fine without previews */
      }
    }
    let seen = '';
    if (c.discord.vision) {
      const items = collectMedia(msg);
      const lookable = items.filter((i) => i.kind !== 'note');
      if (lookable.length) seen = (await vision.look(items, { owner })).seen;
      else seen = items.map((i) => i.note).join(' ');
    }
    const r = await brain.respond({ surface: 'discord', scope, speaker, text: clean, seen, canReact: true, context: { place: placeOf(msg) } });
    await deliver(msg, r);
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
        const r = await brain.respond({ surface: 'discord', scope, kind: 'react', mode: 'ambient', speaker: {}, canReact: true, context: { place: placeOf(msg) } });
        await deliver(msg, r, { plain: true });
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
      const r = await brain.respond({ surface: 'discord', scope, kind: 'freewill', mode: 'ambient', speaker: {}, canReact: false, context: { place: ch.guild ? `server "${ch.guild.name}" #${ch.name}` : '' } });
      await deliver({ channel: ch, channelId: id }, r, { plain: true, noReact: true });
    } catch (e) {
      /* try again next tick */
    }
    return; // at most one channel per tick
  }
}

/* ---------- the secret /zene command ---------- */

function slashDefinition() {
  const { SlashCommandBuilder, PermissionFlagsBits, ChannelType, InteractionContextType } = Discord;
  const chan = (o) =>
    o
      .setName('channel')
      .setDescription('Another channel (default: the one you are in)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread);
  const b = new SlashCommandBuilder().setName('zene').setDescription('Steer Zene in secret (owner only)');
  // hidden from everyone but server admins in the command picker; the owner check below is the real lock
  if (process.env.SLASH_PUBLIC !== '1') b.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
  if (InteractionContextType) b.setContexts(InteractionContextType.Guild);
  b.addSubcommand((s) =>
    s
      .setName('say')
      .setDescription('Make Zene say something')
      .addStringOption((o) => o.setName('text').setDescription('Exactly what she says').setRequired(true).setMaxLength(1900))
      .addChannelOption(chan)
      .addStringOption((o) => o.setName('reply_to').setDescription('Message link or ID to reply to'))
      .addAttachmentOption((o) => o.setName('file').setDescription('A picture or file for her to send'))
  );
  b.addSubcommand((s) =>
    s
      .setName('react')
      .setDescription('Make Zene react to a message')
      .addStringOption((o) => o.setName('message').setDescription('Message link or ID').setRequired(true))
      .addStringOption((o) => o.setName('emoji').setDescription('An emoji, :name:, or leave empty and she picks').setRequired(false))
      .addChannelOption(chan)
  );
  b.addSubcommand((s) =>
    s
      .setName('image')
      .setDescription('Make Zene send a picture from her library')
      .addStringOption((o) => o.setName('tag').setDescription('Which picture').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('caption').setDescription('Words to send with it').setMaxLength(1500))
      .addChannelOption(chan)
  );
  b.addSubcommand((s) =>
    s
      .setName('draw')
      .setDescription('Make Zene draw something')
      .addStringOption((o) => o.setName('prompt').setDescription('What to draw').setRequired(true).setMaxLength(240))
      .addChannelOption(chan)
  );
  b.addSubcommand((s) =>
    s
      .setName('do')
      .setDescription('Give Zene a private instruction; she does it in her own words')
      .addStringOption((o) => o.setName('instruction').setDescription('For example: ask chat what they are playing').setRequired(true).setMaxLength(500))
      .addChannelOption(chan)
  );
  b.addSubcommand((s) =>
    s
      .setName('roblox')
      .setDescription('Send her a line or an order in Roblox')
      .addStringOption((o) => o.setName('text').setDescription('What to say or do').setRequired(true).setMaxLength(400))
      .addStringOption((o) => o.setName('mode').setDescription('say = she says it, order = she is told to do it').addChoices({ name: 'say', value: 'say' }, { name: 'order', value: 'order' }))
  );
  b.addSubcommand((s) =>
    s
      .setName('mood')
      .setDescription('Change her mood')
      .addStringOption((o) =>
        o
          .setName('mood')
          .setDescription('How she feels')
          .setRequired(true)
          .addChoices(...brain.MOODS.map((m) => ({ name: m, value: m })))
      )
  );
  b.addSubcommand((s) => s.setName('status').setDescription('What she can do right now (only you see this)'));
  return b;
}

async function registerSlash(onlyGuild) {
  if (!client || !Discord || process.env.SLASH_COMMANDS === 'off') return;
  const def = slashDefinition().toJSON();
  const guilds = onlyGuild ? [onlyGuild] : Array.from(client.guilds.cache.values());
  let ok = 0;
  let lastErr = '';
  for (const g of guilds) {
    try {
      await g.commands.set([def]);
      ok++;
    } catch (e) {
      lastErr = e && e.code === 50001 ? 'Discord says she is missing access to add commands. Re-authorize her with the newest invite link (z.invite, or the Discord tab in the dashboard).' : (e && e.message) || 'unknown error';
    }
  }
  state.slash = { registered: onlyGuild ? Math.max(state.slash.registered, ok) : ok, error: ok ? (lastErr ? 'Some servers failed: ' + lastErr : '') : lastErr };
}

function ephemeral() {
  return Discord && Discord.MessageFlags ? Discord.MessageFlags.Ephemeral : 64;
}

async function targetChannel(i) {
  const ch = i.options.getChannel('channel');
  if (!ch) return i.channel;
  if (typeof ch.send === 'function') return ch;
  return client.channels.fetch(ch.id);
}

// "https://discord.com/channels/1/2/3", or just an ID in the current channel
async function fetchMessage(ch, ref) {
  const link = /channels\/(?:\d+|@me)\/(\d+)\/(\d+)/.exec(String(ref));
  if (link) {
    const c2 = link[1] === ch.id ? ch : await client.channels.fetch(link[1]);
    return c2.messages.fetch(link[2]);
  }
  const id = /(\d{15,25})\s*$/.exec(String(ref));
  if (!id) throw new Error('i could not read that message link or ID');
  return ch.messages.fetch(id[1]);
}

async function runSlash(i) {
  const sub = i.options.getSubcommand();
  const c = brain.cfg();
  switch (sub) {
    case 'say': {
      const ch = await targetChannel(i);
      const text = i.options.getString('text', true);
      const file = i.options.getAttachment ? i.options.getAttachment('file') : null;
      const replyTo = i.options.getString('reply_to');
      const payload = { content: media.resolveText(text).slice(0, 2000), allowedMentions: { parse: ['users'], repliedUser: false } };
      if (file) payload.files = [{ attachment: file.url, name: file.name }];
      const sent = replyTo ? await (await fetchMessage(ch, replyTo)).reply(payload) : await ch.send(payload);
      brain.remember({ surface: 'discord', scope: 'discord:' + ch.id, key: 'zene', name: c.name, role: 'z', text });
      lastSent.set(ch.id, Date.now());
      return 'sent.' + (sent && sent.url ? ' ' + sent.url : '');
    }
    case 'react': {
      const ch = await targetChannel(i);
      const m = await fetchMessage(ch, i.options.getString('message', true));
      let emoji = i.options.getString('emoji');
      if (!emoji) {
        const args = await brain.decideReaction({ name: (m.member && m.member.displayName) || (m.author && m.author.username) || 'someone', text: m.cleanContent || m.content || '' });
        emoji = args.join(' ');
        if (!emoji) return 'she looked at it and did not feel like reacting. give me an emoji if you want one anyway.';
      }
      const n = await doReact(m, emoji);
      return n ? 'reacted.' : 'i could not use that emoji (unknown, or i lack permission to react or use external emojis).';
    }
    case 'image': {
      const ch = await targetChannel(i);
      const img = media.findImage(i.options.getString('tag', true));
      if (!img) return 'no picture with that tag. z.image list shows them.';
      const f = await imageFile(img);
      if (!f) return 'i could not load that picture. it may have been deleted from my vault.';
      const caption = [i.options.getString('caption') ? media.resolveText(i.options.getString('caption')) : '', f.link || ''].filter(Boolean).join('\n');
      const payload = { allowedMentions: { parse: [] } };
      if (caption) payload.content = caption;
      if (f.files) payload.files = f.files;
      await ch.send(payload);
      media.bumpImage(img.id);
      lastSent.set(ch.id, Date.now());
      return 'sent.';
    }
    case 'draw': {
      if (!drawing.enabled()) return 'drawing is switched off (IMAGE_GEN=off).';
      const ch = await targetChannel(i);
      const out = await drawing.draw(i.options.getString('prompt', true));
      await ch.send({ files: [{ attachment: out.buffer, name: out.name }], allowedMentions: { parse: [] } });
      lastSent.set(ch.id, Date.now());
      return 'sent.';
    }
    case 'do': {
      const ch = await targetChannel(i);
      const scope = 'discord:' + ch.id;
      const r = await brain.respond({
        surface: 'discord',
        scope,
        kind: 'direct',
        text: i.options.getString('instruction', true),
        speaker: {},
        canReact: false,
        context: { place: ch.guild ? `server "${ch.guild.name}" #${ch.name}` : '' },
      });
      await deliver({ channel: ch, channelId: ch.id, guild: ch.guild }, r, { plain: true, noReact: true });
      return 'done. she said: ' + clip(r.text || '(a picture only)', 300);
    }
    case 'roblox': {
      const mode = i.options.getString('mode') === 'order' ? 'order' : 'say';
      brain.pushOutbox(mode, i.options.getString('text', true), 'discord');
      return mode === 'order' ? 'order sent to Roblox.' : 'queued. she will say it in Roblox.';
    }
    case 'mood': {
      brain.setMood(i.options.getString('mood', true));
      return 'mood set to ' + brain.getMood().name + '.';
    }
    case 'status': {
      const r = brain.robloxStatus();
      const v = require('./ai').visionStatus();
      const mc = media.counts();
      const d = c.discord;
      return [
        `mood: ${brain.getMood().name}`,
        `roblox: ${r.online ? 'in ' + (r.game || 'a game') : 'offline'}`,
        `emojis: ${mc.emojis} saved, ${mc.serverEmojis} from servers`,
        `pictures: ${mc.images} (vault ${mc.vault ? 'set' : 'not set'})`,
        `vision: ${d.vision ? (v.available ? 'on, model ready' : 'on, but no picture model is available') : 'off'}; video: ${vision.canWatchVideo() ? 'frames via ffmpeg' : 'first-frame only'}`,
        `reactions: ${d.reactions ? 'on (' + Math.round(brain.reactChance(false) * 100) + '% right now)' : 'off'}; images: ${d.images ? 'on' : 'off'}; draw: ${d.draw && drawing.enabled() ? 'on' : 'off'}`,
      ].join('\n');
    }
    default:
      return 'unknown subcommand.';
  }
}

async function handleInteraction(i) {
  if (!i) return;
  if (typeof i.isAutocomplete === 'function' && i.isAutocomplete()) {
    if (i.commandName !== 'zene' || !brain.isOwnerDiscord(i.user.id)) return i.respond([]).catch(() => {});
    const q = String(i.options.getFocused() || '').toLowerCase();
    const list = media
      .listImages()
      .filter((x) => !q || x.tag.includes(q))
      .slice(0, 25)
      .map((x) => ({ name: clip(x.tag + (x.desc ? ' - ' + x.desc : ''), 100), value: x.tag }));
    return i.respond(list).catch(() => {});
  }
  if (typeof i.isChatInputCommand !== 'function' || !i.isChatInputCommand() || i.commandName !== 'zene') return;
  const flags = ephemeral();
  if (!brain.isOwnerDiscord(i.user.id)) {
    return i.reply({ content: `that one is only for ${brain.cfg().ownerName}.`, flags }).catch(() => {});
  }
  try {
    await i.deferReply({ flags });
  } catch (e) {
    return;
  }
  let msg;
  try {
    msg = await runSlash(i);
  } catch (e) {
    const m = String((e && e.message) || e);
    msg = /Missing Permissions|Missing Access/i.test(m)
      ? 'i do not have permission to do that in that channel.'
      : e && e.code === 'NO_KEYS'
      ? 'my brain has no AI key yet.'
      : e && e.code === 'ALL_FAILED'
      ? 'my brain is busy or limited right now. try again in a little.'
      : 'that did not work: ' + clip(m, 200);
  }
  await i.editReply({ content: clip(msg, 1900) }).catch(() => {});
}

/* ---------- start / stop ---------- */

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

// Forgiving token read: accepts a few common variable names and cleans up
// the usual copy-paste slips (spaces, quotes, a leading "Bot ").
function readToken() {
  const raw = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || '';
  return String(raw).trim().replace(/^["']+|["']+$/g, '').replace(/^bot\s+/i, '').trim();
}

function start() {
  const token = readToken();
  if (!token) {
    state.error = 'DISCORD_BOT_TOKEN is not set in Render (Environment tab).';
    return null;
  }
  state.enabled = true;
  if (!Discord) {
    state.error = 'discord.js is not installed.';
    return null;
  }
  const { Client, GatewayIntentBits, Partials, Events } = Discord;
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages];
  const expr = GatewayIntentBits.GuildExpressions || GatewayIntentBits.GuildEmojisAndStickers;
  if (expr) intents.push(expr); // lets her notice emojis being added or removed in her servers
  client = new Client({ intents, partials: [Partials.Channel, Partials.Message] });
  client.once(Events.ClientReady, () => {
    botId = client.user.id;
    state.online = true;
    state.tag = client.user.tag;
    state.guilds = client.guilds.cache.size;
    state.error = '';
    state.invite = inviteUrl();
    syncEmojis();
    updatePresence();
    setInterval(updatePresence, 60000);
    setInterval(() => freewillTick().catch(() => {}), 60000);
    registerSlash().catch((e) => {
      state.slash.error = (e && e.message) || 'could not register /zene';
    });
    console.log('[discord] logged in as', client.user.tag);
  });
  client.on(Events.MessageCreate, (m) => handleMessage(m).catch((e) => console.error('[discord] handler error:', e.message)));
  client.on(Events.InteractionCreate, (i) => handleInteraction(i).catch((e) => console.error('[discord] interaction error:', e.message)));
  client.on(Events.GuildCreate, (g) => {
    syncEmojis();
    registerSlash(g).catch(() => {});
  });
  for (const ev of ['GuildEmojiCreate', 'GuildEmojiDelete', 'GuildEmojiUpdate', 'GuildDelete']) if (Events[ev]) client.on(Events[ev], syncEmojis);
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
  return Object.assign({}, state, {
    guilds: client && client.guilds ? client.guilds.cache.size : state.guilds,
    homeChannels: brain.cfg().discord.homeChannels.length,
    videoFrames: vision.canWatchVideo(),
    drawing: drawing.enabled(),
  });
}

async function stop() {
  try {
    if (client) await client.destroy();
  } catch (e) {
    /* ignore */
  }
}

module.exports = {
  start,
  stop,
  status,
  handleMessage,
  handleInteraction,
  slashDefinition: () => slashDefinition().toJSON(),
  _setBotId: (id) => (botId = id),
  _setClient: (c) => (client = c),
};
