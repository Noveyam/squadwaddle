# Multi-server and voice safety checkpoint

The first live text pilot needs one approved server and one consenting guest. Keep live voice and automatic deletion off throughout text testing. The local signed tests use fictional servers, accounts, Gateway events, and REST replies.

## Two-server text isolation

- [ ] Before accepting a second server, obtain approval for its exact private guild and channel. Confirm each signed interaction matches one complete pair. Try a valid guild ID combined with the other channel ID and confirm refusal.
- [ ] Use the same consenting account in both fictional scopes or in both separately approved servers. Check that each server lists only its own sessions and drafts. Try the other session’s ID for opening, editing, joining, or group IDs. Expect a refusal and unchanged state.
- [ ] Save a distinct fictional name in each guild on a cutover database. Verify that saving leaves consent off and only an explicit choice shares a name with confirmed teammates. Clear the first profile and verify the other guild keeps its saved name and opted-in snapshot. [Pair configuration and profile cutover](TWO-SERVER-BETA.md)

## Profile cutover and rollback

- [ ] Keep the legacy store single-server. Before an approved real cutover, pause writes, take a protected consistent backup, and use a separate isolated candidate. Rehearse the transition on fictional data first. Confirm it keeps sessions and rosters, starts with an empty guild-profile table, clears old snapshots, and invalidates affected old draft previews.
- [ ] Keep any pre-cutover backup isolated from the app endpoint. If recovery requires it, restore into a new copy and reapply the guild-scoped cutover before attaching any route. Check both guilds again and reconcile later membership changes, deletions, and revocations before reopening. Restoring from an earlier point can drop legitimate later changes. Keep the prior working copy untouched until recovery is verified.
- [ ] Use a build that understands guild-scoped profiles after cutover. A binary that expects the old global schema or a backup that still contains global names must stay offline. No real schema change was made in this checkpoint.

## Voice stays off

- [ ] Record the exact guild, text channel, and separate voice category proposed for future approval. Review category visibility, connect permissions, and administrator overrides with the server owner before approving any live permission changes.
- [ ] Compare the session’s current confirmed roster with access to the room. The offline adapter sends overwrites for the roster at creation. It does not reconcile Discord access after a join, leave, or cancellation, so the room cannot yet serve as a live roster boundary. There is no microphone or audio handling.
- [ ] Treat disconnect, lost events, and a resume without a fresh trusted snapshot as unknown occupancy. A restart requires a new trusted snapshot. An uncertain provisioning result needs ownership verification before any retry or adoption.
- [ ] Leave rooms alone if they are occupied, uncertain, untracked, moved, or out of scope. Offline cleanup tests use a two-minute continuous empty interval and a final ownership, category, and occupancy check. Keep automatic deletion off in Discord. A player can join between that last check and Discord processing the deletion. [Offline voice guards and remaining gates](VOICE-ROOMS.md)

## What needs another person or server

| Check | What is needed |
| --- | --- |
| Signed isolation, profile rollback, voice safeguards, and local container startup | Fictional data on one machine. |
| Private preview visibility, joining, and shared-name access in the real Discord client | One consenting guest and one approved private server. [Two-seat runbook](TWO-SEAT-PILOT.md) |
| Real cross-server isolation and guild-scoped profile behavior | Two separately approved servers and an authorized test account in both, using an approved cutover database. |
| Real voice visibility and roster changes | A separately approved voice test, a dedicated category, and participants who can verify both allowed and denied access. This checkpoint keeps those tests offline. |

Run the focused local checks with Node 24.

```sh
node --test --test-name-pattern 'across two allowed|fictional guild profile cutover|isolated pre-cutover backup|signed voice pilot|voice moves change revision|Discord cleanup' \
  test/discord.test.ts test/profile-rollback.test.ts test/discord-voice-gateway.test.ts
```
