import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DomainError, SessionStore } from "../src/store.ts";
import type { Actor, PublicSession, SessionInput } from "../src/types.ts";

const FIXED_NOW = "2026-12-08T12:00:00.000Z";
const HOST: Actor = { userId: "host", guildId: "guild-a", channelId: "channel-a" };
const ALICE: Actor = { ...HOST, userId: "alice" };
const BOB: Actor = { ...HOST, userId: "bob" };
const CAROL: Actor = { ...HOST, userId: "carol" };
const HOST_NAME = "Quiet Host#1001";
const ALICE_NAME = "Patient Runner#1002";
const BOB_NAME = "Contract Runner#1003";

const INPUT: SessionInput = {
  activity: "Expedition: patient learning and contracts",
  startAt: "2026-12-10T19:00:00-08:00",
  endAt: "2026-12-10T20:30:00-08:00",
  timeZone: "America/Los_Angeles",
  expectations: "Learning together; no instructor or completion guarantee.",
  platformNotes: "Mixed platforms; crossplay enabled.",
};

function makeStore(t: TestContext, now: () => Date = () => new Date(FIXED_NOW)) {
  const store = new SessionStore(":memory:", now);
  t.after(() => store.close());
  return store;
}

function openSession(store: SessionStore, actor = HOST, shareName = false) {
  const draft = store.createDraft(actor, { ...INPUT }, shareName);
  return store.publish(actor, draft.id);
}

function expectCode(action: () => unknown, code: string) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof DomainError, "Expected a domain error");
    assert.equal(error.code, code);
    return true;
  });
}

function namesByUser(store: SessionStore, actor: Actor, id: string) {
  return Object.fromEntries(
    store.getSharedNames(actor, id).map((member) => [member.userId, member.bungieName]),
  );
}

function assertPublic(session: PublicSession, privateNames: string[] = []) {
  assert.deepEqual(Object.keys(session).sort(), [
    "activity", "capacity", "channelId", "endAt", "expectations", "game",
    "guildId", "hostUserId", "id", "members", "platformNotes", "startAt",
    "status", "timeZone",
  ].sort());
  for (const member of session.members) {
    assert.deepEqual(Object.keys(member).sort(), ["isHost", "userId"]);
  }
  const serialized = JSON.stringify(session);
  for (const name of privateNames) {
    assert.ok(!serialized.includes(name), "A public session exposed a private game name");
  }
}

test("the host occupies one of three seats from draft creation", (t) => {
  const store = makeStore(t);
  const draft = store.createDraft(HOST, { ...INPUT });
  assert.equal(draft.status, "draft");
  assert.equal(draft.capacity, 3);
  assert.deepEqual(draft.members, [{ userId: HOST.userId, isHost: true }]);
  const published = store.publish(HOST, draft.id);
  assert.equal(published.status, "open");
  assert.deepEqual(published.members, draft.members);
});

test("a full three-person session rejects a fourth and leaving frees exactly one seat", (t) => {
  const store = makeStore(t);
  const session = openSession(store);
  store.join(ALICE, session.id);
  const full = store.join(BOB, session.id);
  assert.equal(full.members.length, 3);
  expectCode(() => store.join(CAROL, session.id), "SESSION_FULL");
  assert.equal(store.getSession(HOST, session.id).members.length, 3);
  store.leave(ALICE, session.id);
  const refilled = store.join(CAROL, session.id);
  assert.deepEqual(new Set(refilled.members.map((member) => member.userId)),
    new Set([HOST.userId, BOB.userId, CAROL.userId]));
});

test("only the host can publish or cancel a session", (t) => {
  const store = makeStore(t);
  const draft = store.createDraft(HOST, { ...INPUT });
  expectCode(() => store.publish(ALICE, draft.id), "FORBIDDEN");
  assert.equal(store.getSession(HOST, draft.id).status, "draft");
  store.publish(HOST, draft.id);
  expectCode(() => store.publish(HOST, draft.id), "ALREADY_PUBLISHED");
  store.join(ALICE, draft.id);
  expectCode(() => store.cancel(ALICE, draft.id), "FORBIDDEN");
  assert.equal(store.getSession(HOST, draft.id).status, "open");
});

test("unpublished drafts cannot accept joins or disclose group IDs", (t) => {
  const store = makeStore(t);
  store.saveProfile(HOST, HOST_NAME);
  const draft = store.createDraft(HOST, { ...INPUT }, true);
  expectCode(() => store.join(HOST, draft.id), "SESSION_NOT_OPEN");
  expectCode(() => store.getSharedNames(HOST, draft.id), "SESSION_NOT_OPEN");
  expectCode(() => store.join(ALICE, draft.id), "NOT_FOUND");
  expectCode(() => store.getSharedNames(ALICE, draft.id), "NOT_FOUND");
  expectCode(() => store.getSession(ALICE, draft.id), "NOT_FOUND");
  assert.deepEqual(store.listSessions(ALICE), []);
  assert.deepEqual(store.listSessions(HOST), []);
  assertPublic(store.getSession(HOST, draft.id), [HOST_NAME]);
});

test("saving an own profile once permits later explicit sharing across sessions", (t) => {
  const store = makeStore(t);
  store.saveProfile(ALICE, `  ${ALICE_NAME}  `);
  assert.deepEqual(store.getProfile(ALICE), { bungieName: ALICE_NAME });
  assert.deepEqual(store.getProfile(HOST), { bungieName: null });

  const first = openSession(store);
  store.join(ALICE, first.id, true);
  assert.equal(namesByUser(store, HOST, first.id)[ALICE.userId], ALICE_NAME);

  const elsewhere = { ...ALICE, guildId: "guild-b", channelId: "channel-b" };
  const second = openSession(store, elsewhere, true);
  assert.equal(namesByUser(store, elsewhere, second.id)[ALICE.userId], ALICE_NAME);
  assert.deepEqual(store.getProfile(elsewhere), { bungieName: ALICE_NAME });
});

test("a profile needs a complete Bungie Name including its four-digit suffix", (t) => {
  const store = makeStore(t);
  store.saveProfile(ALICE, ALICE_NAME);
  for (const invalid of ["", "   ", "JustAName", "Runner#123", "Runner#12345", "#1234"]) {
    expectCode(() => store.saveProfile(ALICE, invalid), "VALIDATION_ERROR");
    assert.deepEqual(store.getProfile(ALICE), { bungieName: ALICE_NAME });
  }
});

test("saving a profile does not opt a host or participant into sharing", (t) => {
  const store = makeStore(t);
  store.saveProfile(HOST, HOST_NAME);
  store.saveProfile(ALICE, ALICE_NAME);
  const session = openSession(store);
  store.join(ALICE, session.id);
  assert.deepEqual(namesByUser(store, ALICE, session.id), {
    [HOST.userId]: null,
    [ALICE.userId]: null,
  });
  const members = store.getSharedNames(ALICE, session.id);
  for (const member of members) {
    assert.ok(member.connectionNote.trim().length > 0,
      "A participant who did not share needs a manual-connection explanation");
  }
});

test("sharing without a saved profile fails without reserving a seat", (t) => {
  const store = makeStore(t);
  expectCode(() => store.createDraft(HOST, { ...INPUT }, true), "PROFILE_REQUIRED");
  assert.deepEqual(store.listSessions(HOST), []);
  const session = openSession(store);
  expectCode(() => store.join(ALICE, session.id, true), "PROFILE_REQUIRED");
  assert.equal(store.getSession(HOST, session.id).members.length, 1);
  store.join(ALICE, session.id, false);
  expectCode(() => store.setSharing(ALICE, session.id, true), "PROFILE_REQUIRED");
  assert.equal(namesByUser(store, HOST, session.id)[ALICE.userId], null);
});

test("each host chooses initial consent independently for each session", (t) => {
  const store = makeStore(t);
  store.saveProfile(HOST, HOST_NAME);
  const shared = openSession(store, HOST, true);
  const privateSession = openSession(store, HOST, false);
  assert.equal(namesByUser(store, HOST, shared.id)[HOST.userId], HOST_NAME);
  assert.equal(namesByUser(store, HOST, privateSession.id)[HOST.userId], null);
});

test("duplicate joins neither add seats nor silently change consent", (t) => {
  const store = makeStore(t);
  const session = openSession(store);
  store.join(ALICE, session.id, false);
  // A repeated Join & share request is not new consent, even without a profile.
  store.join(ALICE, session.id, true);
  assert.equal(namesByUser(store, HOST, session.id)[ALICE.userId], null);
  store.saveProfile(ALICE, ALICE_NAME);
  store.join(ALICE, session.id, true);
  assert.equal(namesByUser(store, HOST, session.id)[ALICE.userId], null);

  store.setSharing(ALICE, session.id, true);
  store.join(BOB, session.id);
  // A repeated join remains idempotent even when all seats are occupied.
  const repeated = store.join(ALICE, session.id, false);
  assert.equal(repeated.members.length, 3);
  assert.equal(namesByUser(store, HOST, session.id)[ALICE.userId], ALICE_NAME);
});

test("every public response excludes saved names and consent snapshots", (t) => {
  const store = makeStore(t);
  store.saveProfile(HOST, HOST_NAME);
  store.saveProfile(ALICE, ALICE_NAME);
  const privateNames = [HOST_NAME, ALICE_NAME];
  const draft = store.createDraft(HOST, { ...INPUT }, true);
  const responses: PublicSession[] = [draft, store.getSession(HOST, draft.id)];
  responses.push(store.publish(HOST, draft.id));
  responses.push(store.join(ALICE, draft.id, true));
  responses.push(store.getSession(CAROL, draft.id));
  responses.push(...store.listSessions(CAROL));
  responses.push(store.setSharing(ALICE, draft.id, false));
  responses.push(store.setSharing(ALICE, draft.id, true));
  responses.push(store.leave(ALICE, draft.id));
  responses.push(store.cancel(HOST, draft.id));
  for (const response of responses) assertPublic(response, privateNames);
});

test("only current confirmed participants can retrieve opted-in group IDs", (t) => {
  const store = makeStore(t);
  store.saveProfile(HOST, HOST_NAME);
  store.saveProfile(ALICE, ALICE_NAME);
  store.saveProfile(BOB, BOB_NAME);
  const session = openSession(store, HOST, true);
  store.join(ALICE, session.id, false);
  store.join(BOB, session.id, true);
  expectCode(() => store.getSharedNames(CAROL, session.id), "NOT_A_MEMBER");
  assert.deepEqual(namesByUser(store, ALICE, session.id), {
    [HOST.userId]: HOST_NAME,
    [ALICE.userId]: null,
    [BOB.userId]: BOB_NAME,
  });
});

test("guild and channel boundaries apply even to the correct host identity", (t) => {
  const store = makeStore(t);
  store.saveProfile(HOST, HOST_NAME);
  const session = openSession(store, HOST, true);
  for (const scopedActor of [
    { ...HOST, guildId: "guild-b" },
    { ...HOST, channelId: "channel-b" },
  ]) {
    const operations = [
      () => store.getSession(scopedActor, session.id),
      () => store.getSharedNames(scopedActor, session.id),
      () => store.publish(scopedActor, session.id),
      () => store.join(scopedActor, session.id),
      () => store.leave(scopedActor, session.id),
      () => store.setSharing(scopedActor, session.id, false),
      () => store.cancel(scopedActor, session.id),
    ];
    for (const operation of operations) expectCode(operation, "NOT_FOUND");
    assert.deepEqual(store.listSessions(scopedActor), []);
  }
  assert.equal(namesByUser(store, HOST, session.id)[HOST.userId], HOST_NAME);
});

test("a nonmember cannot change consent on a visible session", (t) => {
  const store = makeStore(t);
  store.saveProfile(ALICE, ALICE_NAME);
  const session = openSession(store);
  expectCode(() => store.setSharing(ALICE, session.id, true), "NOT_A_MEMBER");
  assert.equal(store.getSession(HOST, session.id).members.length, 1);
});

test("revoking sharing removes future name disclosure without removing membership", (t) => {
  const store = makeStore(t);
  store.saveProfile(HOST, HOST_NAME);
  store.saveProfile(ALICE, ALICE_NAME);
  const session = openSession(store, HOST, true);
  store.join(ALICE, session.id, true);
  assert.equal(namesByUser(store, HOST, session.id)[ALICE.userId], ALICE_NAME);
  store.setSharing(ALICE, session.id, false);
  assert.equal(namesByUser(store, HOST, session.id)[ALICE.userId], null);
  assert.equal(namesByUser(store, ALICE, session.id)[HOST.userId], HOST_NAME);
  assert.equal(store.getSession(HOST, session.id).members.length, 2);
  assert.deepEqual(store.getProfile(ALICE), { bungieName: ALICE_NAME });
});

test("leaving removes access and a fresh join does not restore old sharing consent", (t) => {
  const store = makeStore(t);
  store.saveProfile(ALICE, ALICE_NAME);
  const session = openSession(store);
  store.join(ALICE, session.id, true);
  store.leave(ALICE, session.id);
  expectCode(() => store.getSharedNames(ALICE, session.id), "NOT_A_MEMBER");
  assert.ok(!(ALICE.userId in namesByUser(store, HOST, session.id)));
  store.join(ALICE, session.id);
  assert.equal(namesByUser(store, HOST, session.id)[ALICE.userId], null);
});

test("the host cannot leave an open session and orphan its participants", (t) => {
  const store = makeStore(t);
  const session = openSession(store);
  store.join(ALICE, session.id);
  expectCode(() => store.leave(HOST, session.id), "HOST_CANNOT_LEAVE");
  assert.equal(store.getSession(HOST, session.id).members.length, 2);
});

test("cancellation is final and immediately disables joining and group-ID access", (t) => {
  const store = makeStore(t);
  store.saveProfile(HOST, HOST_NAME);
  store.saveProfile(ALICE, ALICE_NAME);
  const session = openSession(store, HOST, true);
  store.join(ALICE, session.id, true);
  const cancelled = store.cancel(HOST, session.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(store.cancel(HOST, session.id).status, "cancelled");
  expectCode(() => store.join(BOB, session.id), "SESSION_NOT_OPEN");
  expectCode(() => store.getSharedNames(HOST, session.id), "SESSION_NOT_OPEN");
  expectCode(() => store.getSharedNames(ALICE, session.id), "SESSION_NOT_OPEN");
  expectCode(() => store.setSharing(ALICE, session.id, true), "SESSION_NOT_OPEN");
  assertPublic(cancelled, [HOST_NAME, ALICE_NAME]);
  // A cancelled event must not silently become public again.
  expectCode(() => store.publish(HOST, session.id), "SESSION_NOT_OPEN");
  assert.equal(store.getSession(HOST, session.id).status, "cancelled");
});

test("clearing a profile removes that person's snapshots across sessions and guilds", (t) => {
  const store = makeStore(t);
  store.saveProfile(HOST, HOST_NAME);
  store.saveProfile(ALICE, ALICE_NAME);
  const first = openSession(store, HOST, true);
  store.join(ALICE, first.id, true);
  const otherScope = { ...HOST, guildId: "guild-b", channelId: "channel-b" };
  const second = openSession(store, otherScope, true);
  const draft = store.createDraft(HOST, { ...INPUT }, true);
  store.clearProfile(HOST);

  assert.deepEqual(store.getProfile(HOST), { bungieName: null });
  assert.deepEqual(store.getProfile(otherScope), { bungieName: null });
  assert.equal(namesByUser(store, ALICE, first.id)[HOST.userId], null);
  assert.equal(namesByUser(store, otherScope, second.id)[HOST.userId], null);
  store.publish(HOST, draft.id);
  assert.equal(namesByUser(store, HOST, draft.id)[HOST.userId], null);
  assert.equal(namesByUser(store, HOST, first.id)[ALICE.userId], ALICE_NAME);
  assert.deepEqual(store.getProfile(ALICE), { bungieName: ALICE_NAME });

  // Saving again must not reactivate any earlier session's sharing consent.
  store.saveProfile(HOST, "New Host#2001");
  assert.equal(namesByUser(store, ALICE, first.id)[HOST.userId], null);
  assert.equal(namesByUser(store, otherScope, second.id)[HOST.userId], null);
});

test("updating a profile does not silently replace an existing consent snapshot", (t) => {
  const store = makeStore(t);
  store.saveProfile(HOST, HOST_NAME);
  const first = openSession(store, HOST, true);
  const updatedName = "Updated Host#2001";
  store.saveProfile(HOST, updatedName);
  assert.deepEqual(store.getProfile(HOST), { bungieName: updatedName });
  assert.equal(namesByUser(store, HOST, first.id)[HOST.userId], HOST_NAME);
  const second = openSession(store, HOST, true);
  assert.equal(namesByUser(store, HOST, second.id)[HOST.userId], updatedName);
  store.setSharing(HOST, first.id, true);
  assert.equal(namesByUser(store, HOST, first.id)[HOST.userId], updatedName);
});

test("explicit numeric offsets normalize to UTC while retaining the display time zone", (t) => {
  const store = makeStore(t);
  const draft = store.createDraft(HOST, { ...INPUT });
  assert.equal(draft.startAt, "2026-12-11T03:00:00.000Z");
  assert.equal(draft.endAt, "2026-12-11T04:30:00.000Z");
  assert.equal(draft.timeZone, "America/Los_Angeles");
});

test("UTC timestamps with Z and UTC as the display zone are accepted", (t) => {
  const store = makeStore(t);
  const draft = store.createDraft(HOST, {
    ...INPUT,
    startAt: "2026-12-11T03:00:00Z",
    endAt: "2026-12-11T04:30:00Z",
    timeZone: "UTC",
  });
  assert.equal(draft.startAt, "2026-12-11T03:00:00.000Z");
  assert.equal(draft.timeZone, "UTC");
});

const INVALID_INPUTS: Array<[string, Partial<SessionInput>]> = [
  ["a start without an explicit UTC offset", { startAt: "2026-12-10T19:00:00" }],
  ["an end without an explicit UTC offset", { endAt: "2026-12-10T20:30:00" }],
  ["an invalid UTC offset", { startAt: "2026-12-10T19:00:00+25:00" }],
  ["invalid offset minutes", { startAt: "2026-12-10T19:00:00+05:75" }],
  ["24:00 time normalization", { startAt: "2026-12-10T24:00:00Z" }],
  ["February 30 calendar normalization", {
    startAt: "2027-02-30T12:00:00Z", endAt: "2027-03-03T12:00:00Z",
  }],
  ["February 29 in a non-leap year", {
    startAt: "2027-02-29T12:00:00Z", endAt: "2027-03-01T12:00:00Z",
  }],
  ["an impossible end date", {
    startAt: "2027-02-28T12:00:00Z", endAt: "2027-02-30T12:00:00Z",
  }],
  ["a nonexistent IANA zone", { timeZone: "Mars/Olympus" }],
  ["ambiguous PST shorthand", { timeZone: "PST" }],
  ["ambiguous PDT shorthand", { timeZone: "PDT" }],
  ["a missing display time zone", { timeZone: "" }],
  ["an end equal to the start", { endAt: INPUT.startAt }],
  ["an end earlier than the start", { endAt: "2026-12-10T18:59:59-08:00" }],
  ["a start exactly at the current time", { startAt: FIXED_NOW }],
  ["a start in the past", { startAt: "2026-12-08T11:59:59Z" }],
];

for (const [description, fields] of INVALID_INPUTS) {
  test(`draft validation rejects ${description} without saving an event`, (t) => {
    const store = makeStore(t);
    expectCode(() => store.createDraft(HOST, { ...INPUT, ...fields }), "VALIDATION_ERROR");
    assert.deepEqual(store.listSessions(HOST), []);
  });
}

test("a draft cannot be published after its start time arrives", (t) => {
  let currentTime = new Date(FIXED_NOW);
  const store = makeStore(t, () => new Date(currentTime));
  const draft = store.createDraft(HOST, { ...INPUT });
  currentTime = new Date(draft.startAt);
  expectCode(() => store.publish(HOST, draft.id), "VALIDATION_ERROR");
  assert.equal(store.getSession(HOST, draft.id).status, "draft");
});

test("a late participant may join after start but before the agreed end", (t) => {
  let currentTime = new Date(FIXED_NOW);
  const store = makeStore(t, () => new Date(currentTime));
  const session = openSession(store);
  currentTime = new Date(new Date(session.startAt).getTime() + 5 * 60_000);
  const joined = store.join(ALICE, session.id);
  assert.equal(joined.members.length, 2);
});

test("the exact end time closes joins, shared-name access, and new sharing consent", (t) => {
  let currentTime = new Date(FIXED_NOW);
  const store = makeStore(t, () => new Date(currentTime));
  store.saveProfile(HOST, HOST_NAME);
  store.saveProfile(ALICE, ALICE_NAME);
  const session = openSession(store, HOST, true);
  store.join(ALICE, session.id, true);
  currentTime = new Date(session.endAt);
  expectCode(() => store.join(BOB, session.id), "SESSION_ENDED");
  expectCode(() => store.getSharedNames(ALICE, session.id), "SESSION_ENDED");
  expectCode(() => store.setSharing(ALICE, session.id, true), "SESSION_ENDED");

  // Privacy-reducing actions remain possible after an event has ended.
  assert.doesNotThrow(() => store.setSharing(ALICE, session.id, false));
  assert.doesNotThrow(() => store.leave(ALICE, session.id));
  assert.equal(store.getSession(HOST, session.id).members.length, 1);
});

test("profiles, consent snapshots, membership, and cancellation survive reopening a database", () => {
  const directory = mkdtempSync(join(tmpdir(), "next-session-store-"));
  const databasePath = join(directory, "sessions.sqlite");
  const now = () => new Date(FIXED_NOW);
  let store: SessionStore | undefined;
  try {
    store = new SessionStore(databasePath, now);
    store.saveProfile(HOST, HOST_NAME);
    store.saveProfile(ALICE, ALICE_NAME);
    const session = openSession(store, HOST, true);
    store.join(ALICE, session.id, false);
    const cancelled = openSession(store, HOST, true);
    store.cancel(HOST, cancelled.id);
    const updatedName = "Renamed Host#2001";
    store.saveProfile(HOST, updatedName);
    store.close();
    store = undefined;

    store = new SessionStore(databasePath, now);
    assert.deepEqual(store.getProfile(HOST), { bungieName: updatedName });
    assert.deepEqual(store.getProfile(ALICE), { bungieName: ALICE_NAME });
    const reopened = store.getSession(HOST, session.id);
    assert.equal(reopened.status, "open");
    assert.deepEqual(new Set(reopened.members.map((member) => member.userId)),
      new Set([HOST.userId, ALICE.userId]));
    assert.deepEqual(namesByUser(store, ALICE, session.id), {
      [HOST.userId]: HOST_NAME,
      [ALICE.userId]: null,
    });
    assertPublic(reopened, [HOST_NAME, ALICE_NAME, updatedName]);
    assert.equal(store.getSession(HOST, cancelled.id).status, "cancelled");
    const reopenedStore = store;
    expectCode(() => reopenedStore.getSharedNames(HOST, cancelled.id), "SESSION_NOT_OPEN");
    store.clearProfile(HOST);
    store.close();
    store = undefined;

    store = new SessionStore(databasePath, now);
    assert.deepEqual(store.getProfile(HOST), { bungieName: null });
    assert.equal(namesByUser(store, ALICE, session.id)[HOST.userId], null);
    assert.deepEqual(store.getProfile(ALICE), { bungieName: ALICE_NAME });
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
