# Private two-server beta

The first milestone checks one endpoint and one SQLite database with signed fictional interactions from two guilds. The existing single-pair configuration remains the default. Keep multi-server runs on fictional data until the launch gates below are met.

## Local pair allowlist

When `PILOT_ALLOWED_PAIRS` is absent, the endpoint uses exactly the pair in `PILOT_GUILD_ID` and `PILOT_CHANNEL_ID`. When the variable is set, it replaces that pair with the complete list below. Each entry consists of a guild ID and channel ID separated by a colon. Separate entries with commas and list each channel once. Empty or malformed lists fail at startup.

```text
PILOT_ALLOWED_PAIRS=100000000000000002:100000000000000003,100000000000000010:100000000000000011
```

After signature and application checks, Discord’s top-level guild and channel IDs must match the same configured pair. The user comes from `member.user.id` in that signed interaction. A guild from one entry combined with a channel from another is refused, as are DMs and unlisted pairs. An allowlist change affects the endpoint’s acceptance rules only. The separate registration tool still targets one explicit `PILOT_GUILD_ID`.

## SQLite isolation audit

| Area | Current boundary |
| --- | --- |
| Open sessions and drafts | Both lists filter by guild and channel. Drafts also filter by host and draft status. Reopening checks ownership, scope, and status again. |
| Session actions and public card links | Viewing, editing, publishing, joining, leaving, cancelling, and changing sharing look up the session in the actor’s guild and channel before proceeding. Public card receipts must match a session in that pair. |
| Group IDs and consent | Sharing and revocation update only the membership row for that session. Private name retrieval requires current membership in the scoped session. Saving a profile does not update existing session snapshots. |
| Saved profiles | Databases that have gone through the opt-in cutover scope profile access and snapshot clearing to the actor’s guild. Unconverted databases still use the legacy global profile table and must stay single-server for real data. |

The signed local test exercises both guilds on the same endpoint and store, including the same host and guest accounts in both. It verifies that lookups and mutations for a session ID from the other server are refused and that revoking an opted-in snapshot in one session leaves the other session’s snapshot intact.

## Guild-scoped profile cutover rehearsal

The fictional test closes its legacy SQLite store and reopens it using `new SessionStore(path, clock, { guildScopedProfiles: true })`. A single transaction creates the empty `guild_profiles` table, clears legacy name snapshots from memberships and weekend drafts, advances affected private draft revisions, and retires the global table. Sessions, drafts, and rosters remain available. Later restarts recognize the guild-scoped table automatically.

Signed fictional interactions verify that the same account can save different names in two guilds. Saving leaves session consent off until the member explicitly shares. Clearing removes the caller’s name and snapshots across their channels in that guild, including affected drafts. It leaves their other guild intact. The standard server has no environment switch to initiate cutover.

For a real transition, approve a maintenance window, pause writes, and test a backup and isolated restore first. Use the guild-scoped code after cutover. Keep older binaries and pre-cutover backups isolated and define retention and deletion before enabling a real two-server beta. Participants enter their name again in the guild where they want to save it.

## Launch gates

- **Profile privacy.** Complete the guild-scoped cutover and isolation checks on a test copy. Demonstrate explicit per-session sharing, revocation, and guild-scoped clearing before adding real participant data.
- **Stable HTTPS.** Verify a stable HTTPS interaction URL with valid TLS, signature checks, health monitoring, and a restart test. Plan and approve a separate beta setup that leaves the existing CoHop smoke test in place.
- **Backups and deletion.** Decide what data to retain, who can access it, and when backups expire. Test a consistent SQLite backup and isolated restore. Test removing profiles, sharing snapshots, and server data, including how a restore reapplies deletions before going live.
- **Owner consent.** Obtain explicit agreement from each server owner for the named guild and channel, the testing window, participant access, and a contact for moderation, removal, and data requests. Participants still choose individually whether to save and share a Bungie Name.
