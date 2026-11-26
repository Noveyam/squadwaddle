import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { duplexPair } from 'node:stream';
import { text } from 'node:stream/consumers';
import type { AddressInfo } from 'node:net';
import type { Actor, GroupMember, PublicSession, SessionInput, SessionStoreContract } from '../src/types.ts';
import { handleInteraction, publicCard, safeText, EPHEMERAL, SESSION_COMMAND } from '../src/discord.ts';
import { createInteractionServer, loadServerConfig } from '../src/server.ts';
import { registerCommands } from '../scripts/register-commands.ts';
import { SessionStore } from '../src/store.ts';

const APP = '100000000000000001';
const GUILD = '100000000000000002';
const CHANNEL = '100000000000000003';
const HOST = '100000000000000004';
const GUEST = '100000000000000005';
const PILOT = { applicationId: APP, guildId: GUILD, channelId: CHANNEL };
const SESSION = 'session-abc';
const INPUT: SessionInput = { activity: 'Expedition', startAt: '2026-12-05T12:00:00-08:00',
  endAt: '2026-12-05T14:00:00-08:00', timeZone: 'America/Los_Angeles', expectations: 'Learning welcome', platformNotes: 'Check cross-play' };
function sample(): PublicSession {
  return { ...INPUT, id: SESSION, game: 'Marathon', guildId: GUILD, channelId: CHANNEL, hostUserId: HOST,
    status: 'open', capacity: 3, members: [{ userId: HOST, isHost: true }] };
}

class FakeStore implements SessionStoreContract {
  calls: Array<{ method: string; actor: Actor; args: unknown[] }> = [];
  session = sample();
  profiles = new Map<string, string>();
  listed: PublicSession[] | null = null;
  note(method: string, actor: Actor, ...args: unknown[]): void { this.calls.push({ method, actor, args }); }
  saveProfile(actor: Actor, name: string) { this.note('saveProfile', actor, name); this.profiles.set(actor.userId, name); }
  getProfile(actor: Actor) { this.note('getProfile', actor); return { bungieName: this.profiles.get(actor.userId) ?? null }; }
  clearProfile(actor: Actor) { this.note('clearProfile', actor); this.profiles.delete(actor.userId); }
  createDraft(actor: Actor, input: SessionInput, shareName = false) {
    this.note('createDraft', actor, input, shareName); this.session = { ...sample(), ...input, status: 'draft' }; return this.session;
  }
  publish(actor: Actor, id: string, interactionId?: string) {
    if (this.session.status === 'open') throw Object.assign(new Error(), { code: 'ALREADY_PUBLISHED' });
    this.note('publish', actor, id, interactionId);
    this.session.status = 'open';
    return this.session;
  }
  join(actor: Actor, id: string, shareName = false) { this.note('join', actor, id, shareName); return this.session; }
  leave(actor: Actor, id: string) { this.note('leave', actor, id); return this.session; }
  setSharing(actor: Actor, id: string, shareName: boolean) { this.note('setSharing', actor, id, shareName); return this.session; }
  cancel(actor: Actor, id: string) { this.note('cancel', actor, id); this.session.status = 'cancelled'; return this.session; }
  getSession(actor: Actor, id: string) { this.note('getSession', actor, id); return this.session; }
  listSessions(actor: Actor) { this.note('listSessions', actor); return this.listed ?? [this.session]; }
  getSharedNames(actor: Actor, id: string): GroupMember[] {
    this.note('getSharedNames', actor, id);
    if (actor.userId !== HOST) throw Object.assign(new Error('SecretPlayer#9999'), { code: 'NOT_A_MEMBER' });
    return [{ userId: HOST, bungieName: 'SecretPlayer#9999', connectionNote: 'Unverified Name' }];
  }
  close() {}
}
function command(sub: string, values: Record<string, unknown> = {}, user = HOST) {
  return { application_id: APP, guild_id: GUILD, channel_id: CHANNEL, context: 0, type: 2,
    member: { user: { id: user } }, data: { name: 'session', options: [{ name: sub, type: 1,
      options: Object.entries(values).map(([name, value]) => ({ name, type: typeof value === 'boolean' ? 5 : 3, value })) }] } };
}
function component(action: string, user = HOST, flags = 0) {
  return { ...command('find', {}, user), type: 3, message: { flags }, data: { component_type: 2, custom_id: `ns:${action}:${SESSION}` } };
}
function messageData(response: ReturnType<typeof handleInteraction>) {
  assert.ok('data' in response); return response.data;
}

test('creation is private, preserves explicit time input, and publishes only after a button', () => {
  const store = new FakeStore();
  const response = handleInteraction(command('create', { activity: INPUT.activity, start: INPUT.startAt, end: INPUT.endAt,
    timezone: INPUT.timeZone, expectations: INPUT.expectations, platform_notes: INPUT.platformNotes, share: true }), store, PILOT);
  assert.equal(response.type, 4);
  const data = messageData(response);
  assert.equal((data.flags! & EPHEMERAL), EPHEMERAL);
  assert.deepEqual(data.allowed_mentions, { parse: [] });
  assert.deepEqual(store.calls.map(c => c.method), ['createDraft']);
  assert.deepEqual(store.calls[0].args, [INPUT, true]);
  assert.match(data.content, /Private draft/);
  assert.deepEqual(data.components![0].components.map(c => c.label), ['Publish', 'Discard']);
  const click = { ...component('publish', HOST, EPHEMERAL), id: '100000000000000080' };
  const published = handleInteraction(click, store, PILOT);
  assert.equal(published.type, 4);
  assert.equal(messageData(published).flags! & EPHEMERAL, 0);
  assert.equal(store.calls.at(-1)!.method, 'publish');
  const repeat = handleInteraction({ ...click, id: '100000000000000081' }, store, PILOT);
  assert.equal(messageData(repeat).flags! & EPHEMERAL, EPHEMERAL);
  assert.match(messageData(repeat).content, /already published/);
  assert.equal(store.calls.filter(c => c.method === 'publish').length, 1);
});

test('after reopening SQLite a committed Publish interaction gets only a private acknowledgement', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'squadwaddle-publish-'));
  const path = join(dir, 'sessions.sqlite');
  const now = () => new Date('2026-11-25T12:00:00Z');
  const actor = { guildId: GUILD, channelId: CHANNEL, userId: HOST };
  const interactionId = '100000000000000110';
  let store = new SessionStore(path, now);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const publish = (session: string, id = interactionId) => ({
    ...component('publish', HOST, EPHEMERAL), id,
    data: { component_type: 2, custom_id: `ns:publish:${session}` },
  });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const config = { ...PILOT, publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
    host: '127.0.0.1', port: 3000, dbPath: path };
  const openServer = () => createInteractionServer(config, store, () => now().getTime());
  let server = openServer();
  async function deliver(click: ReturnType<typeof publish>) {
    const body = JSON.stringify(click);
    const timestamp = String(now().getTime() / 1000);
    const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString('hex');
    // Run Node's HTTP client and the production HTTP parser over a stream pair, without binding a port.
    const [client, peer] = duplexPair();
    try {
      server.emit('connection', peer);
      const req = request({ method: 'POST', path: '/interactions', createConnection: () => client, headers: {
        'Content-Type': 'application/json', 'X-Signature-Timestamp': timestamp, 'X-Signature-Ed25519': signature,
      } });
      const response = once(req, 'response');
      req.end(body);
      const [res] = await response;
      assert.equal(res.statusCode, 200);
      return messageData(JSON.parse(await text(res)));
    } finally {
      client.destroy();
      peer.destroy();
    }
  }
  store.saveProfile(actor, 'Fictional#4321');
  const first = store.createDraft(actor, INPUT, true);
  const second = store.createDraft(actor, INPUT);
  const click = publish(first.id);
  // Force a failure after the status update but before its receipt can be committed.
  const fault = new DatabaseSync(path);
  try {
    fault.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON publish_receipts BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    const failed = await deliver(click);
    assert.equal(failed.flags! & EPHEMERAL, EPHEMERAL);
    assert.equal(store.getSession(actor, first.id).status, 'draft');
    fault.exec('DROP TRIGGER fail_receipt');
  } finally {
    fault.close();
  }
  const card = await deliver(click);
  assert.equal(card.flags! & EPHEMERAL, 0);
  assert.ok(card.components?.length);

  // Drop the response after the commit. A new handler has no memory of the first click.
  store.close();
  store = new SessionStore(path, now);
  server = openServer();
  const retry = await deliver(click);
  assert.equal(retry.flags! & EPHEMERAL, EPHEMERAL);
  assert.match(retry.content, /already handled/);
  assert.ok(!retry.components?.length);
  assert.doesNotMatch(JSON.stringify(retry), /Fictional|Expedition/);
  assert.deepEqual(store.listSessions(actor).map(s => s.id), [first.id]);

  store.cancel(actor, first.id);
  assert.deepEqual(await deliver(click), retry);
  assert.equal(store.getSession(actor, first.id).status, 'cancelled');
  assert.deepEqual(await deliver(publish(second.id)), retry);
  assert.equal(store.getSession(actor, second.id).status, 'draft');
  const fresh = await deliver(publish(second.id, '100000000000000111'));
  assert.equal(fresh.flags! & EPHEMERAL, 0);
});

test('actor uses signed member fields only; outside scope and DM invocations never access the store', () => {
  const store = new FakeStore();
  handleInteraction(command('profile', { bungie_name: 'User#1234', userId: GUEST, guildId: 'other' }), store, PILOT);
  assert.deepEqual(store.calls[0].actor, { userId: HOST, guildId: GUILD, channelId: CHANNEL });
  const before = store.calls.length;
  for (const changed of [
    { ...command('find'), guild_id: '100000000000000099' },
    { ...command('find'), channel_id: '100000000000000099' },
    { ...command('find'), application_id: '100000000000000099' },
    { ...command('find'), member: undefined, user: { id: HOST } },
  ]) {
    assert.equal(messageData(handleInteraction(changed, store, PILOT)).flags! & EPHEMERAL, EPHEMERAL);
  }
  assert.equal(store.calls.length, before);
});

test('public projections exclude profile fields and neutralize user-controlled formatting and mentions', () => {
  const injected = { ...sample(), activity: '@everyone <@123> **bold**', bungieName: 'SecretPlayer#9999',
    members: [{ userId: HOST, isHost: true, bungieName: 'SecretPlayer#9999' }] };
  const card = publicCard(injected);
  assert.deepEqual(card.allowed_mentions, { parse: [] });
  assert.equal(JSON.stringify(card).includes('SecretPlayer'), false);
  assert.equal(card.content.includes('@everyone'), false);
  assert.equal(card.content.includes('<@123>'), false);
  assert.match(card.content, /\\\*\\\*bold/);
  assert.equal(safeText('hello\u202e\nworld'), 'hello  world');
});

test('maximum domain text and roster fit Discord content limits after Markdown escaping', () => {
  const store = new FakeStore();
  const maximum = { ...sample(), activity: '*'.repeat(160), expectations: '*'.repeat(1000), platformNotes: '*'.repeat(500),
    members: [{ userId: HOST, isHost: true }, { userId: GUEST, isHost: false }, { userId: '100000000000000006', isHost: false }] };
  const card = publicCard(maximum);
  assert.ok(card.content.length <= 2000, `public card has ${card.content.length} characters`);
  const preview = messageData(handleInteraction(command('create', { activity: maximum.activity, start: INPUT.startAt, end: INPUT.endAt,
    timezone: INPUT.timeZone, expectations: maximum.expectations, platform_notes: maximum.platformNotes, share: true }), store, PILOT));
  assert.ok(preview.content.length <= 2000, `draft has ${preview.content.length} characters`);
  assert.match(card.content, /Join only: I’ll arrange my in-game connection with the host/);
  assert.equal(card.components![0].components[0].label, 'Join & share Bungie Name');
});

test('group IDs are always ephemeral and membership errors never reveal private error text', () => {
  const store = new FakeStore();
  const joined = messageData(handleInteraction(component('ids'), store, PILOT));
  assert.equal(joined.flags! & EPHEMERAL, EPHEMERAL);
  assert.match(joined.content, /SecretPlayer/);
  const denied = messageData(handleInteraction(component('ids', GUEST), store, PILOT));
  assert.equal(denied.flags! & EPHEMERAL, EPHEMERAL);
  assert.equal(denied.content.includes('SecretPlayer'), false);
  assert.match(denied.content, /Join this session/);
});

test('join buttons pass distinct consent; public cards update without exposing IDs', () => {
  const store = new FakeStore();
  for (const [action, consent] of [['join', false], ['join-share', true]] as const) {
    const response = handleInteraction(component(action, GUEST), store, PILOT);
    assert.equal(response.type, 7);
    assert.deepEqual(store.calls.at(-1)!.args, [SESSION, consent]);
    assert.equal(messageData(response).flags! & EPHEMERAL, 0);
    assert.equal(JSON.stringify(response).includes('SecretPlayer'), false);
  }
  const fromSearch = handleInteraction(component('join', GUEST, EPHEMERAL), store, PILOT);
  assert.equal(fromSearch.type, 4);
  assert.equal(messageData(fromSearch).flags! & EPHEMERAL, EPHEMERAL);
});

test('discovery lists real same-channel open sessions, never fabricated or cross-scope groups', () => {
  const store = new FakeStore();
  store.listed = [{ ...sample(), activity: 'Visible group' }, { ...sample(), status: 'draft', activity: 'Hidden draft' },
    { ...sample(), channelId: 'another', activity: 'Other channel' }];
  const response = messageData(handleInteraction(command('find'), store, PILOT));
  assert.match(response.content, /Visible group/);
  assert.equal(response.content.includes('Hidden draft'), false);
  assert.equal(response.content.includes('Other channel'), false);
  assert.equal(response.components![0].components.length, 1);
  store.listed = [];
  assert.match(messageData(handleInteraction(command('find'), store, PILOT)).content, /No open sessions/);
});

test('profile clear and session share are explicit private mutations', () => {
  const store = new FakeStore();
  handleInteraction(command('share', { session: SESSION }), store, PILOT);
  assert.equal(store.calls.length, 0);
  const revoked = messageData(handleInteraction(command('share', { session: SESSION, enabled: false }), store, PILOT));
  assert.deepEqual(store.calls.at(-1)!.args, [SESSION, false]);
  assert.equal(revoked.flags! & EPHEMERAL, EPHEMERAL);
  handleInteraction(command('profile', { clear: true, bungie_name: 'Both#1234' }), store, PILOT);
  assert.equal(store.calls.length, 1);
  handleInteraction(command('profile', { clear: true }), store, PILOT);
  assert.equal(store.calls.at(-1)!.method, 'clearProfile');
});

test('configuration fails closed and defaults to loopback', () => {
  assert.throws(() => loadServerConfig({}), /missing or invalid/);
  const env = { DISCORD_APPLICATION_ID: APP, PILOT_GUILD_ID: GUILD, PILOT_CHANNEL_ID: CHANNEL, DISCORD_PUBLIC_KEY: 'ab'.repeat(32) };
  assert.equal(loadServerConfig(env).host, '127.0.0.1');
  assert.throws(() => loadServerConfig({ ...env, DISCORD_PUBLIC_KEY: '' }), /PUBLIC_KEY/);
  assert.throws(() => loadServerConfig({ ...env, PORT: '0' }), /PORT/);
  assert.throws(() => createInteractionServer({ ...loadServerConfig(env), publicKey: '' }, new FakeStore()), /public key/);
});

test('signed HTTP boundary validates raw bytes, freshness, scope, size, replay, and health without credentials', async t => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const hex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  let now = Date.now();
  const config = { ...PILOT, publicKey: hex, host: '127.0.0.1', port: 3000, dbPath: ':memory:' };
  const store = new FakeStore();
  const server = createInteractionServer(config, store, () => now);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (raw: string, extra: Record<string, string> = {}, timestamp = String(Math.floor(now / 1000))) => {
    const signature = sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(raw)]), privateKey).toString('hex');
    return fetch(`${origin}/interactions`, { method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-Signature-Timestamp': timestamp, 'X-Signature-Ed25519': signature, ...extra }, body: raw });
  };
  assert.deepEqual(await (await fetch(`${origin}/health`)).json(), { ok: true });
  assert.equal((await fetch(`${origin}/interactions`)).status, 405);
  const ping = JSON.stringify({ type: 1, application_id: APP });
  assert.deepEqual(await (await post(ping)).json(), { type: 1 });
  assert.equal((await post(ping, { 'X-Signature-Ed25519': '00'.repeat(64) })).status, 401);
  assert.equal((await post('{', { 'X-Signature-Ed25519': '00'.repeat(64) })).status, 401, 'authenticate before parsing');
  assert.equal((await post('{')).status, 400);
  assert.equal((await post(ping, {}, String(Math.floor(now / 1000) - 301))).status, 401);
  assert.equal((await post(ping, {}, String(Math.floor(now / 1000) + 301))).status, 401);
  assert.equal((await post(ping, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(' '.repeat(65537))).status, 413);
  assert.equal((await post(JSON.stringify({ type: 1, application_id: 'wrong' }))).status, 401);
  const raw = JSON.stringify({ ...command('profile', { bungie_name: 'Test#1234' }), id: '100000000000000090' });
  assert.equal((await post(raw)).status, 200);
  assert.equal((await post(raw)).status, 200);
  assert.equal(store.calls.filter(c => c.method === 'saveProfile').length, 1, 'duplicate request does not repeat mutation');
  const outOfScope = JSON.stringify({ ...command('find'), id: '100000000000000091', channel_id: '100000000000000099' });
  const denied = await (await post(outOfScope)).json() as { data: { flags: number } };
  assert.equal(denied.data.flags & EPHEMERAL, EPHEMERAL);
  assert.equal(store.calls.filter(c => c.method === 'listSessions').length, 0);
  const futureRaw = JSON.stringify({ ...command('profile', { bungie_name: 'Future#1234' }), id: '100000000000000092' });
  const futureTimestamp = String(Math.floor(now / 1000) + 299);
  assert.equal((await post(futureRaw, {}, futureTimestamp)).status, 200);
  now += 301_000;
  assert.equal((await post(futureRaw, {}, futureTimestamp)).status, 200);
  assert.equal(store.calls.filter(c => c.method === 'saveProfile').length, 2, 'future-dated signatures stay protected until their freshness window ends');
});

test('registration has an explicit guard and upserts only the pilot guild command', async () => {
  let seen: { url: string; init?: RequestInit } | undefined;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(input), init }; return new Response('{}', { status: 201 });
  }) as typeof fetch;
  await assert.rejects(registerCommands({}, fakeFetch), /REGISTER_COMMANDS=yes/);
  assert.equal(seen, undefined);
  await registerCommands({ REGISTER_COMMANDS: 'yes', DISCORD_APPLICATION_ID: APP, PILOT_GUILD_ID: GUILD,
    DISCORD_BOT_TOKEN: 'fake-test-token' }, fakeFetch);
  assert.equal(seen!.url, `https://discord.com/api/v10/applications/${APP}/guilds/${GUILD}/commands`);
  assert.equal(seen!.init!.method, 'POST');
  assert.deepEqual(JSON.parse(seen!.init!.body as string), SESSION_COMMAND);
  assert.equal(SESSION_COMMAND.name, 'session');
  assert.equal('contexts' in SESSION_COMMAND, false);
});

test('real SQLite store through signed HTTP enforces preview, consent, membership and revocation end to end', async t => {
  const now = Date.parse('2026-11-25T12:00:00Z');
  const store = new SessionStore(':memory:', () => new Date(now));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const hex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const server = createInteractionServer({ ...PILOT, publicKey: hex, host: '127.0.0.1', port: 3000, dbPath: ':memory:' }, store, () => now);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close();
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/interactions`;
  let nextId = 100000000000000100n;
  const send = async (input: unknown) => {
    const raw = JSON.stringify({ ...(input as Record<string, unknown>), id: String(nextId++) });
    const timestamp = String(now / 1000);
    const signature = sign(null, Buffer.from(timestamp + raw), privateKey).toString('hex');
    const response = await fetch(origin, { method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-Signature-Timestamp': timestamp, 'X-Signature-Ed25519': signature }, body: raw });
    assert.equal(response.status, 200);
    return await response.json() as ReturnType<typeof handleInteraction>;
  };
  await send(command('profile', { bungie_name: 'HostSecret#1111' }));
  await send(command('profile', { bungie_name: 'GuestSecret#2222' }, GUEST));
  const preview = messageData(await send(command('create', { activity: INPUT.activity, start: INPUT.startAt, end: INPUT.endAt,
    timezone: INPUT.timeZone, share: true })));
  assert.equal(preview.flags! & EPHEMERAL, EPHEMERAL);
  assert.match(messageData(await send(command('find'))).content, /No open sessions/);
  const custom = preview.components![0].components[0].custom_id;
  const id = custom.split(':')[2];
  const click = (action: string, user = HOST, flags = 0) => ({ ...component(action, user, flags),
    data: { component_type: 2, custom_id: `ns:${action}:${id}` } });
  const published = await send(click('publish', HOST, EPHEMERAL));
  assert.equal(messageData(published).flags! & EPHEMERAL, 0);
  assert.equal(JSON.stringify(published).includes('HostSecret'), false);
  const guestJoin = await send(click('join-share', GUEST));
  assert.equal(guestJoin.type, 7);
  assert.equal(JSON.stringify(guestJoin).includes('GuestSecret'), false);
  const third = '100000000000000006';
  await send(click('join', third));
  const members = messageData(await send(click('ids', third)));
  assert.equal(members.flags! & EPHEMERAL, EPHEMERAL);
  assert.match(members.content, /HostSecret/);
  assert.match(members.content, /GuestSecret/);
  assert.match(members.content, /ID not shared/);
  assert.equal(members.content.includes('ID not shared. Ask this player how they want to connect. — ID not shared'), false);
  const outsider = messageData(await send(click('ids', '100000000000000007')));
  assert.equal(outsider.flags! & EPHEMERAL, EPHEMERAL);
  assert.equal(outsider.content.includes('Secret'), false);
  assert.match(outsider.content, /Join this session/);
  await send(command('share', { session: id, enabled: false }));
  const afterRevoke = messageData(await send(click('ids', third)));
  assert.equal(afterRevoke.content.includes('HostSecret'), false);
  assert.match(afterRevoke.content, /GuestSecret/);
  await send(click('leave', GUEST));
  const afterLeave = messageData(await send(click('ids', GUEST)));
  assert.match(afterLeave.content, /Join this session/);
  assert.equal(afterLeave.content.includes('Secret'), false);
  assert.equal(messageData(await send(click('ids'))).content.includes('GuestSecret'), false);
});
