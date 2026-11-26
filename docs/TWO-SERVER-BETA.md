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
| Saved profile gap | Profiles are keyed by Discord user ID alone. The same user in two guilds can view or overwrite the same saved name. Explicit sharing can draw from that global name. Clearing the profile removes the global row and the user’s snapshots across guilds. |

The signed local test exercises both guilds on the same endpoint and store, including the same host and guest accounts in both. It verifies that lookups and mutations for a session ID from the other server are refused and that revoking an opted-in snapshot in one session leaves the other session’s snapshot intact.

## Planned guild-scoped profile cutover

1. Add a new `guild_profiles` table with primary key `(guild_id, user_id)`. Update profile reads, saves, and sharing lookups to use the verified actor’s guild and user ID. Keep the new table empty at cutover. Legacy profiles lack guild provenance, so membership, old snapshots, or a previous single-server setting cannot establish permission to copy a name.
2. Rehearse and approve the data transition on a separate test copy. At an authorized cutover, pause writes, create the empty table and clear pre-cutover name snapshots in session memberships and weekend drafts in a maintenance transaction. Retain sessions, drafts, and rosters. Resume with the guild-scoped code only. Participants enter a name inside the server where they want to save it and explicitly opt in per session.
3. Make profile clear remove only the caller’s guild profile and snapshots in sessions belonging to that guild. Define retirement and expiry for legacy records and backups before cutover. Restoring a pre-cutover copy must stay isolated until the privacy transition and relevant deletions have been reapplied.
4. Verify with fictional data that the same user can save different names in two guilds, that a missing guild profile cannot use the other guild’s name, and that clearing one guild leaves the other intact. Check that existing drafts and rosters survive without names and that each session starts sharing again only after an explicit choice.

This is a migration design. The first milestone changes the endpoint scope and its tests, with the existing profile schema still in use.

## Launch gates

- **Profile privacy.** Complete the guild-scoped cutover and isolation checks on a test copy. Demonstrate explicit per-session sharing, revocation, and guild-scoped clearing before adding real participant data.
- **Stable HTTPS.** Verify a stable HTTPS interaction URL with valid TLS, signature checks, health monitoring, and a restart test. Plan and approve a separate beta setup that leaves the existing CoHop smoke test in place.
- **Backups and deletion.** Decide what data to retain, who can access it, and when backups expire. Test a consistent SQLite backup and isolated restore. Test removing profiles, sharing snapshots, and server data, including how a restore reapplies deletions before going live.
- **Owner consent.** Obtain explicit agreement from each server owner for the named guild and channel, the testing window, participant access, and a contact for moderation, removal, and data requests. Participants still choose individually whether to save and share a Bungie Name.
