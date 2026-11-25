# Verification record

## MacBook check · November 25, 2026

Novey ran `npm test` in macOS Terminal with the bundled Node.js 24.22.3 runtime selected. **All 54 tests passed, with 0 failures and 0 skipped.** This run included the signed HTTP request checks and the full session flow through the local HTTP server and SQLite.

The Mac's default Node.js was 18.12.1. The earlier managed-workspace run used the bundled runtime and completed the fictional demo. Two HTTP tests in that run stopped at `listen EPERM` when the workspace blocked a local port. Both passed in Terminal. The next check is the [private Discord test](docs/PRIVATE-DISCORD-TEST.md).

## Earlier Linux verification

Verified November 25, 2026 in the Linux workspace using **Node.js 24.22.3** and **npm 11.19.1**.

| Check | Result |
| --- | --- |
| `npm test` | **54 passed, 0 failed, 0 skipped** |
| Domain tests | 42 passed |
| Discord adapter and HTTP tests | 12 passed |
| `npm run demo` | Completed successfully; fictional local data only |
| External app registration | Not performed |
| Live Discord server test | Not performed |
| Hosting/deployment | Not performed |
| Static TypeScript type check | Not configured; native execution strips types |

## What the checks establish

The domain tests cover host-inclusive capacity, private drafts, publication ownership, repeat joins, saving profiles without sharing, independent consent across sessions, explicit public projections, guild/channel scope, participant-only ID access, revocation, leaving, clearing saved names, cancellation, date/time validation, end-time boundaries and actual database close/reopen persistence.

Transport tests check signature verification over the raw request, timestamp freshness, body/content-type limits, configured application and guild/channel scope, trusted actor identity, private response flags, mention suppression, escaped text, Discord content-size limits, duplicate request handling and guarded registration. Registration tests replace network access with a fake fetch function.

One integrated test runs a real in-memory SQLite store through a local HTTP server with generated Ed25519 signing keys. It exercises private draft creation, deliberate publication, both sharing choices, private ID access, outsider denial, revocation and leaving. This tests the local integration without real platform credentials.

## What remains unverified

On November 25, 2026, the SquadWaddle app was installed with the application-commands scope in the private CoHop test server, and the guild-scoped /session command was registered. Discord accepted the temporary HTTPS interactions endpoint. In #session-test, /session profile returned a private reply marked Only you can see this, with no Bungie Name stored in the fresh in-memory database. The temporary endpoint was removed and the tunnel and test server stopped afterward.

Live multi-user joining, placement in the session roster, and Bungie Name sharing and revocation still need testing with consenting participants. No game account has been linked or queried. No activity unlock or compatibility has been verified by this app.

The starter does not provide durable request reconciliation, guaranteed notification delivery, canonical-card synchronization, production retention/deletion, deployment resilience or validated demand. Those are explicit next milestones, not claims established by the passing tests.
