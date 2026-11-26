# Offline voice-room prototype

The lifecycle in `src/voice-rooms.ts` is exercised with a mocked Discord/Gateway adapter. The interaction server does not instantiate it. It defaults to disabled, with explicit opt-in by guild and a designated voice category for each enabled guild. Cards and menus have no **Join voice** control.

- The first request from a currently confirmed participant in a scoped, open session creates one private room. Concurrent requests share that result. The mock room's user limit is the stored session capacity. The provisioning request includes the guild, designated category, limit, confirmed Discord user IDs, and a provisioning ID.
- A separate local SQLite registry saves the pending provisioning ID before creation and links the acknowledged room ID to the session. The mock treats a retry with the same provisioning ID as the same creation. Tests reopen the registry after a lost acknowledgement and recover the existing room.
- Cleanup checks only acknowledged room IDs in the registry. After two minutes of confirmed continuous emptiness, the adapter performs a final same-epoch, same-revision empty check. Moving, rejoining, uncertain presence, restarts, or reconnects reset the grace period as needed. A fresh authoritative missing-room result can clear a stale link. Unknown presence leaves the link in place.
- The epoch changes on a reconnect. The adapter must report uncertain presence until it has a complete fresh snapshot. The revision changes on every occupancy change, including when the count returns to a previous value between cleanup checks.

## Gates before a live adapter

1. Approve the voice category and opt-in with each server owner. Verify the smallest role and category permissions needed for creation and removal. Verify capacity enforcement and that only current confirmed players can connect, including after roster changes or cancellation. The mock supplies the roster at creation and rechecks authorization on room requests. It does not reconcile live channel permission overwrites.
2. Verify how a live adapter can recover after a lost channel-creation acknowledgement. The local registry is durable, and retry idempotency is a mock-adapter contract. Verify a mechanism that proves room ownership before rebinding or retrying and that avoids adopting member-created channels.
3. Verify authoritative presence snapshots, missed events, reconnect recovery, and a final guard that prevents cleanup from racing a join. Preserve the room whenever the adapter cannot establish that it is safe to delete. The conditional deletion contract is verified by the mock only.
4. Verify cleanup timing, failure recovery, and operational logging with fictional participants in a separately authorized environment before exposing a voice control.
