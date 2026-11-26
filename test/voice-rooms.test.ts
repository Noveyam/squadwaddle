import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/store.ts';
import { VoiceRooms, VOICE_EMPTY_GRACE_MS, type VoiceGateway, type VoicePresence } from '../src/voice-rooms.ts';
import { VoiceRoomRegistry } from '../src/voice-room-registry.ts';
import type { Actor } from '../src/types.ts';

const HOST: Actor = { userId: 'host', guildId: 'guild-a', channelId: 'text-a' };
const GUEST: Actor = { ...HOST, userId: 'guest' };
const INPUT = {
  activity: 'Expedition practice', startAt: '2026-11-27T12:00:00Z', endAt: '2026-11-27T15:00:00Z',
  timeZone: 'UTC', expectations: 'Finish on time', platformNotes: '',
};
type CreateRequest = Parameters<VoiceGateway['createPrivateRoom']>[0];
type Address = Parameters<VoiceGateway['presence']>[0];
type Proof = Parameters<VoiceGateway['deleteIfEmpty']>[1];

class MockGateway implements VoiceGateway {
  readonly creates: CreateRequest[] = [];
  readonly deletes: Address[] = [];
  readonly states = new Map<string, VoicePresence>();
  readonly provisioned = new Map<string, string>();
  readonly rooms = new Map<string, { request: CreateRequest; occupants: Set<string> }>();
  beforeDelete?: () => void;
  loseAcknowledgement = false;
  guards = 0;

  async createPrivateRoom(request: CreateRequest): Promise<string> {
    const existing = this.provisioned.get(request.provisionId);
    if (existing) return existing;
    this.creates.push(request);
    const roomId = `created-room-${this.creates.length}`;
    this.provisioned.set(request.provisionId, roomId);
    this.rooms.set(roomId, { request, occupants: new Set() });
    if (this.loseAcknowledgement) {
      this.loseAcknowledgement = false;
      throw new Error('Lost the mock creation acknowledgement.');
    }
    return roomId;
  }

  presence({ roomId }: Address): VoicePresence {
    return this.states.get(roomId) ?? { state: 'unknown' };
  }

  async deleteIfEmpty(address: Address, proof: Proof): Promise<boolean> {
    this.guards++;
    this.beforeDelete?.();
    const actual = this.presence(address);
    if (actual.state !== 'known' || actual.occupants !== 0 ||
        actual.epoch !== proof.epoch || actual.revision !== proof.revision) return false;
    this.deletes.push(address);
    this.rooms.delete(address.roomId);
    this.states.set(address.roomId, { state: 'missing' });
    return true;
  }

  move(userId: string, roomId?: string) {
    const target = roomId === undefined ? undefined : this.rooms.get(roomId);
    if (roomId !== undefined && (!target || !target.request.allowedUserIds.includes(userId) ||
        (!target.occupants.has(userId) && target.occupants.size >= target.request.capacity))) {
      throw new Error('The mock room is unavailable or full.');
    }
    for (const [id, room] of this.rooms) {
      if (id === roomId) {
        if (room.occupants.has(userId)) continue;
        room.occupants.add(userId);
      } else if (!room.occupants.delete(userId)) continue;
      const last = this.states.get(id);
      if (last?.state === 'known') this.observe(id, room.occupants.size, last.epoch, last.revision + 1);
    }
  }

  observe(roomId: string, occupants: number, epoch: number, revision: number) {
    this.states.set(roomId, { state: 'known', occupants, epoch, revision });
  }
}

function fixture(t: TestContext) {
  let time = Date.parse('2026-11-25T12:00:00Z');
  const now = () => time;
  const store = new SessionStore(':memory:', () => new Date(time));
  const registry = new VoiceRoomRegistry();
  t.after(() => { registry.close(); store.close(); });
  const gateway = new MockGateway();
  const categories = new Map([[HOST.guildId, 'voice-category-a'], ['guild-b', 'voice-category-b']]);
  const rooms = new VoiceRooms(store, gateway, registry, categories, now);
  const draft = store.createDraft(HOST, INPUT);
  const session = store.publish(HOST, draft.id);
  return { store, registry, rooms, gateway, session, now, advance: (ms: number) => { time += ms; } };
}

test('voice is disabled by default and provisions once on the first confirmed player request', async t => {
  const { store, registry, rooms, gateway, session, now } = fixture(t);
  assert.deepEqual(gateway.creates, []);
  const disabled = new VoiceRooms(store, gateway, registry);
  await assert.rejects(() => disabled.roomFor(HOST, session.id), /disabled/);
  await assert.rejects(() => rooms.roomFor(GUEST, session.id), /confirmed players/);
  await assert.rejects(() => rooms.roomFor({ ...HOST, guildId: 'guild-b' }, session.id), /not found/i);
  await assert.rejects(() => rooms.roomFor({ ...HOST, channelId: 'other-text' }, session.id), /not found/i);
  const unpublished = store.createDraft(HOST, INPUT);
  await assert.rejects(() => rooms.roomFor(HOST, unpublished.id), /open session/);
  assert.deepEqual(gateway.creates, []);

  store.join(GUEST, session.id);
  const ids = await Promise.all([rooms.roomFor(GUEST, session.id), rooms.roomFor(HOST, session.id)]);
  assert.deepEqual(ids, ['created-room-1', 'created-room-1']);
  assert.equal(gateway.creates.length, 1);
  assert.deepEqual(gateway.creates[0], {
    provisionId: registry.createdRooms()[0].provisionId, guildId: 'guild-a', categoryId: 'voice-category-a',
    capacity: 3, allowedUserIds: ['host', 'guest'],
  });
  store.leave(GUEST, session.id);
  await assert.rejects(() => rooms.roomFor(GUEST, session.id), /confirmed players/);
  store.cancel(HOST, session.id);
  await assert.rejects(() => rooms.roomFor(HOST, session.id), /open session/);
  assert.ok(now() < Date.parse(INPUT.endAt));
});

test('cleanup waits for continuous empty presence and acts only on rooms it created', async t => {
  const { rooms, gateway, session, advance } = fixture(t);
  gateway.observe('existing-server-room', 0, 1, 1);
  const roomId = await rooms.roomFor(HOST, session.id);
  gateway.observe(roomId, 2, 1, 1);
  await rooms.reapEmptyRooms();
  advance(VOICE_EMPTY_GRACE_MS);
  await rooms.reapEmptyRooms();
  assert.deepEqual(gateway.deletes, []);

  gateway.observe(roomId, 0, 1, 2);
  await rooms.reapEmptyRooms();
  advance(VOICE_EMPTY_GRACE_MS - 1);
  await rooms.reapEmptyRooms();
  assert.deepEqual(gateway.deletes, []);

  // Two Gateway changes occurred between cleanup passes.
  gateway.observe(roomId, 1, 1, 3);
  gateway.observe(roomId, 0, 1, 4);
  advance(1);
  await rooms.reapEmptyRooms();
  assert.equal(gateway.guards, 0);
  advance(VOICE_EMPTY_GRACE_MS);
  await rooms.reapEmptyRooms();
  assert.deepEqual(gateway.deletes, [{ guildId: HOST.guildId, roomId }]);
  assert.ok(gateway.states.has('existing-server-room'));
  assert.equal(await rooms.roomFor(HOST, session.id), 'created-room-2');
});

test('uncertain or reconnected presence restarts grace, including a reconnect during the final recheck', async t => {
  const { rooms, gateway, session, advance } = fixture(t);
  const roomId = await rooms.roomFor(HOST, session.id);
  gateway.observe(roomId, 0, 1, 1);
  await rooms.reapEmptyRooms();
  advance(VOICE_EMPTY_GRACE_MS);
  gateway.states.set(roomId, { state: 'unknown' });
  await rooms.reapEmptyRooms();
  assert.equal(gateway.guards, 0);

  gateway.observe(roomId, 0, 2, 1);
  await rooms.reapEmptyRooms();
  advance(VOICE_EMPTY_GRACE_MS);
  gateway.beforeDelete = () => gateway.states.set(roomId, { state: 'unknown' });
  await rooms.reapEmptyRooms();
  assert.equal(gateway.guards, 1);
  assert.deepEqual(gateway.deletes, []);
  assert.equal(await rooms.roomFor(HOST, session.id), roomId);

  gateway.beforeDelete = undefined;
  gateway.observe(roomId, 0, 3, 1);
  await rooms.reapEmptyRooms();
  advance(VOICE_EMPTY_GRACE_MS);
  // The reconnect completed between passes. A new epoch still invalidates the prior deadline.
  gateway.observe(roomId, 0, 4, 1);
  await rooms.reapEmptyRooms();
  assert.equal(gateway.guards, 1);
  advance(VOICE_EMPTY_GRACE_MS - 1);
  await rooms.reapEmptyRooms();
  assert.deepEqual(gateway.deletes, []);
  advance(1);
  await rooms.reapEmptyRooms();
  assert.deepEqual(gateway.deletes, [{ guildId: HOST.guildId, roomId }]);
});

test('three-seat and six-seat voice rooms use independent limits while players move and rejoin', async t => {
  const { store, rooms, gateway, session: three, advance } = fixture(t);
  const six = store.publish(HOST, store.createDraft(HOST, { ...INPUT, capacity: 6 }).id);
  const players = [GUEST, ...['one', 'two', 'three', 'four'].map(userId => ({ ...HOST, userId }))];
  for (const player of players) store.join(player, six.id);
  for (const player of players.slice(0, 2)) store.join(player, three.id);

  const roomThree = await rooms.roomFor(GUEST, three.id);
  const roomSix = await rooms.roomFor(GUEST, six.id);
  assert.notEqual(roomThree, roomSix);
  assert.equal(gateway.rooms.get(roomThree)!.request.capacity, 3);
  assert.equal(gateway.rooms.get(roomSix)!.request.capacity, 6);
  gateway.observe(roomThree, 0, 1, 1);
  gateway.observe(roomSix, 0, 1, 1);
  for (const player of [HOST, ...players]) gateway.move(player.userId, roomSix);
  for (const player of [HOST, ...players.slice(0, 2)]) gateway.move(player.userId, roomThree);
  assert.equal(gateway.rooms.get(roomThree)!.occupants.size, 3);
  assert.equal(gateway.rooms.get(roomSix)!.occupants.size, 3);
  assert.throws(() => gateway.move(players[2].userId, roomThree), /unavailable or full/);
  for (const player of [HOST, ...players.slice(0, 2)]) gateway.move(player.userId, roomSix);
  assert.equal(gateway.rooms.get(roomThree)!.occupants.size, 0);
  assert.equal(gateway.rooms.get(roomSix)!.occupants.size, 6);
  await rooms.reapEmptyRooms();
  advance(VOICE_EMPTY_GRACE_MS - 1);
  gateway.move(GUEST.userId, roomThree);
  advance(1);
  await rooms.reapEmptyRooms();
  assert.deepEqual(gateway.deletes, []);

  gateway.move(GUEST.userId);
  store.leave(GUEST, three.id);
  await assert.rejects(() => rooms.roomFor(GUEST, three.id), /confirmed players/);
  store.join(GUEST, three.id);
  assert.equal(await rooms.roomFor(GUEST, three.id), roomThree);
  gateway.move(GUEST.userId, roomThree);
  advance(VOICE_EMPTY_GRACE_MS);
  await rooms.reapEmptyRooms();
  assert.deepEqual(gateway.deletes, []);
});

test('the local registry recovers provision and room links after restart without early or foreign cleanup', async t => {
  const { store, gateway, session, now, advance } = fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'squadwaddle-voice-'));
  const path = join(dir, 'voice.sqlite');
  const categories = new Map([[HOST.guildId, 'voice-category-a']]);
  let registry = new VoiceRoomRegistry(path);
  t.after(() => { registry.close(); rmSync(dir, { recursive: true, force: true }); });
  let rooms = new VoiceRooms(store, gateway, registry, categories, now);
  const reboot = () => {
    registry.close();
    registry = new VoiceRoomRegistry(path);
    rooms = new VoiceRooms(store, gateway, registry, categories, now);
  };

  gateway.loseAcknowledgement = true;
  await assert.rejects(() => rooms.roomFor(HOST, session.id), /Lost the mock creation acknowledgement/);
  assert.deepEqual(registry.createdRooms(), []);
  reboot();
  const roomId = await rooms.roomFor(HOST, session.id);
  assert.equal(roomId, 'created-room-1');
  assert.equal(gateway.creates.length, 1);
  assert.equal(registry.createdRooms()[0].roomId, roomId);

  gateway.observe(roomId, 0, 1, 1);
  await rooms.reapEmptyRooms();
  advance(VOICE_EMPTY_GRACE_MS - 1);
  reboot();
  gateway.states.set(roomId, { state: 'unknown' });
  gateway.observe('untracked-room', 0, 2, 1);
  advance(VOICE_EMPTY_GRACE_MS);
  await rooms.reapEmptyRooms();
  assert.equal(await rooms.roomFor(HOST, session.id), roomId);
  assert.equal(gateway.creates.length, 1);
  assert.deepEqual(gateway.deletes, []);
  gateway.observe(roomId, 0, 2, 1);
  await rooms.reapEmptyRooms();
  advance(VOICE_EMPTY_GRACE_MS - 1);
  await rooms.reapEmptyRooms();
  assert.deepEqual(gateway.deletes, []);
  advance(1);
  await rooms.reapEmptyRooms();
  assert.deepEqual(gateway.deletes, [{ guildId: HOST.guildId, roomId }]);
  assert.deepEqual(registry.createdRooms(), []);
  assert.ok(gateway.states.has('untracked-room'));

  const removed = await rooms.roomFor(HOST, session.id);
  gateway.rooms.delete(removed);
  gateway.states.set(removed, { state: 'missing' });
  reboot();
  // A fresh missing-room observation repairs only the saved link.
  assert.equal(await rooms.roomFor(HOST, session.id), 'created-room-3');
  assert.deepEqual(gateway.deletes, [{ guildId: HOST.guildId, roomId }]);
});
