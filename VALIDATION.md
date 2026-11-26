# Verification record

## Private Discord smoke test · November 25, 2026

In a private test channel, Discord accepted the temporary signed interaction endpoint and guild-only command. An unsigned request was rejected. A real `/session create` returned a private draft for the requested time, with three seats and ID sharing off. Discard confirmed that no card was published. The endpoint and tunnel were then closed and the prior guild registration restored. This did not test live voice, publishing, or the two-hour default.

## Combined local checkpoint · November 25, 2026

The two-hour draft default and the default-off voice adapter were tested together: 82 automated tests, the signed rehearsal, and the demo passed. No voice rooms were created in Discord.

## Discord voice adapter offline · November 25, 2026

Fictional Gateway and REST inputs exercised default-off category scoping, room capacity and roster permission payloads, and a durable creation attempt that prevents a second POST after a lost acknowledgement. Cleanup refused rooms without a Discord creation receipt, rooms moved out of the category, and rooms whose occupancy changed during the final check. Disconnect, a sequence gap, and resume without a fresh guild snapshot left occupancy unknown.

On Node 24.22.3 with networking denied, all 81 tests passed. The demo and signed solo rehearsal also passed. The adapter remains disconnected from the live server. [Voice pilot gates](docs/VOICE-ROOMS.md)

## Variable capacity and mocked voice recovery · November 25, 2026

Signed fictional interactions verified the three-seat default, “two more” as three total, four and six total seats, and private clarification for ambiguous, conflicting, fractional, or out-of-range counts. A host changed four seats to six in the private draft and kept the existing sharing choice. The prior Publish button was stale. Discovery and the public card displayed the approved size, and competing joins for the last seat kept the six-player roster at six. Four-player joins and eight maximum-length shared names were also checked.

A date-only weekend draft kept its original six seats across reopening, took an explicit edit to four, and carried four seats into the timed preview and final card. Synthetic pre-capacity timed and weekend rows reopened at three seats. A separate file-backed test verified that a published six-seat session kept its size after reopening.

The mock received independent three- and six-player room limits. Tests covered concurrent first requests, movement and rejoining, a lost creation acknowledgement followed by local SQLite recovery, and no early cleanup after restart, uncertainty, or reconnect. An untracked room was outside the deletion path. Live permissions and a live provisioning and presence adapter remain [launch gates](docs/VOICE-ROOMS.md).

On Node 24.22.3 with networking denied, all 77 tests passed, the demo completed, and the offline rehearsal passed.

## Compact workflow, weekend drafts, and offline voice · November 25, 2026

Signed fictional interactions exercised the three-item command definition, private Help and draft recovery, the Edit form and optional platform, explicit Bungie ID choices, stale-preview rejection, host-only Publish, and confirmed cancellation. Join on a stale public card returned a cancelled rendering in place. The offline rehearsal exercised both join choices, private sharing, revocation, leaving, and the cancellation refresh.

The exact-time test resolved Friday from a November 25 reference to November 27, 2026. Its noon–3 pm UTC timestamps corresponded to 4–7 am Pacific. Weekend tests verified date-only storage and recovery across a SQLite restart, different weekends across a UTC/Pacific day boundary, and refusal to publish before the host reviewed a valid single-day slot. Conversion kept the same draft ID and sharing choice.

After the workflow tests passed, the mocked voice lifecycle verified default-off guild opt-in, one room for simultaneous confirmed-player requests, cleanup of tracked bot-created IDs after two minutes, and a fresh empty-room recheck after occupancy changes or reconnects. The [voice notes](docs/VOICE-ROOMS.md) record the live permission, persistence, and presence gates. The local command flow exposes no voice control.

On Node 24.22.3 with networking denied, all 73 tests passed, the demo completed, and the offline rehearsal passed. Live registration, rendering, permissions, and Gateway behavior remain unverified.

## Two-server scope and isolation · November 25, 2026

One endpoint and one in-memory SQLite database accepted signed fictional interactions from two configured guild/channel pairs. The test rejected DMs, unlisted pairs, and both mixed guild/channel combinations. The same users in both guilds could see only their channel’s published sessions and their own drafts. Cross-scope opening, editing, publishing, joining, and group-ID or sharing requests were refused. Revoking one session’s shared name left the other session’s private snapshot intact.

Configuration tests verified the single-pair default, explicit replacement, and rejection of empty or malformed lists. The [beta plan](docs/TWO-SERVER-BETA.md) records the global-profile gap, a future guild-scoped cutover, and the launch gates. This milestone used fictional data and the existing profile schema.

On Node 24.22.3 with networking denied, all 67 tests passed, the demo completed, and the offline rehearsal passed.

## Private draft recovery · November 25, 2026

After closing and reopening file-backed SQLite, signed fictional interactions used `/session drafts` to find six unpublished drafts across two private pages. The list omitted published and discarded sessions, other hosts’ drafts, drafts from other guilds or channels, and Bungie Names, including a name entered as an activity. A copied Open button was refused for another user, guild, or channel. Old picker entries were refused after publication or discard.

Opening the draft from page two returned the latest private preview and sharing choice. The draft ID, revision, contents, and draft list stayed the same. The original Publish button remained stale, and the updated button published only when pressed by the host.

On Node 24.22.3 with networking denied, all 66 tests passed, the demo completed, and the offline rehearsal passed. Live command rendering and registration remain unverified.

## Private draft corrections · November 25, 2026

Signed fictional interactions exercised `/session edit-draft` against file-backed SQLite. A replacement sentence moved Expedition practice, a second edit renamed it, and the updated preview kept the session ID and original Bungie Name snapshot. A structured overnight edit showed both dates and kept sharing off. Invalid input and attempts by another user or in another server or channel left the draft intact.

Older Publish and Discard buttons were refused after editing. Reopening SQLite did not make an old edit or Publish replay valid. The host could reopen the current preview by session ID and publish that revision explicitly. The migration check also verified that a draft created before revision tracking could still publish from its original preview at revision zero.

On Node 24.22.3 with networking denied, all 65 tests passed, the demo completed, and the offline solo rehearsal passed. Live command registration and rendering remain unverified.

## Offline solo rehearsal · November 25, 2026

The [VS Code rehearsal command](README.md#offline-solo-rehearsal) ran one signed end-to-end scenario with fictional users, a fixed clock, and in-memory SQLite. It checked the private text draft for the December 11 Expedition practice session, empty search before Publish, and the host-only Publish button. Both join choices filled the remaining seats without exposing Bungie Names on the public card. Only confirmed players could request shared names privately. Revoking hid the host’s name on future lookups, leaving removed the guest’s name and access, and cancellation removed the session from search.

On Node 24.22.3 with networking denied, the rehearsal passed all six checkpoints, `npm test` passed all 64 tests, and `npm run demo` completed. The full suite used local streams for its two loopback tests.

## Private hints for incomplete scheduling sentences · November 25, 2026

Fictional command interactions got a specific private reply for missing AM or PM, end time, or time zone. None of the incomplete requests called the store. A corrected request created one private draft. The existing signed local tests still covered the preview and explicit Publish flow. On Node 24.22.3, all 63 tests passed and the fictional demo completed.

## Activity names in scheduling sentences · November 25, 2026

A signed fictional request through the local endpoint saved **Expedition practice** in the SQLite draft and showed it in the private preview. The title appeared on the session card after the host published, and discovery remained empty until then. The weekday and calendar-date examples without an activity still used **Group play**. Command tests covered mixed-case activity names and rejection of an empty activity, a Bungie Name in the activity, and a sentence over 160 characters. On Node 24.22.3, all 62 tests passed and the fictional demo completed.

## Calendar dates in scheduling sentences · November 25, 2026

With the clock fixed to November 25, a signed fictional interaction through the local endpoint created a private SQLite draft for Friday, December 11, 2026, from 6:30 pm to 8:00 pm Pacific. The draft stored December 12 at 02:30–04:00 UTC. A guest's discovery returned no open sessions before Publish and found the same session after the host published it. A saved Bungie Name stayed private when sharing was omitted.

Command tests covered the weekday syntax, a valid leap day, invalid calendar dates, the Pacific date boundary, starts at or before the current time, and skipped and repeated times during daylight-saving changes. On Node 24.22.3, all 61 tests passed and the fictional demo completed.

## Local scheduling sentence · November 25, 2026

With Node 24.22.3, all 59 tests passed and the fictional demo completed. A generated signature and an in-memory SQLite database exercised `/session create-text` through the local `POST /interactions` handler over streams. The test verified the exact start and end in the private preview, the host taking one of three seats, draft invisibility in discovery, host-only publication, and a saved Bungie Name staying private when sharing is omitted.

Command tests also covered UTC, Pacific daylight and standard time, weekday resolution at the UTC date boundary, and private rejection of ambiguous times and unsupported requests. Guild registration and live Discord rendering of the new subcommand remain unverified.

## Public card discovery and private pilot rehearsal · November 25, 2026

On the Mac, `npm test` passed all 56 tests with Node 24.22.3. The managed workspace denied permission to bind a TCP port. The two affected tests exercised the production HTTP parser and handler over local streams, with all assertions enabled. The fictional demo completed.

The signed HTTP rehearsal covered a private preview, explicit publication, joining with and without sharing, fourth-seat rejection, private group IDs, revocation, leaving, cancellation and refreshing the public roster. A matching public button interaction produced a link to the original message. The migration test reopened a database with the previous table layout, checked that unrelated and private messages produced no link, and confirmed that a recorded link survived another restart.

These checks used generated keys and fictional Discord messages. The live pilot still needs to confirm the link appears after a button press and opens the expected channel message. The implementation checks the message's originating component interaction against the saved Publish receipt. [Discord message interaction metadata](https://docs.discord.com/developers/resources/message#message-interaction-metadata-object)

## Publish retry after restart · November 25, 2026

The new regression sends signed Publish requests through the production `POST /interactions` handler and Node's HTTP parser using local streams. A forced receipt-write failure leaves the session in draft, and a retry then succeeds. Reopening the same SQLite file with a fresh server and repeating the original request returns a private acknowledgement. Cancellation survives replay, and reusing the interaction ID cannot publish a different draft.

A separate check used a database created by the previous revision and repeated the identical signed request in two independent Node processes. Only the first returned a public card. An already-open session from the previous revision continued to reject publication.

With Node 24.22.3, `npm run demo` completed. Of 55 tests, 53 passed in the managed workspace. The two existing TCP tests stopped at `listen EPERM` on `127.0.0.1`. The new stream-based HTTP regression passed. Actual Discord delivery and recovery of a missing public card remain unverified.

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
