import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DiscordVoiceGateway, type DiscordVoiceRest } from '../src/discord-voice-gateway.ts';
import { VoiceRoomRegistry } from '../src/voice-room-registry.ts';

const GUILD = '910000000000000001';
const CATEGORY = '910000000000000002';
const ROOM = '910000000000000003';
const OTHER_ROOM = '910000000000000004';
const HOST = '910000000000000005';
const GUEST = '910000000000000006';
const OTHER_CATEGORY = '910000000000000007';
const parent = { id: CATEGORY, guild_id: GUILD, type: 4 };
const channel = { id: ROOM, guild_id: GUILD, type: 2, parent_id: CATEGORY };
const sibling = { ...channel, id: OTHER_ROOM };
const scope = { guildId: GUILD, categoryId: CATEGORY, capacity: 4 };
const address = { guildId: GUILD, roomId: ROOM };
const categories = new Map([[GUILD, CATEGORY]]);

function fixture(t: TestContext) {
  const registry = new VoiceRoomRegistry();
  t.after(() => registry.close());
  const link = registry.reserve({ sessionId: 'fictional-session', ...scope });
  const request = { ...scope, provisionId: link.provisionId, allowedUserIds: [HOST, GUEST] };
  const calls: Parameters<DiscordVoiceRest>[] = [];
  let roomLookup = async () => channel;
  const rest: DiscordVoiceRest = async (...args) => {
    calls.push(args);
    const [method, path] = args;
    if (method === 'GET' && path === '/channels/' + CATEGORY) return parent;
    if (method === 'GET' && path === '/channels/' + ROOM) return roomLookup();
    if (method === 'DELETE' && path === '/channels/' + ROOM) return channel;
    if (method === 'POST' && path === '/guilds/' + GUILD + '/channels') return channel;
    throw new Error('Unexpected fictional REST call.');
  };
  const gateway = new DiscordVoiceGateway(rest, registry, categories);
  async function create() {
    registry.confirm(link, await gateway.createPrivateRoom(request));
  }
  return { registry, link, request, calls, rest, gateway, create,
    lookup: (replacement: typeof roomLookup) => { roomLookup = replacement; } };
}

function stream(gateway: DiscordVoiceGateway) {
  const socket = gateway.connect();
  let sequence = 0;
  const event = (t: string, d: unknown, skip = 0) => {
    sequence += 1 + skip;
    gateway.dispatch(socket, { t, d, s: sequence });
  };
  const snapshot = (voice_states: unknown[] = [], channels: unknown[] = [parent, channel, sibling]) =>
    event('GUILD_CREATE', { id: GUILD, channels, voice_states });
  const move = (user: string, destination: string | null) =>
    event('VOICE_STATE_UPDATE', { guild_id: GUILD, user_id: user, channel_id: destination });
  return { event, snapshot, move, disconnect: () => gateway.disconnect(socket) };
}

function known(gateway: DiscordVoiceGateway) {
  const presence = gateway.presence(address);
  assert.equal(presence.state, 'known');
  return presence;
}

test('Discord voice is disabled by default and creates only in its verified category for the recorded capacity and roster', async t => {
  const f = fixture(t);
  const disabled = new DiscordVoiceGateway(f.rest, f.registry);
  await assert.rejects(disabled.createPrivateRoom(f.request), /scope or roster/);
  await assert.rejects(f.gateway.createPrivateRoom({ ...f.request, categoryId: OTHER_CATEGORY }), /scope or roster/);
  assert.deepEqual(f.calls, []);
  const wrongParent = new DiscordVoiceGateway(async () => ({ ...parent, type: 0 }), f.registry, categories);
  await assert.rejects(wrongParent.createPrivateRoom(f.request), /category could not be verified/);

  const oldSnapshot = stream(f.gateway);
  oldSnapshot.snapshot([], [parent, sibling]);
  await f.create();
  assert.deepEqual(f.calls, [
    ['GET', '/channels/' + CATEGORY],
    ['POST', '/guilds/' + GUILD + '/channels', {
      name: 'squadwaddle-session', type: 2, parent_id: CATEGORY, user_limit: 4,
      permission_overwrites: [
        { id: GUILD, type: 0, deny: '1049600', allow: '0' },
        { id: HOST, type: 1, allow: '1049600', deny: '0' },
        { id: GUEST, type: 1, allow: '1049600', deny: '0' },
      ],
    }],
  ]);
  assert.equal(await f.gateway.createPrivateRoom(f.request), ROOM);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.gateway.presence(address), { state: 'unknown' });
  oldSnapshot.event('CHANNEL_CREATE', channel);
  assert.equal(known(f.gateway).occupants, 0);
});

test('a lost Discord acknowledgement survives restart and never repeats the POST or adopts a lookalike', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-voice-test-'));
  let registry = new VoiceRoomRegistry(join(dir, 'rooms.sqlite'));
  const calls: string[] = [];
  try {
    const link = registry.reserve({ sessionId: 'fictional-session', ...scope });
    const request = { ...scope, provisionId: link.provisionId, allowedUserIds: [HOST] };
    const rest: DiscordVoiceRest = async method => {
      calls.push(method);
      if (method === 'GET') return parent;
      throw new Error('Lost fictional response after POST.');
    };
    await assert.rejects(new DiscordVoiceGateway(rest, registry, categories).createPrivateRoom(request), /Lost fictional/);
    registry.close();
    registry = new VoiceRoomRegistry(join(dir, 'rooms.sqlite'));
    const gateway = new DiscordVoiceGateway(rest, registry, categories);
    stream(gateway).snapshot();
    await assert.rejects(gateway.createPrivateRoom(request), /ownership check/);
    assert.deepEqual(calls, ['GET', 'POST']);
    assert.deepEqual(registry.createdRooms(), []);
    assert.deepEqual(gateway.presence(address), { state: 'unknown' });
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('voice moves change revision and disconnect, stale sockets, resume, and sequence gaps cannot prove emptiness', async t => {
  const f = fixture(t);
  await f.create();
  const first = stream(f.gateway);
  first.snapshot([{ user_id: GUEST, channel_id: ROOM }]);
  const occupied = known(f.gateway);
  assert.equal(occupied.occupants, 1);
  first.move(GUEST, OTHER_ROOM);
  const empty = known(f.gateway);
  assert.equal(empty.occupants, 0);
  assert.ok(empty.revision > occupied.revision);
  first.move(HOST, ROOM);
  first.move(HOST, null);
  assert.ok(known(f.gateway).revision > empty.revision);
  first.disconnect();
  assert.deepEqual(f.gateway.presence(address), { state: 'unknown' });

  const second = stream(f.gateway);
  second.event('RESUMED', {});
  first.snapshot();
  second.move(HOST, null);
  assert.deepEqual(f.gateway.presence(address), { state: 'unknown' });
  second.snapshot();
  assert.ok(known(f.gateway).epoch > occupied.epoch);
  second.event('MESSAGE_CREATE', {}, 1);
  assert.deepEqual(f.gateway.presence(address), { state: 'unknown' });
  second.snapshot();
  second.event('CHANNEL_DELETE', channel);
  assert.deepEqual(f.gateway.presence(address), { state: 'missing' });
});

test('Discord cleanup only deletes an acknowledged room still in the configured category with unchanged empty presence', async t => {
  const f = fixture(t);
  f.registry.confirm(f.registry.reserve({ sessionId: 'mock-only-session', ...scope }), OTHER_ROOM);
  await f.create();
  const gw = stream(f.gateway);
  gw.snapshot();
  const empty = known(f.gateway);
  assert.equal(await f.gateway.deleteIfEmpty({ ...address, roomId: OTHER_ROOM }, empty), false);
  f.lookup(async () => ({ ...channel, parent_id: OTHER_CATEGORY }));
  assert.equal(await f.gateway.deleteIfEmpty(address, empty), false);
  f.lookup(async () => {
    gw.move(GUEST, ROOM);
    gw.move(GUEST, null);
    return channel;
  });
  assert.equal(await f.gateway.deleteIfEmpty(address, empty), false);
  f.lookup(async () => { gw.disconnect(); return channel; });
  assert.equal(await f.gateway.deleteIfEmpty(address, known(f.gateway)), false);
  assert.equal(f.calls.filter(([method]) => method === 'DELETE').length, 0);
  const fresh = stream(f.gateway);
  fresh.snapshot();
  assert.equal(await f.gateway.deleteIfEmpty(address, known(f.gateway)), true);
  assert.deepEqual(f.calls.slice(-2), [['GET', '/channels/' + ROOM], ['DELETE', '/channels/' + ROOM]]);
});
