# Zene

One AI, three places: a private website, Discord, and Roblox. She has a single shared memory, so something said in Roblox can come up on Discord later.

- **Website** (dashboard): chat with her, see and delete what she remembers, teach her facts, edit her personality, manage API keys and models.
- **Discord bot**: answers when mentioned, replied to, DMed or named. Can read home channels quietly, chime in, or speak on her own (all optional).
- **Roblox bridge** (`zene-roblox.lua`): answers when someone says her name in chat, tells the website what game she is in, and speaks lines or takes orders you send from the dashboard or Discord.

Everything runs on free tiers: Render (hosting), Groq (AI), Upstash (so she keeps her memory).

---

## Set it up from your phone

### 1. Get three free accounts

1. **Groq** (the AI): console.groq.com > API Keys > Create. Copy the key (starts with `gsk_`).
2. **Upstash** (her memory): upstash.com > Create database (Redis, free). On the database page find **REST API** and copy the **URL** and **Token**.
3. **GitHub** (to hold these files so Render can read them).

Without Upstash she forgets everything every time Render restarts, so do not skip it.

### 2. Put the files on GitHub

1. GitHub > New repository > name it `zene` > Private > Create.
2. Click **uploading an existing file**, select **all the files from this folder** (they are all in one folder on purpose, no subfolders), and Commit.

### 3. Create the web service on Render

1. render.com > New > **Web Service** > pick your `zene` repository.
2. Name: whatever you want your address to be. The name becomes `https://NAME.onrender.com`.
3. Runtime **Node**, Build command `npm install`, Start command `node server.js`, Instance type **Free**.
4. Under **Environment**, add the variables from `env.example.txt`. The minimum:

| Name | Value |
| --- | --- |
| `ADMIN_PASSWORD` | the password you will use to sign in |
| `GROQ_API_KEY` | your Groq key |
| `UPSTASH_REDIS_REST_URL` | from Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | from Upstash |
| `SESSION_SECRET` | any long random text |
| `GATEWAY_KEY` | any long random text, starting with `zk_` |

5. Create. When the deploy finishes, open your address and sign in.

Open **Brain > Backup**. It should say memory is saved to Upstash. If it warns about disk storage, the two Upstash variables are missing or wrong.

### 4. Connect Discord

1. discord.com/developers/applications > New Application > **Bot**.
2. **Reset Token** and copy it into Render as `DISCORD_BOT_TOKEN`.
3. On the same page turn on **Message Content Intent** (under Privileged Gateway Intents). Without it she cannot read messages.
4. OAuth2 > URL Generator: tick `bot`, then View Channels, Send Messages, Read Message History. Open the link it makes and add her to your server.
5. In Discord turn on Developer Mode (Settings > Advanced), long-press your own name, Copy User ID, and set it in Render as `OWNER_DISCORD_ID`. This makes you the owner for commands like `z.say`.

Talk to her by mentioning her, replying to her, saying "zene", or in DMs. Type `z.help` for commands. Type `z.home` in a channel to make it a home channel, where she can read along.

### 5. Connect Roblox

1. On the dashboard open the **Roblox** tab and tap **Copy both as script lines**.
2. Open `zene-roblox.lua` in Acode and replace the first two settings (`Url`, `Key`) with those lines.
3. Run it in Delta. The Roblox dot at the top of the dashboard turns green when it connects.

She answers when chat says `zene`, `sapphire`, `sofi` or `warmachine12908` (change the list in `Triggers`). From the dashboard's Roblox tab you can make her say something in chat, or send an order. Orders arrive in your Sapphire Zene script through `getgenv().ZeneBridge.OnOrder(function(text) ... end)`. The top of `zene-roblox.lua` shows the full list of functions your other script can call.

---

## Things worth knowing

- **Sleeping.** On Render's free plan the site sleeps after 15 quiet minutes and takes about 50 seconds to wake. The Roblox script keeps retrying quietly. A free pinger such as UptimeRobot on `https://NAME.onrender.com/healthz` every 5 minutes keeps it awake. One always-on free service fits inside Render's monthly free hours.
- **Rate limits.** Add more keys (Brain > Models) and she rotates through them. When one key or model is limited, the next answers. Dead models are dropped automatically.
- **Safety.** Nobody can sign in without your password. The Roblox gateway needs your `GATEWAY_KEY`, so keep it private. Backups never include API keys. Keys you add on the dashboard are stored in your own Upstash database; keys set in Render stay in Render.
- **Backups.** Brain > Backup > Download backup. Restore it from the same screen.
- **Changing things.** Edit a file on GitHub and Render redeploys on its own. Her memory is not touched.
- **Your own address.** The free `onrender.com` address is permanent for as long as the service exists. If you buy a domain later, Render > Settings > Custom Domains adds it.

## Not included yet

This is a fresh build, not a copy of the old Kiara code. Left out for now: the RPG and social commands, voice channels, custom emoji and image libraries, and the moderation roles. Ask if you want any of them added.
