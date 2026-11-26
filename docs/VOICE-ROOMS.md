# Offline voice-room prototype

The standard server and draft-only mode keep voice disabled. The signed interaction tests call `createInteractionServer` with explicit `voiceScopes` entries containing a guild, one approved text channel, and a separate voice category. They also inject a SQLite registry and a fictional REST function. The returned pilot receives fictional Gateway dispatches and explicit cleanup ticks. The server CLI supplies none of those dependencies. There is no Gateway socket, background cleanup timer, microphone access, or audio handling.

In an enabled test scope, a published card shows **Join voice**. Only a confirmed member of that open session can request its room. The request is refused until a fresh guild snapshot confirms the configured category. When a new room has REST acknowledgement but its presence is still unknown, press the button again after the Gateway confirms the room. The private link is returned only for a tracked room with known presence.

- The first eligible request creates one private room. Concurrent requests share that result. The new room’s user limit is the stored session capacity. Its creation payload includes only the then-confirmed roster in the configured category.
- A separate local SQLite registry saves the pending provisioning ID before creation and links the acknowledged room ID to the session. The mock treats a retry with the same provisioning ID as the same creation. Tests reopen the registry after a lost acknowledgement and recover the existing room.
- Cleanup checks only acknowledged room IDs in the registry. After two minutes of confirmed continuous emptiness, the adapter performs a final same-epoch, same-revision empty check. Moving, rejoining, uncertain presence, restarts, or reconnects reset the grace period as needed. A fresh authoritative missing-room result can clear a stale link. Unknown presence leaves the link in place.
- The epoch changes on a reconnect. The adapter must report uncertain presence until it has a complete fresh snapshot. The revision changes on every occupancy change, including when the count returns to a previous value between cleanup checks.

## Discord adapter exercised offline

`src/discord-voice-gateway.ts` consumes Discord-shaped Gateway dispatches and uses an injected REST function. Tests provide both inputs locally. The adapter verifies the configured category before sending a voice-channel create request. The payload sets the session’s seat limit, denies **View Channel** and **Connect** to the everyone role, and allows those permissions for the confirmed roster at the time of creation. [Discord guild channel creation](https://docs.discord.com/developers/resources/guild#create-guild-channel)

SQLite records the creation attempt before the POST. A recorded acknowledgement can be reused after a restart. An uncertain creation remains pending for an ownership check, so retries cannot create a second room or adopt a similarly named room. Cleanup recognizes only room IDs linked to an acknowledged Discord creation in the configured guild, text channel, and category. Older receipts with no text channel remain outside the pilot’s cleanup scope.

A complete available `GUILD_CREATE` seeds voice presence. Disconnects, sequence gaps, and resume without a fresh snapshot leave occupancy unknown. Voice moves invalidate the empty observation even if everyone leaves again between checks. A current `CHANNEL_DELETE` can prove removal. An absent channel on its own leaves the saved link in place. The final local guard rechecks category, ownership, and unchanged empty presence after looking up the room over REST. [Discord Gateway events](https://docs.discord.com/developers/events/gateway-events)

## Gates before live voice

1. Approve the category with each server owner and verify the minimum permissions, including how administrator access, roster changes, and cancellation affect who can connect.
2. Establish a manual recovery process for an uncertain creation or an absent tracked channel. Verify ownership before making any change.
3. Verify the Gateway transport, required intents, reconnect and fresh-snapshot behavior. Discord’s channel DELETE has no occupancy precondition. A player could join after the local check and before Discord processes deletion. Keep live cleanup disabled until that race is addressed. [Discord channel deletion](https://docs.discord.com/developers/resources/channel#deleteclose-channel)
4. Verify cleanup timing, failure recovery, and operational logging in a separately authorized pilot before exposing a voice control.
