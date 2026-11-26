# SquadWaddle

A first code starter for Novey's Discord app: arrange a relaxed **Marathon** session with a clear start and finish, a host-chosen group size, and optional Bungie Name sharing.

**Private prototype.** The demo and automated tests use fictional data and run without credentials or an npm install. In the private test server, the registered `/session profile` command returned a private reply. Multi-player testing is pending.

## Start on your MacBook

Use your MacBook as the main development machine. Keep the gaming PC for Marathon and in-game testing. This project does not need to run on the same machine as the game.

1. Extract the downloaded ZIP and put the `next-session` folder somewhere convenient, such as `~/Projects/next-session`.
2. Open that folder as your project in Codex. Keep this conversation available in ChatGPT for product decisions.
3. Ask Codex to read `AGENTS.md`, this README and `docs/NEXT-STEPS.md`, check your Node version, and run the demo and tests.

The runtime requirement is **Node.js 24.12 or newer within the 24.x line**, available from [nodejs.org](https://nodejs.org/en/download). The starter was verified on Node 24.22.3. It uses built-in SQLite and Node's native TypeScript execution; the latter strips types and does not perform a static type check. There are no third-party runtime dependencies.

From a terminal already inside the project folder:

```bash
node --version
npm test
npm run demo
```

There is no `npm install` step. The demo uses fictional players and a fixed example clock, prints the session flow in the terminal, and sends nothing to any external service.

## Offline solo rehearsal

From the `Discord Group Bot` folder in the VS Code terminal, run this command. It selects the Node 24 runtime already available on this Mac.

```sh
PATH="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin:$PATH" npm --prefix next-session run rehearsal
```

The rehearsal plays all roles with fictional users and a fresh in-memory database. It sends signed interactions through local streams without opening a network port. It starts with a dated `/session create` request for **Expedition practice** and checks the private preview, host-only Publish, both join choices, shared-name access, and confirmed cancellation. Look for `✔ offline solo rehearsal`, the `PASS` checkpoints, and `fail 0`.

## What this increment implements

| Capability | Behavior |
| --- | --- |
| Session draft | Private preview from one supported Marathon scheduling sentence |
| Draft editing | The host can correct an unpublished draft and review the updated version before publishing |
| Draft recovery | The host can find and reopen a lost private preview from the original channel |
| Capacity | 2–8 total seats including the host, with a default of three. The stored limit is enforced transactionally. |
| Joining | Join with optional sharing, or join without a saved game name |
| Leaving | Frees a seat and ends future access to that session's group IDs |
| Name profile | Save, view or clear your own self-reported full Bungie Name |
| Session consent | Sharing is a separate choice for every session; repeated Join clicks cannot change that choice |
| Private group list | Current confirmed participants can retrieve only names whose owners opted in |
| Discovery | Lists open sessions in the configured channel and links to the original channel card once observed |
| Cancellation | The host confirms cancellation. The card can refresh in place and further joins and group-ID lookups are denied. |
| Persistence | SQLite stores profiles, sessions and membership across restarts |
| Discord endpoint | Verifies requests before parsing and accepts signed interactions only from approved guild/channel pairs |

Public cards contain no Bungie Names. When you opt in for a session, confirmed teammates can look up your name privately, including people who join after you. Leaving ends access to future lookups. A participant choosing **Join only** arranges their in-game connection with the host.

Use the [two-seat private pilot](docs/TWO-SEAT-PILOT.md) to rehearse the text flow with one guest.

## Included Discord commands

The locally tested command definition exposes three choices. The private test server’s registered menu needs a separately authorized update to show them.

| Command | Purpose |
| --- | --- |
| `/session create` | Enter one scheduling sentence and review a private draft |
| `/session find` | Open a real session in this channel and deliberately choose whether to join |
| `/session help` | See an example and open **My drafts** or **My Bungie ID** privately |

### Create from a sentence

Enter a sentence in the `request` field on `/session create`. Use a calendar date for a session more than a week away.

> Two more for Marathon on 2026-12-11 from 6:30 pm to 8:00 pm Pacific for Expedition practice.

A full weekday also works. If you omit the activity, the draft uses **Group play**.

> Two more for Marathon on Saturday from noon to 1:30 pm Pacific.

Calendar dates must be in `YYYY-MM-DD` format. A weekday resolves to its first occurrence on or after today in the selected zone. The command rejects impossible dates, past dates, starts at or before the current time, and times skipped or repeated by daylight saving. If today's start has passed, choose a later time or enter a future date.

When you give only a start time, the draft shows an editable two-hour default. For example, `Marathon on Friday at 7 pm Pacific` drafts 7–9 pm Pacific. If you enter both times, give them on the same day, using `noon`, `h am/pm`, or `h:mm am/pm` for each. Supported zones are `Pacific` (the same as `America/Los_Angeles`) and `UTC`. Discord timestamps display in each viewer’s local zone. For example, Friday noon–3 pm UTC on November 27, 2026 appears as 4–7 am Pacific.

If you start an explicit range with `from … to` and omit its end, the command asks for the end privately. Missing AM or PM or a missing time zone also gets a private hint.

To name the activity, add `for` and the activity name after the zone. The whole sentence can be up to 160 characters. The activity is visible on the channel card after publishing, so keep Bungie Names out of it.

Group size defaults to three seats including you. Say “two more” for three total, “three more” or “four players total” for four, or “six players total” for six. Put the count before “for Marathon” or add it at the end with “with,” as in “Marathon Friday noon–3 pm UTC with 6 players total.” Use 2–8 total seats. A bare count such as “four players” gets a private clarification.

Use **Edit** to change the sentence, activity, platform, or **Total seats including you**. Review the new preview before pressing **Publish**. Leaving the seat field blank keeps the current size unless the replacement sentence names a new one. A size edit keeps the session’s sharing choice. **Share my Bungie ID** starts at **No**. Choosing **Yes** uses the name you saved privately under **My Bungie ID**.

### Draft the weekend

> Two more for Marathon all weekend in Pacific for Expedition practice.

The private draft records Saturday and Sunday in the selected zone. Hours are flexible when omitted. If you include hours, they show as a preference for each day. Use **Edit** to supply an exact-time sentence for one day of that weekend in the same zone. The updated preview keeps the draft, seat count, and sharing choice unless you explicitly change the count. Review it before pressing **Publish**.

### Recover a private draft

In the original channel, open **My drafts** from `/session help` or a draft preview. The private list shows up to five entries per page. Use **Next page** and **Open** to find the draft you want. The list shows schedules or weekend dates without names. Opening a draft displays its latest revision and sharing choice.

### Join or cancel

**Join** opens private choices to join with or without sharing. A confirmed member can use **Show group IDs** to manage their sharing. A host uses **Host Cancel**, then **Confirm cancellation**. The session closes immediately in SQLite. **Refresh**, or a later **Join** press on the public card, shows the cancellation on that same card.

### Voice-room prototype

The [offline voice pilot](docs/VOICE-ROOMS.md) connects the signed **Join voice** button to the room lifecycle only when the test supplies an explicit guild, text channel, and category with fictional Gateway and REST inputs. The normal server starts with voice disabled.

## Development server configuration

**The demo and tests do not need this section.** Use it when preparing a private Discord integration test with Codex.

Copy `.env.example` to `.env` and fill in your application's IDs and public verification key locally. The `.env` file is excluded from source control. The app token belongs only in your local environment or a hosting secret store, never in chat, a screenshot or committed source.

```bash
npm start
```

By default, the server listens at `127.0.0.1:3000`. `GET /health` returns only an availability check; `POST /interactions` accepts verified Discord interactions. The default database lives at `data/next-session.sqlite`.

The single-pair settings `PILOT_GUILD_ID` and `PILOT_CHANNEL_ID` are the default. For fictional two-server testing, set `PILOT_ALLOWED_PAIRS` to a comma-separated list of `guild_id:channel_id` pairs. An explicit list replaces the default pair. [Two-server configuration and launch gates](docs/TWO-SERVER-BETA.md)

Set `PILOT_PUBLISH_ENABLED=no` for a draft-only smoke test. The private preview explains why **Publish** is disabled, and cached Publish buttons receive the same private explanation. Edit and Discard still work. Draft-only mode also keeps voice disabled. Explicit host publishing is available by default.

Discord needs a reachable HTTPS interaction endpoint. Starting this local server alone does not connect Discord to it. A deliberate test setup must supply HTTPS routing, install the official app with appropriate permissions, configure the interaction endpoint, and register the guild-scoped command. The registration script modifies only this app's `/session` command in the chosen guild and is gated by `REGISTER_COMMANDS=yes`.

```bash
npm run register
```

Until that environment setting is deliberately enabled and credentials are configured, registration performs no network action. There is no background monitoring, reminder delivery or autonomous outreach in this starter.

## Important implementation limits

The prototype uses a local deterministic parser. Live voice, notifications, a waitlist, recurring sessions, external account linking, automatic in-game invitations, payments, and personal ratings remain future work. Game access, cross-play settings, and account ownership are unverified.

When the host presses **Publish**, SQLite checks the preview revision, opens the draft, and saves the Discord interaction ID and session ID in one transaction. If the app restarts using the same database file, a retry of a successful Publish gets a private acknowledgement. An edit from an older revision is rejected even after restart. A second click on an already-open session also gets a private reply. An in-memory database lasts only until shutdown.

When someone presses a button on the public card, the app checks the message against its saved Publish interaction. A match lets it save the message ID and show **Open channel card** in private search results and the host's cancellation reply. Joining or leaving on the channel card updates its roster immediately. People can still open a private session preview and join either way if the link is unavailable.

If the app stops after saving the session but before Discord receives the card, the session can appear in `/session find` with no channel card. An untouched card may also have no recorded link. Recovery of missing or deleted cards remains open. A join through a private preview or a cancellation can leave the channel card stale until someone presses **Refresh**. Other interaction types have process-local duplicate protection.

The database is ordinary local SQLite, readable by the app operator. Clearing a name removes it from active records and sharing snapshots; this does not recall messages, screenshots or copies already made. Automatic data expiry, full account deletion and production backup/deletion behavior remain to be designed. No real participant dataset is bundled.

The normal server still uses the legacy profile schema on databases that have not gone through cutover. The [guild-scoped profile cutover](docs/TWO-SERVER-BETA.md#guild-scoped-profile-cutover-rehearsal) was verified on a fictional database. Real rollout requires a separately approved migration and backup plan.

See [docs/NEXT-STEPS.md](docs/NEXT-STEPS.md) for the next milestone, [docs/PRODUCT.md](docs/PRODUCT.md) for accepted product decisions, and [VALIDATION.md](VALIDATION.md) for what was actually checked.

## Project layout

```text
src/store.ts                 Session rules and SQLite persistence
src/types.ts                 Domain contracts and public/private data shapes
src/schedule-text.ts         Deterministic parser for short Marathon scheduling requests
src/voice-rooms.ts           Opt-in voice room lifecycle
src/voice-pilot.ts           Offline wiring for scoped, signed voice interactions
src/voice-room-registry.ts   SQLite voice links and provisioning receipts
src/discord.ts               Slash commands, buttons and response rendering
src/server.ts                Signed HTTP interaction endpoint
src/demo.ts                  Fictional local walkthrough
scripts/register-commands.ts Deliberate guild command registration
test/                       Automated behavior and transport tests
docs/                       Product decisions and next tasks
AGENTS.md                   Instructions for Codex and other coding agents
```

## Why Codex for this project?

Use Codex for direct implementation, debugging, tests and review. Dot can be useful later for ongoing coordination and follow-up, and can delegate coding to Codex. A separate delegated task receives the context passed to it, so keep the accepted decisions and current status in these project files.

Official references: [Meet dots](https://learn.chatgpt.com/docs/dots), [Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory), [ChatGPT/Codex quickstart](https://learn.chatgpt.com/docs/quickstart), [Node TypeScript support](https://nodejs.org/api/typescript.html), [Node SQLite](https://nodejs.org/api/sqlite.html), [Discord interactions](https://docs.discord.com/developers/interactions/overview).
