# Offline voice-room prototype

The lifecycle in `src/voice-rooms.ts` defaults to disabled. It requires an explicit guild-to-category map. The interaction server does not instantiate it, and cards and menus have no **Join voice** control.

- The first request from a currently confirmed participant in a scoped, open session creates one private room. Concurrent requests share that result. The mock room's user limit is the stored session capacity. The provisioning request includes the guild, designated category, limit, confirmed Discord user IDs, and a provisioning ID.
- A separate local SQLite registry saves the pending provisioning ID before creation and links the acknowledged room ID to the session. The mock treats a retry with the same provisioning ID as the same creation. Tests reopen the registry after a lost acknowledgement and recover the existing room.
- Cleanup checks only acknowledged room IDs in the registry. After two minutes of confirmed continuous emptiness, the adapter performs a final same-epoch, same-revision empty check. Moving, rejoining, uncertain presence, restarts, or reconnects reset the grace period as needed. A fresh authoritative missing-room result can clear a stale link. Unknown presence leaves the link in place.
- The epoch changes on a reconnect. The adapter must report uncertain presence until it has a complete fresh snapshot. The revision changes on every occupancy change, including when the count returns to a previous value between cleanup checks.

## Discord adapter exercised offline

`src/discord-voice-gateway.ts` consumes Discord-shaped Gateway dispatches and uses an injected REST function. Tests provide both inputs locally. The adapter verifies the configured category before sending a voice-channel create request. The payload sets the session’s seat limit, denies **View Channel** and **Connect** to the everyone role, and allows those permissions for the confirmed roster at the time of creation. [Discord guild channel creation](https://docs.discord.com/developers/resources/guild#create-guild-channel)

SQLite records the creation attempt before the POST. A recorded acknowledgement can be reused after a restart. An uncertain creation remains pending for an ownership check, so retries cannot create a second room or adopt a similarly named room. Cleanup recognizes only room IDs linked to an acknowledged Discord creation in the configured guild and category.

A complete available `GUILD_CREATE` seeds voice presence. Disconnects, sequence gaps, and resume without a fresh snapshot leave occupancy unknown. Voice moves invalidate the empty observation even if everyone leaves again between checks. A current `CHANNEL_DELETE` can prove removal. An absent channel on its own leaves the saved link in place. The final local guard rechecks category, ownership, and unchanged empty presence after looking up the room over REST. [Discord Gateway events](https://docs.discord.com/developers/events/gateway-events)

## Gates before live voice

1. Approve the category with each server owner and verify the minimum permissions, including how administrator access, roster changes, and cancellation affect who can connect.
2. Establish a manual recovery process for an uncertain creation or an absent tracked channel. Verify ownership before making any change.
3. Verify the Gateway transport, required intents, reconnect and fresh-snapshot behavior. Discord’s channel DELETE has no occupancy precondition. A player could join after the local check and before Discord processes deletion. Keep live cleanup disabled until that race is addressed. [Discord channel deletion](https://docs.discord.com/developers/resources/channel#deleteclose-channel)
4. Verify cleanup timing, failure recovery, and operational logging in a separately authorized pilot before exposing a voice control.
