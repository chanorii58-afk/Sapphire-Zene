--[[
	Zene bridge for Roblox executors (Delta and others)

	Connects this Roblox account to Zene's website, so the Roblox Zene and the
	Discord Zene are the same brain with one shared memory.

	1. Paste your gateway URL and key below (the Roblox tab of the dashboard has a
	   "Copy both as script lines" button).
	2. Run this script in your executor.

	What it does
	  - answers when someone says her name in chat (Triggers below)
	  - never answers her own messages, never spams the same line twice
	  - tells the website what game she is in, so Discord Zene knows
	  - speaks lines you queue from the dashboard or Discord (z.say)
	  - hands you "orders" from the dashboard / Discord (z.order) through Bridge.OnOrder

	Using it from another script (for example your Sapphire Zene script):
	  local Zene = getgenv().ZeneBridge
	  local reply = Zene.Ask("what should we do next?")      -- yields, returns text or nil
	  Zene.Say("hello chat")
	  Zene.OnOrder(function(text) print("order:", text) end)
	  Zene.SetDoing("hiding from the mimic")                  -- shows up on the dashboard
	  Zene.Learn("Mimic", "The mimic copies voices.")         -- teaches the shared brain
]]

local CONFIG = {
	Url = "https://YOUR-SERVICE.onrender.com",
	Key = "PASTE-YOUR-GATEWAY-KEY",

	Triggers = { "zene", "sapphire", "sofi", "warmachine12908" },
	AutoChat = true, -- answer chat messages that mention a trigger name
	ReplyToEveryone = false, -- true: she may also chime in when not named (the server decides if she speaks)
	ShowGui = true, -- small draggable status pill
	PollSeconds = 3, -- how often to check for lines/orders from the dashboard
	HeartbeatSeconds = 20,
	MaxRepliesPerMinute = 6,
	PlayerCooldown = 4, -- seconds between replies to the same player
	NearbyRange = 60, -- studs; nearby players are mentioned to her
}

local env = (getgenv and getgenv()) or _G
if type(env.ZeneConfig) == "table" then
	for k, v in pairs(env.ZeneConfig) do
		CONFIG[k] = v
	end
end
if env.ZeneBridge and type(env.ZeneBridge.Stop) == "function" then
	pcall(env.ZeneBridge.Stop)
end

local function out(msg)
	(warn or print)("[Zene] " .. tostring(msg))
end

local BASE = (tostring(CONFIG.Url or ""):gsub("/+$", ""))
if BASE == "" or BASE:find("YOUR%-SERVICE") or tostring(CONFIG.Key or ""):find("PASTE") or tostring(CONFIG.Key or "") == "" then
	out("Open the script and set Url and Key at the top first (dashboard > Roblox tab).")
	return
end

local requestFn = (syn and syn.request) or (http and http.request) or http_request or request or (fluxus and fluxus.request)
if not requestFn then
	out("This executor has no http request function. Zene cannot connect.")
	return
end

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local TextChatService = game:GetService("TextChatService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")
while not Players.LocalPlayer do
	task.wait(0.2)
end
local LocalPlayer = Players.LocalPlayer

---------------------------------------------------------------- helpers

local function clamp(n, lo, hi)
	if n < lo then
		return lo
	end
	if n > hi then
		return hi
	end
	return n
end

local function trim(s)
	return (tostring(s):gsub("^%s+", ""):gsub("%s+$", ""))
end

local function normalize(s)
	return trim((tostring(s):lower():gsub("[^%w%s]", " "):gsub("%s+", " ")))
end

local function splitText(text, max)
	local out_ = {}
	text = trim((tostring(text):gsub("%s+", " ")))
	while #text > max and #out_ < 3 do
		local i = max
		while i > max * 0.5 and text:sub(i, i) ~= " " do
			i = i - 1
		end
		if i <= max * 0.5 then
			i = max
		end
		table.insert(out_, trim(text:sub(1, i)))
		text = trim(text:sub(i + 1))
	end
	if #text > 0 and #out_ < 3 then
		table.insert(out_, text)
	end
	return out_
end

---------------------------------------------------------------- state

local state = {
	running = true,
	enabled = true,
	status = "starting",
	online = false,
	after = nil,
	failures = 0,
	sayQueue = {},
	nextSay = 0,
	lastSayAt = -100,
	sent = {},
	events = {},
	replyTimes = {},
	lastByPlayer = {},
	connections = {},
	orderHandlers = {},
	ignored = {},
	doing = "",
	gameName = game.Name,
	lastLine = "",
}

local function note(msg)
	state.lastLine = tostring(msg)
	out(msg)
end

local function keep(conn)
	table.insert(state.connections, conn)
	return conn
end

---------------------------------------------------------------- http

local function api(method, path, body)
	local ok, res = pcall(requestFn, {
		Url = BASE .. path,
		Method = method,
		Headers = { ["Content-Type"] = "application/json", ["x-zene-key"] = CONFIG.Key },
		Body = body and HttpService:JSONEncode(body) or nil,
	})
	if not ok or type(res) ~= "table" then
		state.online = false
		state.status = "offline"
		return nil, "network", 0
	end
	local code = tonumber(res.StatusCode or res.status_code or res.Status) or 0
	local text = res.Body or res.body or ""
	local decoded = nil
	pcall(function()
		decoded = HttpService:JSONDecode(text)
	end)
	if code == 401 then
		state.online = false
		state.status = "wrong key"
		return decoded, "bad key", code
	end
	if code >= 200 and code < 300 then
		state.online = true
		state.status = "online"
		return decoded or {}, nil, code
	end
	if not decoded then
		state.status = "waking up"
	end
	return decoded, "http " .. tostring(code), code
end

-- Render's free plan sleeps; the first request can fail while it wakes up.
local function apiRetry(method, path, body, tries)
	local res, err, code
	for attempt = 1, tries do
		res, err, code = api(method, path, body)
		if not err then
			return res, nil, code
		end
		local wokenUp = (code == 0 or code >= 500) and not res
		if not wokenUp or not state.running then
			break
		end
		task.wait(attempt * 4)
	end
	return res, err, code
end

---------------------------------------------------------------- game info

local function gameInfo()
	return { placeId = tostring(game.PlaceId), jobId = tostring(game.JobId), name = state.gameName }
end

task.spawn(function()
	local ok, info = pcall(function()
		return game:GetService("MarketplaceService"):GetProductInfo(game.PlaceId)
	end)
	if ok and type(info) == "table" and info.Name then
		state.gameName = tostring(info.Name)
	end
end)

local function nearbyNames()
	local list = {}
	local me = LocalPlayer.Character and LocalPlayer.Character:FindFirstChild("HumanoidRootPart")
	if not me then
		return list
	end
	for _, p in ipairs(Players:GetPlayers()) do
		if p ~= LocalPlayer and p.Character then
			local root = p.Character:FindFirstChild("HumanoidRootPart")
			if root then
				local d = (root.Position - me.Position).Magnitude
				if d <= CONFIG.NearbyRange then
					table.insert(list, { n = p.DisplayName ~= "" and p.DisplayName or p.Name, d = d })
				end
			end
		end
	end
	table.sort(list, function(a, b)
		return a.d < b.d
	end)
	local names = {}
	for i = 1, math.min(#list, 5) do
		names[i] = list[i].n
	end
	return names
end

---------------------------------------------------------------- saying things in chat

local function sendChat(text)
	text = (tostring(text):gsub("%c+", " "))
	text = text:sub(1, 200)
	if text == "" then
		return false
	end
	state.lastSayAt = os.clock()
	table.insert(state.sent, { n = normalize(text), t = os.clock() })
	if #state.sent > 12 then
		table.remove(state.sent, 1)
	end
	if TextChatService.ChatVersion == Enum.ChatVersion.TextChatService then
		local channels = TextChatService:FindFirstChild("TextChannels")
		local ch = channels and (channels:FindFirstChild("RBXGeneral") or channels:FindFirstChildWhichIsA("TextChannel"))
		if ch then
			local ok = pcall(function()
				ch:SendAsync(text)
			end)
			if ok then
				return true
			end
		end
	end
	local ev = ReplicatedStorage:FindFirstChild("DefaultChatSystemChatEvents")
	local req = ev and ev:FindFirstChild("SayMessageRequest")
	if req then
		return (pcall(function()
			req:FireServer(text, "All")
		end))
	end
	return false
end

local function saidRecently(text)
	local n = normalize(text)
	for _, s in ipairs(state.sent) do
		if s.n == n and os.clock() - s.t < 120 then
			return true
		end
	end
	return false
end

local function enqueueSay(text, delay, force)
	text = trim(text)
	if text == "" then
		return
	end
	if not force and saidRecently(text) then
		return
	end
	table.insert(state.sayQueue, { text = text, at = os.clock() + (delay or 0) })
	if #state.sayQueue > 6 then
		table.remove(state.sayQueue, 1)
	end
end

task.spawn(function()
	while state.running do
		local item = state.sayQueue[1]
		if item and os.clock() >= item.at and os.clock() >= state.nextSay then
			table.remove(state.sayQueue, 1)
			for _, chunk in ipairs(splitText(item.text, 190)) do
				if not state.running then
					break
				end
				sendChat(chunk)
				local wait_ = clamp(#chunk * 0.045, 1.2, 3.5)
				state.nextSay = os.clock() + wait_
				task.wait(wait_)
			end
		else
			task.wait(0.15)
		end
	end
end)

---------------------------------------------------------------- asking the brain

local function ask(plr, text, mode)
	local body = {
		player = { name = plr.Name, displayName = plr.DisplayName, userId = plr.UserId },
		message = tostring(text):sub(1, 400),
		mode = mode or "direct",
		game = gameInfo(),
		playerCount = #Players:GetPlayers(),
		nearby = nearbyNames(),
	}
	local res, err = apiRetry("POST", "/gateway/chat", body, 3)
	if err then
		if res and res.error == "NO_KEYS" then
			note("The website has no AI key yet. Add one in the dashboard.")
		elseif res and res.error then
			note("Brain unavailable: " .. tostring(res.error))
		end
		return nil, res
	end
	if type(res.reply) == "string" and res.reply ~= "" then
		return res.reply, res
	end
	return nil, res
end

local function allowReply(plr)
	local now = os.clock()
	local fresh = {}
	for _, t in ipairs(state.replyTimes) do
		if now - t < 60 then
			table.insert(fresh, t)
		end
	end
	state.replyTimes = fresh
	if #fresh >= CONFIG.MaxRepliesPerMinute then
		return false
	end
	if now - (state.lastByPlayer[plr.UserId] or -100) < CONFIG.PlayerCooldown then
		return false
	end
	state.lastByPlayer[plr.UserId] = now
	table.insert(state.replyTimes, now)
	return true
end

---------------------------------------------------------------- reading chat

local function mentionsMe(text)
	local low = " " .. (tostring(text):lower():gsub("[^%w_]", " ")) .. " "
	for _, t in ipairs(CONFIG.Triggers) do
		if low:find(" " .. tostring(t):lower() .. " ", 1, true) then
			return true
		end
	end
	return false
end

local function isEcho(plr, text)
	if plr ~= LocalPlayer then
		return false
	end
	local n = normalize(text)
	local now = os.clock()
	for i, s in ipairs(state.sent) do
		if s.n == n and now - s.t < 20 then
			return true
		end
	end
	-- Roblox may censor our own text (####), so also ignore anything right after we spoke.
	return now - state.lastSayAt < 2.5
end

local function pushEvent(plr, text)
	table.insert(state.events, { type = "chat", name = plr.Name, display = plr.DisplayName, text = tostring(text):sub(1, 200) })
	if #state.events > 30 then
		table.remove(state.events, 1)
	end
end

local function handleChat(plr, text)
	if not state.running or type(text) ~= "string" or text == "" then
		return
	end
	if isEcho(plr, text) then
		return
	end
	pushEvent(plr, text)
	if not (CONFIG.AutoChat and state.enabled) or state.ignored[plr.UserId] then
		return
	end
	local addressed = mentionsMe(text)
	if not addressed and not CONFIG.ReplyToEveryone then
		return
	end
	if not allowReply(plr) then
		return
	end
	task.spawn(function()
		local reply = ask(plr, text, addressed and "direct" or "ambient")
		if reply and state.running then
			enqueueSay(reply, 0.5, false)
		end
	end)
end

local function hookChat()
	if TextChatService.ChatVersion == Enum.ChatVersion.TextChatService then
		keep(TextChatService.MessageReceived:Connect(function(msg)
			local src = msg.TextSource
			if not src then
				return
			end
			local plr = Players:GetPlayerByUserId(src.UserId)
			if plr then
				handleChat(plr, msg.Text)
			end
		end))
	else
		local function watch(plr)
			keep(plr.Chatted:Connect(function(m)
				handleChat(plr, m)
			end))
		end
		for _, p in ipairs(Players:GetPlayers()) do
			watch(p)
		end
		keep(Players.PlayerAdded:Connect(watch))
	end
end

---------------------------------------------------------------- loops: poll, heartbeat, events

local function handleItem(item)
	if item.type == "say" then
		note("Dashboard line: " .. tostring(item.text))
		enqueueSay(item.text, 0, true)
	elseif item.type == "order" then
		note("Order: " .. tostring(item.text))
		for _, fn in ipairs(state.orderHandlers) do
			task.spawn(fn, item.text, item)
		end
	end
end

task.spawn(function()
	while state.running do
		local path = "/gateway/poll?user=" .. HttpService:UrlEncode(LocalPlayer.Name)
		if state.after then
			path = path .. "&after=" .. string.format("%.0f", state.after)
		end
		local res, err = api("GET", path)
		if not err and res then
			state.failures = 0
			if state.after == nil then
				state.after = tonumber(res.latest) or 0 -- skip anything queued before we started
			else
				for _, item in ipairs(res.items or {}) do
					state.after = math.max(state.after, tonumber(item.id) or 0)
					handleItem(item)
				end
				if tonumber(res.latest) and res.latest < state.after then
					state.after = res.latest
				end
			end
		else
			state.failures = state.failures + 1
		end
		local wait_ = CONFIG.PollSeconds
		if state.failures > 0 then
			wait_ = clamp(CONFIG.PollSeconds * (2 ^ math.min(state.failures, 4)), CONFIG.PollSeconds, 30)
		end
		task.wait(wait_)
	end
end)

task.spawn(function()
	while state.running do
		api("POST", "/gateway/heartbeat", {
			user = LocalPlayer.Name,
			game = state.gameName,
			placeId = tostring(game.PlaceId),
			jobId = tostring(game.JobId),
			players = #Players:GetPlayers(),
			doing = state.doing,
		})
		task.wait(CONFIG.HeartbeatSeconds)
	end
end)

task.spawn(function()
	while state.running do
		task.wait(5)
		if #state.events > 0 and state.running then
			local batch = state.events
			state.events = {}
			api("POST", "/gateway/events", { game = gameInfo(), events = batch })
		end
	end
end)

---------------------------------------------------------------- status pill (optional)

local gui = nil
local function buildGui()
	local ok, err = pcall(function()
		local parent = (gethui and gethui()) or game:GetService("CoreGui")
		gui = Instance.new("ScreenGui")
		gui.Name = "ZeneBridge"
		gui.ResetOnSpawn = false
		gui.DisplayOrder = 999
		gui.Parent = parent

		local frame = Instance.new("Frame")
		frame.Size = UDim2.new(0, 190, 0, 58)
		frame.Position = UDim2.new(0, 12, 0.35, 0)
		frame.BackgroundColor3 = Color3.fromRGB(14, 27, 82)
		frame.BorderSizePixel = 0
		frame.Parent = gui
		local corner = Instance.new("UICorner")
		corner.CornerRadius = UDim.new(0, 14)
		corner.Parent = frame

		local dot = Instance.new("Frame")
		dot.Size = UDim2.new(0, 12, 0, 12)
		dot.Position = UDim2.new(0, 12, 0, 12)
		dot.BorderSizePixel = 0
		dot.Parent = frame
		local dc = Instance.new("UICorner")
		dc.CornerRadius = UDim.new(1, 0)
		dc.Parent = dot

		local title = Instance.new("TextLabel")
		title.BackgroundTransparency = 1
		title.Position = UDim2.new(0, 32, 0, 6)
		title.Size = UDim2.new(0, 90, 0, 24)
		title.Font = Enum.Font.GothamBold
		title.TextSize = 15
		title.TextColor3 = Color3.fromRGB(255, 255, 255)
		title.TextXAlignment = Enum.TextXAlignment.Left
		title.Text = "Zene"
		title.Parent = frame

		local toggle = Instance.new("TextButton")
		toggle.Size = UDim2.new(0, 52, 0, 26)
		toggle.Position = UDim2.new(1, -62, 0, 5)
		toggle.Font = Enum.Font.GothamBold
		toggle.TextSize = 13
		toggle.TextColor3 = Color3.fromRGB(255, 255, 255)
		toggle.BorderSizePixel = 0
		toggle.Parent = frame
		local tc = Instance.new("UICorner")
		tc.CornerRadius = UDim.new(1, 0)
		tc.Parent = toggle

		local line = Instance.new("TextLabel")
		line.BackgroundTransparency = 1
		line.Position = UDim2.new(0, 12, 0, 34)
		line.Size = UDim2.new(1, -24, 0, 18)
		line.Font = Enum.Font.Gotham
		line.TextSize = 12
		line.TextColor3 = Color3.fromRGB(176, 192, 255)
		line.TextXAlignment = Enum.TextXAlignment.Left
		line.TextTruncate = Enum.TextTruncate.AtEnd
		line.Text = ""
		line.Parent = frame

		toggle.MouseButton1Click:Connect(function()
			state.enabled = not state.enabled
		end)

		local dragging, dragStart, startPos = false, nil, nil
		frame.InputBegan:Connect(function(input)
			if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
				dragging = true
				dragStart = input.Position
				startPos = frame.Position
				input.Changed:Connect(function()
					if input.UserInputState == Enum.UserInputState.End then
						dragging = false
					end
				end)
			end
		end)
		keep(UserInputService.InputChanged:Connect(function(input)
			if dragging and (input.UserInputType == Enum.UserInputType.MouseMovement or input.UserInputType == Enum.UserInputType.Touch) then
				local d = input.Position - dragStart
				frame.Position = UDim2.new(startPos.X.Scale, startPos.X.Offset + d.X, startPos.Y.Scale, startPos.Y.Offset + d.Y)
			end
		end))

		task.spawn(function()
			while state.running and gui do
				dot.BackgroundColor3 = state.online and Color3.fromRGB(76, 214, 160) or Color3.fromRGB(255, 123, 128)
				toggle.Text = state.enabled and "On" or "Off"
				toggle.BackgroundColor3 = state.enabled and Color3.fromRGB(43, 89, 255) or Color3.fromRGB(80, 90, 130)
				line.Text = state.lastLine ~= "" and state.lastLine or state.status
				title.Text = "Zene " .. (state.online and "" or "(" .. state.status .. ")")
				task.wait(0.5)
			end
		end)
	end)
	if not ok then
		out("Status pill could not be created: " .. tostring(err))
	end
end

---------------------------------------------------------------- public API

local Bridge = {}
Bridge.Config = CONFIG

function Bridge.Ask(text, plr)
	local reply = ask(plr or LocalPlayer, text, "direct")
	return reply
end

function Bridge.Say(text, force)
	enqueueSay(text, 0, force ~= false)
end

function Bridge.Learn(title, text)
	local res, err = apiRetry("POST", "/gateway/knowledge", { title = title, text = text }, 2)
	return not err and res and res.ok == true
end

function Bridge.Lookup(query)
	local res, err = api("GET", "/gateway/knowledge?q=" .. HttpService:UrlEncode(tostring(query)))
	if err or not res then
		return {}
	end
	return res.items or {}
end

function Bridge.OnOrder(fn)
	table.insert(state.orderHandlers, fn)
end

function Bridge.SetDoing(text)
	state.doing = tostring(text or ""):sub(1, 100)
end

function Bridge.SetEnabled(on)
	state.enabled = on and true or false
end

function Bridge.Ignore(playerOrId, on)
	local id = type(playerOrId) == "number" and playerOrId or playerOrId.UserId
	state.ignored[id] = (on ~= false) or nil
end

function Bridge.IsOnline()
	return state.online
end

function Bridge.Stop()
	state.running = false
	for _, c in ipairs(state.connections) do
		pcall(function()
			c:Disconnect()
		end)
	end
	if gui then
		pcall(function()
			gui:Destroy()
		end)
		gui = nil
	end
	if env.ZeneBridge == Bridge then
		env.ZeneBridge = nil
	end
end

Bridge._state = state

env.ZeneBridge = Bridge
hookChat()
if CONFIG.ShowGui then
	buildGui()
end

task.spawn(function()
	local res, err, code = apiRetry("GET", "/gateway/ping", nil, 4)
	if err then
		if code == 401 then
			note("The gateway key is wrong. Copy it again from the dashboard.")
		else
			note("Could not reach the website yet (" .. tostring(err) .. "). It may be waking up.")
		end
	else
		note("Connected to " .. tostring(res.name or "Zene") .. ".")
	end
end)

return Bridge
