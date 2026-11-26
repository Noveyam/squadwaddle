# SquadWaddle

A first code starter for Novey's Discord app: arrange a relaxed **Marathon** session with a clear start and finish, three seats including the host, and optional Bungie Name sharing.

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

## What this increment implements

| Capability | Behavior |
| --- | --- |
| Session draft | Explicit activity, start, end, IANA time zone, expectations and platform notes; private preview before publishing |
| Capacity | Three seats total including the host, enforced transactionally |
| Joining | Join with optional sharing, or join without a saved game name |
| Leaving | Frees a seat and ends future access to that session's group IDs |
| Name profile | Save, view or clear your own self-reported full Bungie Name |
| Session consent | Sharing is a separate choice for every session; repeated Join clicks cannot change that choice |
| Private group list | Current confirmed participants can retrieve only names whose owners opted in |
| Discovery | Lists real open, unended sessions in the configured Discord channel |
| Cancellation | Host can cancel; future joins and group-ID lookups are denied |
| Persistence | SQLite stores profiles, sessions and membership across restarts |
| Discord endpoint | Verifies signed requests before parsing them; limits access to one configured guild and channel |

Public cards contain no Bungie Names. The host uses the same sharing rules as every other participant. A participant choosing **Join only** takes responsibility for arranging their in-game connection with the host.

## Included Discord commands

The private test server has the guild-scoped `/session` command. It needs a running interaction endpoint to respond.

| Command | Purpose |
| --- | --- |
| `/session profile` | Privately view your saved name |
| `/session profile bungie_name:ExampleRunner#1234` | Save or change your own name |
| `/session profile clear:true` | Remove your saved name and all your stored sharing snapshots |
| `/session create` | Create a private draft; review it, then choose Publish or Discard |
| `/session find` | Open a real session in this channel and deliberately choose whether to join |
| `/session share session:<id> enabled:true` | Share or refresh your saved name for a joined session |
| `/session share session:<id> enabled:false` | Revoke future name access for that session |
| `/session cancel session:<id>` | Cancel a session you host |

The first implementation uses structured command fields. Example time values are `2026-12-12T12:00:00-08:00` and `2026-12-12T13:30:00-08:00`, with zone `America/Los_Angeles`. Use a future date when testing live. Discord timestamps display in the viewer's local zone; the card also records the organizer's source zone. Natural-language input will replace most repeated input in a later increment.

## Development server configuration

**The demo and tests do not need this section.** Use it when preparing a private Discord integration test with Codex.

Copy `.env.example` to `.env` and fill in your application's IDs and public verification key locally. The `.env` file is excluded from source control. The app token belongs only in your local environment or a hosting secret store, never in chat, a screenshot or committed source.

```bash
npm start
```

By default, the server listens at `127.0.0.1:3000`. `GET /health` returns only an availability check; `POST /interactions` accepts verified Discord interactions. The default database lives at `data/next-session.sqlite`.

Discord needs a reachable HTTPS interaction endpoint. Starting this local server alone does not connect Discord to it. A deliberate test setup must supply HTTPS routing, install the official app with appropriate permissions, configure the interaction endpoint, and register the guild-scoped command. The registration script modifies only this app's `/session` command in the chosen guild and is gated by `REGISTER_COMMANDS=yes`.

```bash
npm run register
```

Until that environment setting is deliberately enabled and credentials are configured, registration performs no network action. There is no background monitoring, reminder delivery or autonomous outreach in this starter.

## Important implementation limits

This increment does **not** contain AI interpretation, voice, notifications, a waitlist, recurring sessions, external account linking, automatic in-game invitations, payments or personal ratings. It does not verify activity unlocks, game ownership, cross-play settings or anyone's account ownership.

When the host presses **Publish**, SQLite opens the draft and saves the Discord interaction ID and session ID in one transaction. If the app restarts using the same database file, a retry of that interaction gets a private acknowledgement. A second click on an already-open session also gets a private reply. An in-memory database lasts only until shutdown.

If the app stops after committing but before Discord receives the public card, the session can appear in `/session find` even when the card is missing from the channel. Checking delivery and recovering that missing card remain future work. Other interaction types have process-local duplicate protection. Joining through a private search result or cancelling a session can leave the original card stale until someone presses **Refresh**.

The database is ordinary local SQLite, readable by the app operator. Clearing a name removes it from active records and sharing snapshots; this does not recall messages, screenshots or copies already made. Automatic data expiry, full account deletion and production backup/deletion behavior remain to be designed. No real participant dataset is bundled.

See [docs/NEXT-STEPS.md](docs/NEXT-STEPS.md) for the next milestone, [docs/PRODUCT.md](docs/PRODUCT.md) for accepted product decisions, and [VALIDATION.md](VALIDATION.md) for what was actually checked.

## Project layout

```text
src/store.ts                 Session rules and SQLite persistence
src/types.ts                 Domain contracts and public/private data shapes
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
