# First private Discord test

**Goal:** You host one three-seat Marathon session on your MacBook. A second person can join with a fictional Bungie Name, and a third can play without entering one. Everyone can see the session card in the test channel. Only confirmed players can request the names shared for that session.

## 1. Finish the local check

In macOS Terminal, run the following in one window. The `export` selects the Node 24.22.3 runtime already on this Mac for that Terminal session.

```sh
cd "$HOME/Code/Projects/Discord Group Bot/next-session"
export PATH="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin:$PATH"
node --version
npm test
```

Look for **54 passed**. The two HTTP tests start a temporary server on your Mac and send it signed test requests. They need permission to open a local port. They use generated keys and run before any Discord setup. You can repeat the fictional walkthrough with `npm run demo`.

## 2. Set up the private server and local settings

1. In Discord, use a server you own for testing. Create a private text channel such as `#session-test`. Give your consenting testers access to view the channel and use application commands.
2. In **User Settings → Advanced**, enable **Developer Mode**. Right-click the server icon and choose **Copy Server ID**. Right-click the test channel and choose **Copy Channel ID**. [Discord’s ID guide](https://support.discord.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID)
3. Open the Developer Portal and create a dedicated test application. Under **Installation**, enable **Guild Install** only. For Guild Install use the `applications.commands` scope. This starter replies directly to interactions, so it needs zero bot permissions and zero privileged intents. Use the install link to **Add to Server** and select your test server. [Developer Portal](https://discord.com/developers/applications) · [Discord command authorization](https://docs.discord.com/developers/interactions/application-commands#authorizing-your-application)
4. Open the project's local `.env` in your editor. On this Mac the file is prepared with blank credential fields, owner-only permissions, and `REGISTER_COMMANDS=no`. Keep credentials out of chat, screenshots and shell history.

| Local setting | Where to find it |
| --- | --- |
| `DISCORD_APPLICATION_ID` | Developer Portal → General Information → Application ID |
| `DISCORD_PUBLIC_KEY` | Developer Portal → General Information → Public Key |
| `PILOT_GUILD_ID` | The server ID from step 2 |
| `PILOT_CHANNEL_ID` | The channel ID from step 2 |
| `DISCORD_BOT_TOKEN` | Developer Portal → Bot. Generate the token for this dedicated app when ready to register the command. Only the registration script needs it. |

Keep `HOST=127.0.0.1`, `PORT=3000` and `DB_PATH=:memory:` for the first rehearsal. Stopping the server clears its local sessions, profiles and memberships. Keep the same process running throughout the test. [Discord app setup](https://docs.discord.com/developers/quick-start/getting-started)

## 3. Connect Discord when ready to test

1. In the Terminal window from step 1, run `npm start` and leave it running. In a second window run `curl -fsS http://127.0.0.1:3000/health`. Expect `{"ok":true}`.
2. For a temporary HTTPS address, use a Cloudflare Quick Tunnel. With Homebrew, install the client once with `brew install cloudflared`. Once the health check passes, run `cloudflared tunnel --url http://127.0.0.1:3000` in the second window. It prints a publicly reachable HTTPS address that lasts for that run. Keep the Mac awake and both windows open. [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) · [Client installation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
3. In **Developer Portal → General Information → Interactions Endpoint URL**, paste the tunnel's HTTPS address with `/interactions` appended. Save and check that Discord accepts it. This is the first live check that Discord can reach the Mac and receive the correct response to its signed ping. [Discord endpoint setup](https://docs.discord.com/developers/quick-start/getting-started#adding-an-interaction-endpoint-url)
4. When the server ID in your local settings matches the intended private server, open a third Terminal window and run the following. This opts in to registering the command for this invocation only. The script updates this app's `/session` command in that one server.

```sh
cd "$HOME/Code/Projects/Discord Group Bot/next-session"
export PATH="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin:$PATH"
REGISTER_COMMANDS=yes npm run register
```

In `#session-test`, run `/session profile`. With a fresh test database, you should see a private reply saying you have no saved name. Have a tester confirm that your reply is invisible to them. This is the first live success to look for.

## 4. Walk through one session

Use fictional names only. Keep activity, expectations and platform notes suitable for the whole channel because those fields appear on the card. Use the session ID printed on the card wherever a command asks for `session`.

| Action | What the testers should see |
| --- | --- |
| Host runs `/session create` with an activity, future start and end including UTC offsets, and `America/Los_Angeles`. Omit `share`. | Only the host sees the draft. A second person checks the channel and `/session find` before publication. Both should be clear of the draft. |
| Host presses **Publish**. | One card appears with the time window, host and 1/3 seats. It displays no saved Bungie Name. |
| Before joining, a tester presses **Show group IDs**. | The tester receives a private denial. |
| One tester saves `ExampleRunner#5678` using `/session profile bungie_name` and presses **Join & share Bungie Name**. Another, with no saved profile, presses **Join only**. | All three seats fill. The channel card shows the Discord roster. A member pressing **Show group IDs** privately sees one fictional name and two unshared entries. The host has the same per-session choice as the others. |
| If a fourth consenting tester is available, they press **Join only** on the full card and try **Show group IDs**. | The fourth tester is refused a seat and cannot retrieve names. With three people, record fourth-seat rejection as covered locally and pending in Discord. |
| The sharing tester runs `/session share session:<id> enabled:false`. A member requests the IDs again. Then the tester presses **Leave** and tries **Show group IDs** again. | A fresh lookup omits the revoked name. Leaving reopens one seat and ends that tester's access. |
| Host runs `/session cancel session:<id>`. Press **Refresh** on the channel card. | The card shows cancellation. The app rejects further joins and group-ID lookups. |

A join made through a private search result can leave the original card showing an old count. Use **Refresh** on the channel card. If Publish appears to time out, check the channel and `/session find` before acting again. Recovery from an interrupted publication still needs work.

At the end, remove the temporary endpoint from the test app, stop the tunnel and server with **Ctrl-C** in their windows, and remove the test card from the channel. Discord messages and screenshots have a separate lifetime from the in-memory test database. Record pass/fail observations without tokens or player names.
