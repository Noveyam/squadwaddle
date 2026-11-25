import assert from "node:assert/strict";
import { SessionStore } from "./store.ts";
import type { Actor } from "./types.ts";

// Fixed, fictional examples. No Discord or Bungie connection is made.
const clock = () => new Date("2026-12-10T18:00:00Z");
const store = new SessionStore(":memory:", clock);
const actor = (userId: string): Actor => ({
  userId, guildId: "demo-community", channelId: "demo-sessions",
});
const host = actor("demo-host");
const player = actor("demo-player");
const privatePlayer = actor("demo-private-player");
const outsider = actor("demo-outsider");

function show(title: string, value: unknown) {
  console.log(`\n${title}\n${JSON.stringify(value, null, 2)}`);
}

try {
  console.log("SquadWaddle local demo with fictional players.");
  store.saveProfile(host, "ExampleHost#1234");
  store.saveProfile(player, "ExampleRunner#5678");
  const draft = store.createDraft(host, {
    activity: "Expedition learning session — activity rules to be checked in-game",
    startAt: "2026-12-12T12:00:00-08:00",
    endAt: "2026-12-12T13:30:00-08:00",
    timeZone: "America/Los_Angeles",
    expectations: "Patient pace. Learning welcome. Finish at 1:30 pm even if the run series is unfinished.",
    platformNotes: "Confirm cross-play and activity access together before starting.",
  }, true);
  show("1. Host privately previews a three-seat session (host uses one seat)", draft);
  store.publish(host, draft.id);
  store.join(player, draft.id, true);
  store.join(privatePlayer, draft.id, false);
  const publicCard = store.getSession(host, draft.id);
  assert.equal(publicCard.members.length, 3);
  assert.ok(!JSON.stringify(publicCard).includes("ExampleHost#1234"));
  show("2. Public card has three participants and no Bungie Names", publicCard);
  assert.throws(() => store.join(outsider, draft.id, false));
  console.log("\n3. A fourth player cannot take a fourth seat.");
  show("4. Private participant-only group list — fictional names", store.getSharedNames(player, draft.id));
  assert.throws(() => store.getSharedNames(outsider, draft.id));
  console.log("\n5. A spectator cannot retrieve the group’s game IDs.");
  store.setSharing(player, draft.id, false);
  assert.equal(store.getSharedNames(host, draft.id).find(m => m.userId === player.userId)?.bungieName, null);
  console.log("\n6. Revoking sharing removes that name from future group lookups.");
  store.leave(player, draft.id);
  assert.throws(() => store.getSharedNames(player, draft.id));
  store.join(outsider, draft.id, false);
  console.log("\n7. Leaving removes group-ID access and makes the seat available again.");
  console.log("\nDemo complete. Run npm test to check the underlying rules.");
} finally {
  store.close();
}
