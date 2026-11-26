# First private Discord test

## Solo smoke test

Use a private test channel, a confirmed temporary endpoint, and disposable storage. In Discord, run `/session create` with a future scheduling sentence. Confirm that the draft is visible only to you, the requested times and seat count match, and game ID sharing is off. Choose **Discard** and look for **Draft discarded. No session card was published.** Clear the temporary endpoint and stop only the tunnel and server started for the test.

## Group rehearsal

**Goal:** You host one three-seat Marathon session on your MacBook. A second person can join with a fictional Bungie Name, and a third can play without entering one. Everyone can see the session card in the test channel. Only confirmed players can request the names shared for that session.

## 1. Finish the local check

In macOS Terminal, run the following in one window. The `export` selects the Node 24.22.3 runtime already on this Mac for that Terminal session.

```sh
cd "$HOME/Code/Projects/Discord Group Bot/next-session"
export PATH="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin:$PATH"
node --version
npm test
npm run demo
npm run rehearsal
```

Look for **0 failed**. Two HTTP tests normally use a temporary loopback port on your Mac. If the workspace denies that permission, the tests report it and pass the same HTTP requests through local streams. Both paths use generated keys. You can repeat the fictional walkthrough with `npm run demo`.

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

In `#session-test`, run `/session create` with a future scheduling sentence. Have a tester confirm that the private draft is invisible to them. This is the first live success to look for.

## 4. Walk through one session

This walkthrough assumes the compact menu has been separately authorized and registered in the test guild. Use fictional names only. Keep the activity and platform text suitable for the whole channel.

| Action | What the testers should see |
| --- | --- |
| Host enters a future scheduling sentence in `/session create` and reviews it. | Only the host sees the draft. **Share my Bungie ID** starts at **No**. A second person checks that the channel and `/session find` are clear of the draft. |
| Host presses **Publish**. | One card appears with the time window, host and 1/3 seats. It displays no saved Bungie Name. |
| Before joining, a tester presses **Show group IDs**. | The tester receives a private denial. |
| After that click, a tester runs `/session find` and selects **Open channel card**. | The link in the private result jumps to the host's original message. The tester is still outside the group until they choose a Join button. If the link is missing, record that observation and use the numbered **Open** button to continue. |
| One tester saves `ExampleRunner#5678` using **My Bungie ID** in `/session help`, presses **Join**, then chooses **Join & share Bungie Name**. Another presses **Join** then **Join only**. | All three seats fill after both confirm. Use **Refresh** for the current public roster. A member pressing **Show group IDs** privately sees one fictional name and two unshared entries. |
| If a fourth consenting tester is available, they try **Join** and **Join only**, then try **Show group IDs**. | The fourth tester is refused a seat and cannot retrieve names. With three people, record fourth-seat rejection as covered locally and pending in Discord. |
| The sharing tester opens **Show group IDs**, presses **Stop sharing**, then presses **Leave** on the public card. | A fresh lookup omits the revoked name. Leaving reopens one seat and ends that tester's access. |
| Host presses **Host Cancel**, then **Confirm cancellation**. Use **Refresh** on the public card. | The same card shows cancellation. The app rejects further joins and group-ID lookups. |

A join made through the private choices can leave the original card showing an old count. Use **Refresh** on the channel card. If Publish appears to time out, check the channel and `/session find` before acting again. Recovery from an interrupted publication still needs work.

At the end, remove the temporary endpoint from the test app, stop the tunnel and server with **Ctrl-C** in their windows, and remove the test card from the channel. Discord messages and screenshots have a separate lifetime from the in-memory test database. Record pass/fail observations without tokens or player names.
