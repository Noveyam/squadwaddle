import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { duplexPair } from 'node:stream';
import { text } from 'node:stream/consumers';
import type { AddressInfo } from 'node:net';
import type { Actor, DraftListPage, DraftPreview, GroupMember, PublicSession, SessionInput, SessionStoreContract } from '../src/types.ts';
import { handleInteraction, publicCard, safeText, EPHEMERAL, SESSION_COMMAND, type MessageData } from '../src/discord.ts';
import { createInteractionServer, loadServerConfig } from '../src/server.ts';
import { registerCommands } from '../scripts/register-commands.ts';
import { SessionStore } from '../src/store.ts';

const APP = '100000000000000001';
const GUILD = '100000000000000002';
const CHANNEL = '100000000000000003';
const HOST = '100000000000000004';
const GUEST = '100000000000000005';
const OTHER_GUILD = '100000000000000010';
const OTHER_CHANNEL = '100000000000000011';
const PILOT = { applicationId: APP, allowedPairs: [{ guildId: GUILD, channelId: CHANNEL }] };
const SESSION = 'session-abc';
const TEXT_REQUEST = 'Two more for Marathon on Saturday from noon to 1:30 pm Pacific.';
const DATED_REQUEST = 'Two more for Marathon on 2026-12-11 from 6:30 pm to 8:00 pm Pacific.';
const EXPEDITION_REQUEST = DATED_REQUEST.replace('Pacific.', 'Pacific for Expedition practice.');
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
  createWeekendDraft(): DraftPreview { throw new Error('Use the real store for weekend draft tests.'); }
  listDrafts(): DraftListPage { throw new Error('Use the real store for draft recovery tests.'); }
  getDraft(): DraftPreview { throw new Error('Use the real store for draft editing tests.'); }
  editDraft(): DraftPreview { throw new Error('Use the real store for draft editing tests.'); }
  publish(actor: Actor, id: string, interactionId?: string) {
    if (this.session.status === 'open') throw Object.assign(new Error(), { code: 'ALREADY_PUBLISHED' });
    this.note('publish', actor, id, interactionId);
    this.session.status = 'open';
    return this.session;
  }
  join(actor: Actor, id: string, shareName = false) { this.note('join', actor, id, shareName); return this.session; }
  confirmPublicCard(actor: Actor, id: string, origin: string, messageId: string) { this.note('confirmPublicCard', actor, id, origin, messageId); }
  leave(actor: Actor, id: string) { this.note('leave', actor, id); return this.session; }
  setSharing(actor: Actor, id: string, shareName: boolean) { this.note('setSharing', actor, id, shareName); return this.session; }
  cancel(actor: Actor, id: string) { this.note('cancel', actor, id); this.session.status = 'cancelled'; return this.session; }
  discardDraft(actor: Actor, id: string) { this.cancel(actor, id); }
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
      options: Object.entries(values).map(([name, value]) => ({
        name, type: typeof value === 'number' ? 4 : typeof value === 'boolean' ? 5 : 3, value,
      })) }] } };
}
function component(action: string, user = HOST, flags = 0) {
  return buttonPress(`ns:${action}:${SESSION}`, user, flags);
}
function buttonPress(customId: string, user: string, flags = 0) {
  return { ...command('find', {}, user), type: 3, message: { flags }, data: { component_type: 2, custom_id: customId } };
}
function submitForm(customId: string, fields: Record<string, string>, user = HOST) {
  return { ...command('find', {}, user), type: 5, data: { custom_id: customId,
    components: Object.entries(fields).map(([id, value]) => ({
      type: 1, components: [{ type: 4, custom_id: id, value }],
    })) } };
}
function buttonNamed(message: MessageData, label: string) {
  const button = message.components?.flatMap(row => row.components).find(item => item.label === label);
  assert.ok(button, `Expected a "${label}" button`);
  return button;
}
function messageData(response: ReturnType<typeof handleInteraction>) {
  assert.ok(response.type === 4 || response.type === 7);
  return response.data;
}

type TestRequest = { method?: string; headers?: Record<string, string>; body?: string };

async function requestOverStream(server: Server, path: string, init: TestRequest = {}): Promise<Response> {
  const [client, peer] = duplexPair();
  try {
    server.emit('connection', peer);
    const req = request({ path, method: init.method, headers: init.headers, createConnection: () => client });
    const response = once(req, 'response');
    req.end(init.body);
    const [res] = await response;
    return new Response(await text(res), { status: res.statusCode });
  } finally {
    client.destroy();
    peer.destroy();
  }
}

async function signedResponse(server: Server, key: KeyObject, now: number, payload: object): Promise<ReturnType<typeof handleInteraction>> {
  const body = JSON.stringify(payload);
  const timestamp = String(now / 1000);
  const signature = sign(null, Buffer.from(timestamp + body), key).toString('hex');
  const response = await requestOverStream(server, '/interactions', { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Signature-Timestamp': timestamp, 'X-Signature-Ed25519': signature,
  }, body });
  assert.equal(response.status, 200);
  return await response.json() as ReturnType<typeof handleInteraction>;
}
async function signedMessage(server: Server, key: KeyObject, now: number, payload: object): Promise<MessageData> {
  return messageData(await signedResponse(server, key, now, payload));
}

async function testHttp(t: TestContext, server: Server) {
  try {
    const ready = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await ready;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    t.diagnostic('Loopback binding denied. Exercising the HTTP client and server over local streams.');
    return (path: string, init?: TestRequest) => requestOverStream(server, path, init);
  }
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (path: string, init?: TestRequest) => fetch(origin + path, init);
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
  assert.deepEqual(data.components![0].components.map(c => c.label), ['Publish', 'Discard', 'Edit', 'My drafts']);
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

test('text drafts resolve weekdays and calendar dates in the chosen zone before saving', () => {
  const cases = [
    { reference: '2026-07-05T00:30:00Z', request: 'Two more for Marathon on SATURDAY from 6:00pm to 7:15 PM America/Los_Angeles',
      start: '2026-07-05T01:00:00.000Z', end: '2026-07-05T02:15:00.000Z', zone: 'America/Los_Angeles' },
    { reference: '2026-03-07T18:00:00Z', request: 'Two more for Marathon on Sunday from 1:30 am to 3:30 am Pacific',
      start: '2026-03-08T09:30:00.000Z', end: '2026-03-08T10:30:00.000Z', zone: 'America/Los_Angeles' },
    { reference: '2026-12-31T23:00:00Z', request: 'Two more for Marathon on Friday from 12:00 am to 1:00 am UTC',
      start: '2027-01-01T00:00:00.000Z', end: '2027-01-01T01:00:00.000Z', zone: 'UTC' },
    { reference: '2026-12-12T01:00:00Z', request: DATED_REQUEST,
      start: '2026-12-12T02:30:00.000Z', end: '2026-12-12T04:00:00.000Z', zone: 'America/Los_Angeles' },
    { reference: '2028-02-01T12:00:00Z', request: 'Two more for Marathon on 2028-02-29 from noon to 1:30 pm UTC.',
      start: '2028-02-29T12:00:00.000Z', end: '2028-02-29T13:30:00.000Z', zone: 'UTC' },
    { reference: '2026-11-25T12:00:00Z', request: TEXT_REQUEST.replace('Pacific.', 'UTC FOR Learn the PvE Route!'),
      start: '2026-11-28T12:00:00.000Z', end: '2026-11-28T13:30:00.000Z', zone: 'UTC', activity: 'Learn the PvE Route!' },
  ];
  for (const { reference, request, start, end, zone, activity = 'Group play' } of cases) {
    const store = new FakeStore();
    const preview = messageData(handleInteraction(command('create-text', { request, share: true }), store, PILOT, Date.parse(reference)));
    assert.equal(preview.flags! & EPHEMERAL, EPHEMERAL);
    assert.match(preview.content, /Your Bungie Name: share with joined members/);
    assert.equal(store.calls.length, 1);
    assert.equal(store.calls[0].method, 'createDraft');
    assert.equal(store.calls[0].args[1], true);
    assert.equal(store.session.startAt, start);
    assert.equal(store.session.endAt, end);
    assert.equal(store.session.timeZone, zone);
    assert.equal(store.session.activity, activity);
  }
});

test('text draft errors are private and leave the store untouched', () => {
  const now = '2026-11-25T12:00:00Z';
  const cases = [
    { request: TEXT_REQUEST.replace('Pacific', 'PST'), error: /Use a full weekday/ },
    { request: TEXT_REQUEST.replace('Saturday', 'next Saturday'), error: /Use a full weekday/ },
    { request: TEXT_REQUEST.replace('Two more', 'Three or four more'), error: /How many seats total/ },
    { request: TEXT_REQUEST.replace('1:30', '1:60'), error: /Use a full weekday/ },
    { request: TEXT_REQUEST + ' Share my Bungie Name.', error: /Use a full weekday/ },
    { request: TEXT_REQUEST.replace('Pacific.', 'Pacific for.'), error: /The final “for …” activity is optional/ },
    { request: TEXT_REQUEST.replace('Pacific.', 'Pacific for FictionalHost#1111.'), error: /without Bungie Names/ },
    { request: TEXT_REQUEST.replace('Pacific.', `Pacific for ${'a'.repeat(160)}.`), error: /within 160 characters/ },
    { request: TEXT_REQUEST.replace('1:30 pm', 'noon'), error: /end after the start on the same day/ },
    { request: TEXT_REQUEST.replace('noon to 1:30 pm', '11:30 pm to 1:30 am'), error: /end after the start on the same day/ },
    { request: TEXT_REQUEST, reference: '2026-11-28T20:00:00Z', error: /start time has passed/ },
    { request: 'Two more for Marathon on Sunday from 2:15 am to 3:30 am Pacific',
      reference: '2026-03-07T18:00:00Z', error: /start time does not exist/ },
    { request: 'Two more for Marathon on Sunday from 12:30 am to 1:15 am Pacific',
      reference: '2026-10-31T18:00:00Z', error: /end time occurs twice/ },
  ];
  const store = new FakeStore();
  for (const { request, reference, error } of cases) {
    const reply = messageData(handleInteraction(command('create-text', { request }), store, PILOT, Date.parse(reference ?? now)));
    assert.equal(reply.flags! & EPHEMERAL, EPHEMERAL, request);
    assert.match(reply.content, error, request);
    assert.deepEqual(reply.components, [], request);
  }
  assert.deepEqual(store.calls, []);
});

test('incomplete scheduling sentences get a private correction and save only after a valid retry', () => {
  const referenceMs = Date.parse('2026-11-25T12:00:00Z');
  const store = new FakeStore();
  const cases = [
    { request: TEXT_REQUEST.replace('from noon', 'from 12:00'), hint: /Add AM or PM to the start time/ },
    { request: TEXT_REQUEST.replace('1:30 pm', '1:30'), hint: /Add AM or PM to the end time/ },
    { request: TEXT_REQUEST.replace(' to 1:30 pm', ''), hint: /Include an end time/ },
    { request: TEXT_REQUEST.replace('1:30 pm ', ''), hint: /Include an end time/ },
    { request: TEXT_REQUEST.replace(' to 1:30 pm Pacific', ''), hint: /Include an end time/ },
    { request: TEXT_REQUEST.replace(' Pacific', ''), hint: /Add a time zone after the end time/ },
    { request: DATED_REQUEST.replace('Pacific.', 'for Expedition practice.'), hint: /Add a time zone after the end time/ },
  ];
  for (const { request, hint } of cases) {
    const reply = messageData(handleInteraction(command('create-text', { request }), store, PILOT, referenceMs));
    assert.equal(reply.flags! & EPHEMERAL, EPHEMERAL, request);
    assert.match(reply.content, hint, request);
    assert.deepEqual(reply.components, [], request);
  }
  assert.deepEqual(store.calls, []);

  const corrected = messageData(handleInteraction(command('create-text', { request: TEXT_REQUEST }), store, PILOT, referenceMs));
  assert.equal(corrected.flags! & EPHEMERAL, EPHEMERAL);
  assert.match(corrected.content, /Private draft/);
  assert.deepEqual(store.calls.map(call => call.method), ['createDraft']);
});

test('calendar-date errors stay private and never save a draft', () => {
  const cases = [
    { request: DATED_REQUEST.replace('2026-12-11', '2026-12-1'), error: /YYYY-MM-DD/ },
    { request: DATED_REQUEST.replace('2026-12-11', '12/11/2026'), error: /YYYY-MM-DD/ },
    { request: DATED_REQUEST.replace('2026-12-11', '2026-02-29'), error: /valid calendar date/ },
    { request: DATED_REQUEST.replace('2026-12-11', '2027-04-31'), error: /valid calendar date/ },
    { request: DATED_REQUEST.replace('2026-12-11', '2026-13-11'), error: /valid calendar date/ },
    { request: DATED_REQUEST, reference: '2026-12-12T12:00:00Z', error: /date has passed in the selected time zone/ },
    { request: DATED_REQUEST, reference: '2026-12-12T02:30:00Z', error: /start time has passed/ },
    { request: DATED_REQUEST, reference: '2026-12-12T03:00:00Z', error: /start time has passed/ },
    { request: 'Two more for Marathon on 2026-03-08 from 2:15 am to 3:30 am Pacific',
      reference: '2026-03-01T18:00:00Z', error: /start time does not exist/ },
    { request: 'Two more for Marathon on 2026-11-01 from 12:30 am to 1:15 am Pacific',
      reference: '2026-10-01T18:00:00Z', error: /end time occurs twice/ },
  ];
  const store = new FakeStore();
  for (const { request, reference, error } of cases) {
    const reply = messageData(handleInteraction(command('create-text', { request }), store, PILOT,
      Date.parse(reference ?? '2026-01-01T12:00:00Z')));
    assert.equal(reply.flags! & EPHEMERAL, EPHEMERAL, request);
    assert.match(reply.content, error, request);
    assert.deepEqual(reply.components, [], request);
  }
  assert.deepEqual(store.calls, []);
});

test('signed text creation shows the exact private Marathon window and requires the host to publish', t =>
  verifySignedTextDraft(t, TEXT_REQUEST, /Saturday, November 28, 2026.+12:00\sPM to 1:30\sPM/,
    '2026-11-28T20:00:00.000Z', '2026-11-28T21:30:00.000Z'));

test('a signed December 11 request saves the exact future draft and hides it until Publish', t =>
  verifySignedTextDraft(t, DATED_REQUEST, /Friday, December 11, 2026.+6:30\sPM to 8:00\sPM/,
    '2026-12-12T02:30:00.000Z', '2026-12-12T04:00:00.000Z'));

test('a signed request carries its activity from the private draft to the published card', t =>
  verifySignedTextDraft(t, EXPEDITION_REQUEST,
    /Friday, December 11, 2026.+6:30\sPM to 8:00\sPM/,
    '2026-12-12T02:30:00.000Z', '2026-12-12T04:00:00.000Z', 'Expedition practice'));

async function verifySignedTextDraft(t: TestContext, request: string, organizerWindow: RegExp, startAt: string, endAt: string,
  activity = 'Group play') {
  const now = Date.parse('2026-11-25T12:00:00Z');
  const store = new SessionStore(':memory:', () => new Date(now));
  t.after(() => store.close());
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const config = { ...PILOT, publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
    host: '127.0.0.1', port: 3000, dbPath: ':memory:' };
  const server = createInteractionServer(config, store, () => now);
  let nextId = 100000000000000401n;
  const send = async (input: object) => {
    const raw = JSON.stringify({ ...input, id: String(nextId++) });
    const timestamp = String(now / 1000);
    const signature = sign(null, Buffer.from(timestamp + raw), privateKey).toString('hex');
    const response = await requestOverStream(server, '/interactions', { method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-Signature-Timestamp': timestamp, 'X-Signature-Ed25519': signature }, body: raw });
    assert.equal(response.status, 200);
    return messageData(await response.json() as ReturnType<typeof handleInteraction>);
  };
  await send(command('profile', { bungie_name: 'FictionalHost#1111' }));
  const preview = await send(command('create-text', { request }));
  assert.equal(preview.flags! & EPHEMERAL, EPHEMERAL);
  assert.match(preview.content, /Private draft/);
  assert.match(preview.content, organizerWindow);
  const activityHeading = `**Marathon · ${activity}**`;
  assert.ok(preview.content.split('\n').includes(activityHeading));
  assert.ok(preview.content.includes('America/Los\\_Angeles · 1/3 players'));
  assert.match(preview.content, /Your Bungie Name: keep private/);
  assert.doesNotMatch(preview.content, /FictionalHost/);
  const buttons = preview.components![0].components;
  assert.deepEqual(buttons.map(b => b.label), ['Publish', 'Discard', 'Edit', 'My drafts']);
  const id = buttons[0].custom_id.split(':')[2];
  const actor = { userId: HOST, guildId: GUILD, channelId: CHANNEL };
  const draft = store.getSession(actor, id);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.startAt, startAt);
  assert.equal(draft.endAt, endAt);
  assert.equal(draft.timeZone, 'America/Los_Angeles');
  assert.equal(draft.activity, activity);
  assert.equal(draft.capacity, 3);
  assert.deepEqual(draft.members, [{ userId: HOST, isHost: true }]);
  assert.match((await send(command('find', {}, GUEST))).content, /No open sessions/);
  const click = (action: string, user = HOST) => ({ ...component(action, user, EPHEMERAL),
    data: { component_type: 2, custom_id: `ns:${action}:${id}` } });
  const denied = await send(click('publish', GUEST));
  assert.equal(denied.flags! & EPHEMERAL, EPHEMERAL);
  assert.equal(store.getSession(actor, id).status, 'draft');
  const published = await send(click('publish'));
  assert.equal(published.flags! & EPHEMERAL, 0);
  assert.equal(published.content.split('\n')[0], activityHeading);
  assert.match(published.content, /1\/3 players · open/);
  assert.doesNotMatch(published.content, /FictionalHost/);
  const discovery = await send(command('find', {}, GUEST));
  assert.equal(discovery.components?.[0].components[0].custom_id, `ns:view:${id}`);
  const ids = await send(click('ids'));
  assert.equal(ids.flags! & EPHEMERAL, EPHEMERAL);
  assert.match(ids.content, /ID not shared/);
  assert.doesNotMatch(ids.content, /FictionalHost/);
}

test('signed draft edits keep their scope and consent, and old previews stay stale across restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'squadwaddle-edits-'));
  const path = join(dir, 'drafts.sqlite');
  const now = Date.parse('2026-11-25T12:00:00Z');
  const actor = { userId: HOST, guildId: GUILD, channelId: CHANNEL };
  let store = new SessionStore(path, () => new Date(now));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const config = { ...PILOT, publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
    host: '127.0.0.1', port: 3000, dbPath: path };
  let server = createInteractionServer(config, store, () => now);
  let nextId = 100000000000000600n;
  const interaction = (payload: object) => ({ ...payload, id: String(nextId++) });
  const deliver = (payload: object, receiver = server) => signedMessage(receiver, privateKey, now, payload);
  const send = (payload: object) => deliver(interaction(payload));
  function expectPrivate(reply: MessageData, content: RegExp) {
    assert.equal(reply.flags! & EPHEMERAL, EPHEMERAL);
    assert.match(reply.content, content);
  }
  function draftCode(preview: MessageData): string {
    return preview.components![0].components[0].custom_id.slice('ns:publish:'.length);
  }

  await send(command('profile', { bungie_name: 'OriginalHost#1111' }));
  const original = await send(command('create-text', { request: EXPEDITION_REQUEST, share: true }));
  expectPrivate(original, /Expedition practice/);
  const code = draftCode(original);
  const [id] = code.split(':');
  const before = store.getDraft(actor, id);
  const edit = (draft: string, values: Record<string, unknown>, user = HOST) =>
    command('edit-draft', { draft, ...values }, user);

  expectPrivate(await send(edit(code, { activity: 'Uninvited edit' }, GUEST)), /unavailable/);
  expectPrivate(await send(edit(id, {}, GUEST)), /unavailable/);
  for (const scope of [{ channelId: '100000000000000610' }, { guildId: '100000000000000611' }]) {
    const pair = { guildId: scope.guildId ?? GUILD, channelId: scope.channelId ?? CHANNEL };
    const receiver = createInteractionServer({ ...config, allowedPairs: [pair] }, store, () => now);
    const crossScope = interaction({ ...edit(code, { activity: 'Out of scope' }),
      channel_id: pair.channelId, guild_id: pair.guildId });
    expectPrivate(await deliver(crossScope, receiver), /unavailable/);
  }
  expectPrivate(await send(edit(code, { request: DATED_REQUEST.replace('8:00 pm', '8:00') })), /Add AM or PM/);
  expectPrivate(await send(edit(code, { end: '2026-12-11T10:00:00-08:00' })), /Check your details/);
  expectPrivate(await send(edit(code, { activity: 'OriginalHost#1111' })), /without Bungie Names/);
  assert.deepEqual(store.getDraft(actor, id), before);

  // Saving a different profile name must not change the existing per-session snapshot.
  await send(command('profile', { bungie_name: 'ChangedHost#2222' }));
  const fixTime = interaction(edit(code, { request: DATED_REQUEST.replace('2026-12-11', '2026-12-18') }));
  const rescheduled = await deliver(fixTime);
  expectPrivate(rescheduled, /Friday, December 18, 2026.+6:30\sPM to 8:00\sPM/);
  assert.match(rescheduled.content, /Expedition practice/);
  assert.match(rescheduled.content, /Your Bungie Name: share with joined members/);
  expectPrivate(await deliver(fixTime), /already handled/);

  const codeAfterTime = draftCode(rescheduled);
  assert.notEqual(codeAfterTime, code);
  expectPrivate(await send(edit(code, { activity: 'Delayed edit' })), /out of date/);
  const revised = await send(edit(codeAfterTime, { activity: 'Expedition route practice' }));
  expectPrivate(revised, /Expedition route practice/);
  assert.match(revised.content, /Friday, December 18, 2026/);
  const latest = store.getDraft(actor, id);
  assert.equal(latest.session.activity, 'Expedition route practice');
  assert.equal(latest.session.startAt, '2026-12-19T02:30:00.000Z');
  assert.equal(latest.session.endAt, '2026-12-19T04:00:00.000Z');
  assert.equal(latest.session.expectations, before.session.expectations);
  assert.equal(latest.session.platformNotes, before.session.platformNotes);
  assert.equal(latest.shareName, true);
  assert.equal(latest.session.id, id);

  const oldPublish = interaction(buttonPress(original.components![0].components[0].custom_id, HOST, EPHEMERAL));
  expectPrivate(await deliver(oldPublish), /out of date/);
  expectPrivate(await send(buttonPress(rescheduled.components![0].components[0].custom_id, HOST, EPHEMERAL)), /out of date/);
  expectPrivate(await send(buttonPress(original.components![0].components[1].custom_id, HOST, EPHEMERAL)), /out of date/);
  expectPrivate(await send(buttonPress(`ns:publish:${id}`, HOST, EPHEMERAL)), /out of date/);

  store.close();
  store = new SessionStore(path, () => new Date(now));
  server = createInteractionServer(config, store, () => now);
  expectPrivate(await deliver(oldPublish), /out of date/);
  expectPrivate(await deliver(fixTime), /out of date/);
  assert.deepEqual(store.getDraft(actor, id), latest);
  expectPrivate(await send(command('find', {}, GUEST)), /No open sessions/);

  const reopened = await send(edit(id, {}));
  expectPrivate(reopened, /Expedition route practice/);
  assert.equal(draftCode(reopened), draftCode(revised));
  expectPrivate(await send(buttonPress(reopened.components![0].components[0].custom_id, GUEST, EPHEMERAL)), /unavailable/);
  const publish = interaction(buttonPress(reopened.components![0].components[0].custom_id, HOST, EPHEMERAL));
  const publicCard = await deliver(publish);
  assert.equal(publicCard.flags! & EPHEMERAL, 0);
  assert.match(publicCard.content, /Expedition route practice/);
  assert.doesNotMatch(publicCard.content, /OriginalHost|ChangedHost/);
  expectPrivate(await deliver(publish), /already handled/);
  const shared = await send(buttonPress(`ns:ids:${id}`, HOST));
  expectPrivate(shared, /OriginalHost/);
  assert.doesNotMatch(shared.content, /ChangedHost/);
  expectPrivate(await send(edit(draftCode(reopened), { activity: 'Already published edit' })), /no longer an unpublished draft/);
  assert.equal(store.getSession(actor, id).activity, 'Expedition route practice');

  const structured = await send(command('create', { activity: 'Overnight practice',
    start: '2026-12-05T20:00:00-05:00', end: '2026-12-05T21:00:00-05:00', timezone: 'America/New_York' }));
  const overnight = await send(edit(draftCode(structured), {
    start: '2026-12-05T23:00:00-05:00', end: '2026-12-06T01:00:00-05:00',
  }));
  expectPrivate(overnight, /Saturday, December 5, 2026.+11:00\sPM to Sunday, December 6, 2026.+1:00\sAM/);
  assert.match(overnight.content, /Your Bungie Name: keep private/);
  const [overnightId] = draftCode(overnight).split(':');
  assert.equal(store.getDraft(actor, overnightId).session.timeZone, 'America/New_York');
});

test('signed draft recovery at restart lists only the host’s drafts and reopens the latest revision without a write', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'squadwaddle-draft-recovery-'));
  const path = join(dir, 'drafts.sqlite');
  const now = Date.parse('2026-11-25T12:00:00Z');
  const clock = () => new Date(now);
  const actor = { userId: HOST, guildId: GUILD, channelId: CHANNEL };
  let store = new SessionStore(path, clock);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const config = { ...PILOT, publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
    host: '127.0.0.1', port: 3000, dbPath: path };
  let server = createInteractionServer(config, store, () => now);
  let nextId = 100000000000000800n;
  const send = (payload: object, receiver = server) =>
    signedMessage(receiver, privateKey, now, { ...payload, id: String(nextId++) });
  const list = (page = 1, user = HOST) => command('drafts', page === 1 ? {} : { page }, user);
  function assertPrivate(reply: MessageData, text: RegExp) {
    assert.equal(reply.flags! & EPHEMERAL, EPHEMERAL);
    assert.match(reply.content, text);
  }
  function openButtons(reply: MessageData) {
    return (reply.components ?? []).flatMap(row => row.components).map(button => button.custom_id)
      .filter(id => id.startsWith('ns:open-draft:'));
  }

  await send(command('profile', { bungie_name: 'RecoveryHost#1234' }));
  const original = await send(command('create-text', { request: EXPEDITION_REQUEST, share: true }));
  const oldPublish = original.components![0].components[0].custom_id;
  const [, , id, revision] = oldPublish.split(':');
  const edited = await send(command('edit-draft', { draft: `${id}:${revision}`, activity: 'Route practice' }));
  assertPrivate(edited, /Route practice/);
  const fillers = Array.from({ length: 5 }, (_, index) => {
    const day = String(5 + index).padStart(2, '0');
    return store.createDraft(actor, { ...INPUT, activity: 'RecoveryHost#1234',
      startAt: `2026-12-${day}T12:00:00-08:00`, endAt: `2026-12-${day}T14:00:00-08:00` });
  });
  const guestDraft = store.createDraft({ ...actor, userId: GUEST }, INPUT);
  const published = store.createDraft(actor, INPUT);
  store.publish(actor, published.id);
  const discarded = store.createDraft(actor, INPUT);
  store.cancel(actor, discarded.id, 0);
  const outside = [
    { guildId: '100000000000000820', channelId: CHANNEL },
    { guildId: GUILD, channelId: '100000000000000821' },
  ].map(scope => ({ scope, draft: store.createDraft({ ...actor, ...scope }, INPUT) }));

  const before = store.getDraft(actor, id);
  const pages = [store.listDrafts(actor, 1), store.listDrafts(actor, 2)];
  store.close();
  store = new SessionStore(path, clock);
  server = createInteractionServer(config, store, () => now);

  assertPrivate(await send(list(0)), /positive draft page number/);
  const firstPage = await send(list());
  assertPrivate(firstPage, /Your unpublished drafts · Page 1/);
  assert.equal(firstPage.components![1].components[0].label, 'Next page');
  assert.deepEqual(openButtons(firstPage), fillers.map(draft => `ns:open-draft:${draft.id}`));
  const secondPage = await send(list(2));
  assertPrivate(secondPage, /Your unpublished drafts · Page 2/);
  assert.deepEqual(openButtons(secondPage), [`ns:open-draft:${id}`]);
  assert.doesNotMatch(JSON.stringify([firstPage, secondPage]), /RecoveryHost|Route practice|share with joined members/);
  assertPrivate(await send(list(3)), /no drafts on this page/);
  const empty = await send(list(1, '100000000000000822'));
  assertPrivate(empty, /You have no unpublished drafts in this channel/);
  assert.deepEqual(openButtons(empty), []);

  const open = openButtons(secondPage)[0];
  const guestPage = await send(list(1, GUEST));
  assertPrivate(guestPage, /Your unpublished drafts/);
  assert.deepEqual(openButtons(guestPage), [`ns:open-draft:${guestDraft.id}`]);
  assertPrivate(await send(buttonPress(open, GUEST, EPHEMERAL)), /session is unavailable/);
  for (const { scope, draft } of outside) {
    const receiver = createInteractionServer({ ...config, allowedPairs: [scope] }, store, () => now);
    const scoped = (payload: object) => send({ ...payload, guild_id: scope.guildId, channel_id: scope.channelId }, receiver);
    const scopedPage = await scoped(list());
    assertPrivate(scopedPage, /Your unpublished drafts/);
    assert.deepEqual(openButtons(scopedPage), [`ns:open-draft:${draft.id}`]);
    assertPrivate(await scoped(buttonPress(open, HOST, EPHEMERAL)), /session is unavailable/);
  }

  const recovered = await send(buttonPress(open, HOST, EPHEMERAL));
  assertPrivate(recovered, /Your Bungie Name: share with joined members/);
  assert.deepEqual(recovered, edited);
  assert.doesNotMatch(recovered.content, /RecoveryHost/);
  assert.deepEqual(store.getDraft(actor, id), before);
  assert.deepEqual([store.listDrafts(actor, 1), store.listDrafts(actor, 2)], pages);
  assert.deepEqual(store.listSessions(actor).map(session => session.id), [published.id]);

  assertPrivate(await send(buttonPress(oldPublish, HOST, EPHEMERAL)), /out of date/);
  const latestPublish = recovered.components![0].components[0];
  assert.equal(latestPublish.label, 'Publish');
  const card = await send(buttonPress(latestPublish.custom_id, HOST, EPHEMERAL));
  assert.equal(card.flags! & EPHEMERAL, 0);
  assert.match(card.content, /Route practice/);
  assert.doesNotMatch(card.content, /RecoveryHost/);
  assertPrivate(await send(buttonPress(open, HOST, EPHEMERAL)), /no longer an unpublished draft/);

  store.cancel(actor, fillers[0].id, 0);
  assertPrivate(await send(buttonPress(openButtons(firstPage)[0], HOST, EPHEMERAL)), /no longer an unpublished draft/);
  const remaining = await send(list());
  assertPrivate(remaining, /Your unpublished drafts/);
  assert.deepEqual(openButtons(remaining), openButtons(firstPage).slice(1));
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
    const res = await requestOverStream(server, '/interactions', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Signature-Timestamp': timestamp, 'X-Signature-Ed25519': signature,
    }, body });
    assert.equal(res.status, 200);
    return messageData(await res.json() as ReturnType<typeof handleInteraction>);
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

test('only the original public Publish response supplies a durable channel card link', t => {
  const dir = mkdtempSync(join(tmpdir(), 'squadwaddle-card-'));
  const path = join(dir, 'pilot.sqlite');
  const now = () => new Date('2026-11-25T12:00:00Z');
  const actor = { guildId: GUILD, channelId: CHANNEL, userId: HOST };
  const publishId = '100000000000000201';
  const cardId = '100000000000000202';
  const otherId = '100000000000000203';
  let store = new SessionStore(path, now);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const session = store.createDraft(actor, INPUT);
  store.publish(actor, session.id, publishId);
  const legacySession = store.createDraft(actor, INPUT);
  store.publish(actor, legacySession.id); // Open without a Discord receipt.
  const legacyDraft = store.createDraft(actor, INPUT);
  const legacyWeekend = store.createWeekendDraft(actor, { ...INPUT,
    availability: { saturday: '2026-11-28', sunday: '2026-11-29', timeZone: 'UTC' } });
  store.close();
  const oldSchema = new DatabaseSync(path);
  oldSchema.exec(`DROP TABLE public_cards;
    ALTER TABLE sessions DROP COLUMN draft_revision;
    ALTER TABLE sessions DROP COLUMN capacity;
    ALTER TABLE weekend_drafts DROP COLUMN capacity`);
  oldSchema.close();
  store = new SessionStore(path, now);

  const origin = { type: 3, id: publishId };
  const source = { channel_id: CHANNEL, application_id: APP, flags: 4, id: cardId, interaction_metadata: origin };
  const refresh = (message: unknown, id = session.id) => handleInteraction({ ...component('refresh', GUEST),
    data: { component_type: 2, custom_id: `ns:refresh:${id}` }, message }, store, PILOT);
  const find = () => messageData(handleInteraction(command('find', {}, GUEST), store, PILOT));
  for (const changed of [
    { flags: EPHEMERAL }, { flags: undefined }, { application_id: otherId }, { channel_id: otherId },
    { id: 'invalid' }, { interaction_metadata: undefined }, { interaction_metadata: { ...origin, type: 2 } },
    { interaction_metadata: { ...origin, id: otherId } },
    { interaction_metadata: { ...origin, original_response_message_id: cardId } },
  ]) refresh({ ...source, ...changed });
  refresh(source, legacySession.id);
  store.confirmPublicCard({ ...actor, channelId: otherId }, session.id, publishId, otherId);
  store.confirmPublicCard({ ...actor, guildId: otherId }, session.id, publishId, otherId);
  assert.doesNotMatch(find().content, /discord\.com\/channels/);
  assert.equal(find().components![0].components.length, 2, 'private search stays usable without a known card');
  assert.equal(refresh(source).type, 7);
  refresh({ ...source, id: otherId });
  store.close();
  store = new SessionStore(path, now);
  const result = find();
  const url = `https://discord.com/channels/${GUILD}/${CHANNEL}/${cardId}`;
  assert.equal(result.flags! & EPHEMERAL, EPHEMERAL);
  assert.equal(result.content.split(url).length - 1, 1);
  assert.equal(store.getSession(actor, legacySession.id).publicMessageId, undefined);
  const confirmation = messageData(handleInteraction(command('cancel', { session: session.id }), store, PILOT));
  const cancelled = messageData(handleInteraction(buttonPress(confirmation.components![0].components[0].custom_id, HOST, EPHEMERAL), store, PILOT));
  assert.ok(cancelled.content.includes(url));
  assert.equal(cancelled.flags! & EPHEMERAL, EPHEMERAL);
  assert.ok(!find().content.includes(url));
  assert.equal(store.getDraft(actor, legacyDraft.id).revision, 0);
  assert.equal(store.getDraft(actor, legacyDraft.id).session.capacity, 3);
  assert.equal(store.getSession(actor, legacySession.id).capacity, 3);
  assert.equal(store.getDraft(actor, legacyWeekend.session.id).session.capacity, 3);
  const legacyPublish = { ...buttonPress(`ns:publish:${legacyDraft.id}`, HOST, EPHEMERAL), id: '100000000000000204' };
  assert.equal(messageData(handleInteraction(legacyPublish, store, PILOT)).flags! & EPHEMERAL, 0);
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
  const legacy = publicCard({ ...sample(), activity: 'LegacyName#1234', platformNotes: 'PC with PrivateName#9876' });
  assert.doesNotMatch(legacy.content, /LegacyName|PrivateName/);
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
  assert.equal(card.components![0].components[0].label, 'Join');
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
  assert.deepEqual(loadServerConfig(env).allowedPairs, [{ guildId: GUILD, channelId: CHANNEL }]);
  const pairs = `${GUILD}:${CHANNEL}, ${OTHER_GUILD}:${OTHER_CHANNEL}`;
  assert.deepEqual(loadServerConfig({ DISCORD_APPLICATION_ID: APP, DISCORD_PUBLIC_KEY: 'ab'.repeat(32), PILOT_ALLOWED_PAIRS: pairs }).allowedPairs,
    [{ guildId: GUILD, channelId: CHANNEL }, { guildId: OTHER_GUILD, channelId: OTHER_CHANNEL }]);
  assert.deepEqual(loadServerConfig({ ...env, PILOT_ALLOWED_PAIRS: `${OTHER_GUILD}:${OTHER_CHANNEL}` }).allowedPairs,
    [{ guildId: OTHER_GUILD, channelId: OTHER_CHANNEL }]);
  for (const value of ['', 'bad', `${GUILD}:${CHANNEL},`, `${GUILD}:${CHANNEL}:${OTHER_CHANNEL}`,
    `${GUILD}:${CHANNEL},${OTHER_GUILD}:${CHANNEL}`]) {
    assert.throws(() => loadServerConfig({ ...env, PILOT_ALLOWED_PAIRS: value }), /PILOT_ALLOWED_PAIRS/);
  }
  assert.throws(() => loadServerConfig({ ...env, DISCORD_PUBLIC_KEY: '' }), /PUBLIC_KEY/);
  assert.throws(() => loadServerConfig({ ...env, PORT: '0' }), /PORT/);
  assert.throws(() => createInteractionServer({ ...loadServerConfig(env), publicKey: '' }, new FakeStore()), /public key/);
  assert.throws(() => createInteractionServer({ ...loadServerConfig(env), allowedPairs: [] }, new FakeStore()), /PILOT_ALLOWED_PAIRS/);
});

test('signed HTTP boundary validates raw bytes, freshness, scope, size, replay, and health without credentials', async t => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const hex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  let now = Date.now();
  const config = { ...PILOT, publicKey: hex, host: '127.0.0.1', port: 3000, dbPath: ':memory:' };
  const store = new FakeStore();
  const server = createInteractionServer(config, store, () => now);
  const send = await testHttp(t, server);
  const post = (raw: string, extra: Record<string, string> = {}, timestamp = String(Math.floor(now / 1000))) => {
    const signature = sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(raw)]), privateKey).toString('hex');
    return send('/interactions', { method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-Signature-Timestamp': timestamp, 'X-Signature-Ed25519': signature, ...extra }, body: raw });
  };
  assert.deepEqual(await (await send('/health')).json(), { ok: true });
  assert.equal((await send('/interactions')).status, 405);
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

test('a single signed endpoint isolates sessions and sharing across two allowed guild/channel pairs', async t => {
  const now = Date.parse('2026-11-25T12:00:00Z');
  const store = new SessionStore(':memory:', () => new Date(now));
  t.after(() => store.close());
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const config = loadServerConfig({
    DISCORD_APPLICATION_ID: APP,
    DISCORD_PUBLIC_KEY: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
    PILOT_ALLOWED_PAIRS: `${GUILD}:${CHANNEL},${OTHER_GUILD}:${OTHER_CHANNEL}`,
    DB_PATH: ':memory:',
  });
  const server = createInteractionServer(config, store, () => now);
  const beta = { guild_id: OTHER_GUILD, channel_id: OTHER_CHANNEL };
  const hosts = [
    { userId: HOST, guildId: GUILD, channelId: CHANNEL },
    { userId: HOST, guildId: OTHER_GUILD, channelId: OTHER_CHANNEL },
  ];
  let nextId = 100000000000001000n;
  const send = (payload: object, scope: object = {}) =>
    signedMessage(server, privateKey, now, { ...payload, ...scope, id: String(nextId++) });
  const create = (activity: string) => command('create', {
    activity, start: INPUT.startAt, end: INPUT.endAt, timezone: INPUT.timeZone, share: true,
  });
  const press = (action: string, id: string, user = HOST) => buttonPress(`ns:${action}:${id}`, user);
  function privateReply(reply: MessageData, expected: RegExp): MessageData {
    assert.equal(reply.flags! & EPHEMERAL, EPHEMERAL);
    assert.match(reply.content, expected);
    return reply;
  }

  for (const forbidden of [
    { channel_id: OTHER_CHANNEL },
    { guild_id: OTHER_GUILD },
    { guild_id: '100000000000001020', channel_id: '100000000000001021' },
    { channel_id: '100000000000001022' },
    { context: 1, ...beta },
    { context: 2, ...beta },
    { guild_id: undefined, member: undefined, user: { id: HOST } },
  ]) {
    privateReply(await send(create('Out of bounds'), forbidden), /only in approved pilot channels/);
  }
  for (const host of hosts) assert.deepEqual(store.listDrafts(host, 1).drafts, []);

  // Profiles are still global. Each explicit share takes its own session snapshot.
  await send(command('profile', { bungie_name: 'AlphaHost#1111' }));
  const draftA = privateReply(await send(create('Alpha practice')), /Private draft/);
  await send(command('profile', { bungie_name: 'BetaHost#2222' }), beta);
  const draftB = privateReply(await send(create('Beta practice'), beta), /Private draft/);
  const publishA = draftA.components![0].components[0].custom_id;
  const publishB = draftB.components![0].components[0].custom_id;
  const idA = publishA.split(':')[2];
  const idB = publishB.split(':')[2];
  const draftsA = privateReply(await send(command('drafts')), /Your unpublished drafts/);
  const draftsB = privateReply(await send(command('drafts'), beta), /Your unpublished drafts/);
  assert.deepEqual(draftsA.components![0].components.map(button => button.custom_id), [`ns:open-draft:${idA}`]);
  assert.deepEqual(draftsB.components![0].components.map(button => button.custom_id), [`ns:open-draft:${idB}`]);
  privateReply(await send(press('open-draft', idA), beta), /session is unavailable/);
  privateReply(await send(press('open-draft', idB)), /session is unavailable/);
  privateReply(await send(command('edit-draft', { draft: publishA.slice('ns:publish:'.length), activity: 'Wrong server' }), beta),
    /session is unavailable/);
  privateReply(await send(buttonPress(publishB, HOST, EPHEMERAL)), /session is unavailable/);
  assert.equal(store.getDraft(hosts[0], idA).session.activity, 'Alpha practice');
  assert.equal(store.getDraft(hosts[1], idB).session.activity, 'Beta practice');

  const cardA = await send(buttonPress(publishA, HOST, EPHEMERAL));
  const cardB = await send(buttonPress(publishB, HOST, EPHEMERAL), beta);
  for (const card of [cardA, cardB]) {
    assert.equal(card.flags! & EPHEMERAL, 0);
    assert.doesNotMatch(card.content, /AlphaHost|BetaHost/);
  }
  const foundA = privateReply(await send(command('find', {}, GUEST)), /Alpha practice/);
  const foundB = privateReply(await send(command('find', {}, GUEST), beta), /Beta practice/);
  assert.deepEqual(foundA.components![0].components.map(button => button.custom_id), [`ns:view:${idA}`]);
  assert.deepEqual(foundB.components![0].components.map(button => button.custom_id), [`ns:view:${idB}`]);
  privateReply(await send(press('view', idA, GUEST), beta), /session is unavailable/);
  privateReply(await send(press('join', idA, GUEST), beta), /session is unavailable/);
  privateReply(await send(press('join-share', idB, GUEST)), /session is unavailable/);
  assert.equal(store.getSession(hosts[0], idA).members.length, 1);
  assert.equal(store.getSession(hosts[1], idB).members.length, 1);

  await send(command('profile', { bungie_name: 'AlphaGuest#3333' }, GUEST));
  assert.match((await send(press('join', idB, GUEST), beta)).content, /2\/3 players/);
  const idsBWithoutShare = privateReply(await send(press('ids', idB, GUEST), beta), /BetaHost/);
  assert.match(idsBWithoutShare.content, /ID not shared/);
  assert.doesNotMatch(idsBWithoutShare.content, /AlphaHost|AlphaGuest/);
  privateReply(await send(press('ids', idA, GUEST)), /Join this session/);
  privateReply(await send(press('ids', idA, GUEST), beta), /session is unavailable/);
  assert.match((await send(press('join-share', idA, GUEST))).content, /2\/3 players/);

  const revokeA = command('share', { session: idA, enabled: false }, GUEST);
  privateReply(await send(revokeA, beta), /session is unavailable/);
  privateReply(await send(command('share', { session: idB, enabled: true }, GUEST)), /session is unavailable/);
  await send(command('profile', { bungie_name: 'BetaGuest#4444' }, GUEST), beta);
  privateReply(await send(command('share', { session: idB, enabled: true }, GUEST), beta), /shared with current members/);

  const idsA = privateReply(await send(press('ids', idA)), /AlphaHost/);
  assert.match(idsA.content, /AlphaGuest/);
  assert.doesNotMatch(idsA.content, /BetaHost|BetaGuest/);
  const idsB = privateReply(await send(press('ids', idB), beta), /BetaHost/);
  assert.match(idsB.content, /BetaGuest/);
  assert.doesNotMatch(idsB.content, /AlphaHost|AlphaGuest/);

  privateReply(await send(revokeA), /will no longer show/);
  assert.doesNotMatch(privateReply(await send(press('ids', idA)), /ID not shared/).content, /AlphaGuest|BetaGuest/);
  assert.deepEqual(await send(press('ids', idB), beta), idsB);
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

function localWorkflow(t: TestContext, store: SessionStore, now: number) {
  t.after(() => store.close());
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const server = createInteractionServer({ ...PILOT, publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
    host: '127.0.0.1', port: 3000, dbPath: ':memory:' }, store, () => now);
  let nextId = 100000000000003000n;
  const send = (payload: object) => signedResponse(server, privateKey, now, { ...payload, id: String(nextId++) });
  const press = (card: MessageData, label: string, user = HOST) => send(buttonPress(buttonNamed(card, label).custom_id, user, card.flags));
  return { send, press };
}

test('the compact menu creates, edits, shares, and cancels through signed contextual controls', async t => {
  const now = Date.parse('2026-11-25T12:00:00Z');
  const store = new SessionStore(':memory:', () => new Date(now));
  const { send, press } = localWorkflow(t, store, now);
  const host = { userId: HOST, guildId: GUILD, channelId: CHANNEL };
  const names = SESSION_COMMAND.options.map(option => option.name);
  assert.deepEqual(names, ['create', 'find', 'help']);
  assert.deepEqual(SESSION_COMMAND.options[0].options?.map(option => option.name), ['request']);

  const help = messageData(await send(command('help')));
  assert.equal(help.flags! & EPHEMERAL, EPHEMERAL);
  assert.equal(help.content.split('“').length - 1, 1);
  const profile = messageData(await press(help, 'My Bungie ID'));
  const profileForm = await press(profile, 'Save Bungie ID');
  assert.equal(profileForm.type, 9);
  const saved = messageData(await send(submitForm(profileForm.data.custom_id, { bungie_name: 'LocalHost#1234' })));
  assert.equal(saved.flags! & EPHEMERAL, EPHEMERAL);
  const request = 'I need two more for Marathon Friday noon–3 pm UTC for Expedition practice.';
  const initial = messageData(await send(command('create', { request, share: true })));
  assert.equal(initial.flags! & EPHEMERAL, EPHEMERAL);
  assert.match(initial.content, /Marathon · Expedition practice/);
  assert.match(initial.content, /1\/3 players/);
  assert.match(initial.content, /Friday, November 27, 2026.+12:00\sPM to 3:00\sPM/);
  assert.match(initial.content, /Your Bungie Name: keep private/);
  assert.match(initial.content, /Platform · optional/);
  const start = Date.parse('2026-11-27T12:00:00Z');
  const end = Date.parse('2026-11-27T15:00:00Z');
  assert.ok(initial.content.includes(`<t:${start / 1000}:f> → <t:${end / 1000}:f>`));
  const pacific = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric' });
  assert.match(pacific.format(start), /^4\sAM$/);
  assert.match(pacific.format(end), /^7\sAM$/);
  assert.doesNotMatch(initial.content, /LocalHost/);
  const [, , id] = buttonNamed(initial, 'Publish').custom_id.split(':');
  assert.equal(store.getDraft(host, id).shareName, false);
  assert.match(messageData(await press(initial, 'Edit', GUEST)).content, /unavailable/);

  let latest = initial;
  for (const platform of ['PC', 'PS5', '']) {
    const form = await press(latest, 'Edit');
    assert.equal(form.type, 9);
    const edited = messageData(await send(submitForm(form.data.custom_id, { platform })));
    assert.equal(edited.flags! & EPHEMERAL, EPHEMERAL);
    assert.ok(edited.content.includes(`Platform · ${platform || 'optional'}`));
    assert.match(messageData(await send(submitForm(form.data.custom_id, { platform: 'Stale' }))).content, /out of date/);
    latest = edited;
  }
  const sharing = messageData(await press(latest, 'Share my Bungie ID: Yes'));
  assert.equal(store.getDraft(host, id).shareName, true);
  assert.match(sharing.content, /share with joined members/);
  const privateAgain = messageData(await press(sharing, 'Share my Bungie ID: No'));
  assert.equal(store.getDraft(host, id).shareName, false);
  assert.match(privateAgain.content, /keep private/);
  const drafts = messageData(await press(help, 'My drafts'));
  const reviewed = messageData(await press(drafts, 'Open 1'));
  assert.deepEqual(reviewed, privateAgain);
  assert.match(messageData(await press(initial, 'Publish')).content, /out of date/);
  assert.match(messageData(await send(command('find'))).content, /No open sessions/);

  const published = messageData(await press(reviewed, 'Publish'));
  assert.equal(published.flags! & EPHEMERAL, 0);
  assert.doesNotMatch(published.content, /LocalHost|Platform/);
  assert.doesNotMatch(JSON.stringify(published.components), /voice/i);
  assert.match(messageData(await press(published, 'Host Cancel', GUEST)).content, /Only the host/);
  const confirmation = messageData(await press(published, 'Host Cancel'));
  assert.equal(confirmation.flags! & EPHEMERAL, EPHEMERAL);
  assert.equal(store.getSession(host, id).status, 'open');
  assert.match(messageData(await press(confirmation, 'Keep session')).content, /players · open/);
  assert.match(messageData(await press(confirmation, 'Confirm cancellation', GUEST)).content, /Only the host/);
  const cancelled = messageData(await press(confirmation, 'Confirm cancellation'));
  assert.match(cancelled.content, /Session cancelled.*Press Refresh/);
  const refreshed = await press(published, 'Join', GUEST);
  assert.equal(refreshed.type, 7);
  assert.match(refreshed.data.content, /cancelled/);
  assert.equal(buttonNamed(refreshed.data, 'Join').disabled, true);
  assert.match(messageData(await send(buttonPress(`ns:join:${id}`, GUEST))).content, /no longer open/);
});

test('signed capacity flows distinguish total seats from extra players and enforce the reviewed limit', async t => {
  const now = Date.parse('2026-11-25T12:00:00Z');
  const store = new SessionStore(':memory:', () => new Date(now));
  const { send, press } = localWorkflow(t, store, now);
  const host = { userId: HOST, guildId: GUILD, channelId: CHANNEL };
  const schedule = 'Marathon Friday noon–3 pm UTC for Expedition practice';
  const create = async (request: string) => messageData(await send(command('create', { request })));
  for (const request of [
    `Four players for ${schedule}`,
    `Three or four more for ${schedule}`,
    `Two more for ${schedule} with six players total`,
    `${schedule} with about six players total`,
    `Nine players total for ${schedule}`,
    `${schedule}, 1 player total`,
    `2.5 players total for ${schedule}`,
  ]) {
    const rejected = await create(request);
    assert.equal(rejected.flags! & EPHEMERAL, EPHEMERAL);
    assert.match(rejected.content, /How many seats total.*including you/, request);
  }
  assert.equal(store.listDrafts(host, 1).drafts.length, 0);
  for (const request of [schedule, `Two more for ${schedule}`]) {
    assert.match((await create(request)).content, /1\/3 players/);
  }
  const four = await create(`Four players total for ${schedule}`);
  assert.match(four.content, /1\/4 players/);
  const fourCard = messageData(await press(four, 'Publish'));
  assert.match(fourCard.content, /1\/4 players · open/);
  const [, , fourId] = buttonNamed(four, 'Publish').custom_id.split(':');
  assert.match((await create(`${schedule} with 6 players total`)).content, /1\/6 players/);
  const draft = await create(`Three more for ${schedule}`);
  assert.match(draft.content, /1\/4 players/);
  await send(command('profile', { bungie_name: 'CapacityHost#5555' }));
  const sharing = messageData(await press(draft, 'Share my Bungie ID: Yes'));
  const form = await press(sharing, 'Edit');
  assert.equal(form.type, 9);
  const [, , id] = buttonNamed(sharing, 'Publish').custom_id.split(':');
  const before = store.getDraft(host, id);
  const bad = await send(submitForm(form.data.custom_id, { capacity: '9' }));
  assert.match(messageData(bad).content, /How many seats total/);
  const conflict = await send(submitForm(form.data.custom_id, { request: `Five more for ${schedule}`, capacity: '4' }));
  assert.match(messageData(conflict).content, /How many seats total/);
  assert.deepEqual(store.getDraft(host, id), before);
  const resized = messageData(await send(submitForm(form.data.custom_id, { capacity: '6' })));
  assert.match(resized.content, /1\/6 players/);
  assert.match(resized.content, /share with joined members/);
  assert.doesNotMatch(resized.content, /CapacityHost/);
  assert.match(messageData(await press(sharing, 'Publish')).content, /out of date/);
  assert.equal(store.getDraft(host, id).session.capacity, 6);
  assert.equal(store.getDraft(host, id).shareName, true);
  const sixCard = messageData(await press(resized, 'Publish'));
  assert.equal(sixCard.flags! & EPHEMERAL, 0);
  assert.match(sixCard.content, /1\/6 players · open/);
  assert.doesNotMatch(sixCard.content, /CapacityHost/);
  const found = messageData(await send(command('find')));
  assert.match(found.content, /1\/4 players/);
  assert.match(found.content, /1\/6 players/);

  const players = Array.from({ length: 6 }, (_, index) => String(100000000000004000n + BigInt(index)));
  for (const player of players.slice(0, 3)) await send(buttonPress(`ns:join:${fourId}`, player, EPHEMERAL));
  assert.equal(store.getSession(host, fourId).members.length, 4);
  assert.match(messageData(await send(buttonPress(`ns:join:${fourId}`, players[3], EPHEMERAL))).content, /group is full/);
  const joins = await Promise.all(players.map(user => send(buttonPress(`ns:join:${id}`, user, EPHEMERAL))));
  assert.equal(joins.filter(reply => /You joined this session/.test(messageData(reply).content)).length, 5);
  const deniedIndex = joins.findIndex(reply => /group is full/.test(messageData(reply).content));
  assert.ok(deniedIndex >= 0);
  assert.equal(store.getSession(host, id).members.length, 6);
  assert.deepEqual(store.getSharedNames(host, id).map(member => member.bungieName).filter(Boolean), ['CapacityHost#5555']);
  const admitted = players.find(user => user !== players[deniedIndex])!;
  await send(buttonPress(`ns:leave:${id}`, admitted));
  assert.match(messageData(await send(buttonPress(`ns:join:${id}`, players[deniedIndex]))).content, /6\/6 players/);
});

test('an eight-player roster with maximum-length shared names fits a private Discord reply', async t => {
  const now = Date.parse('2026-11-25T12:00:00Z');
  const store = new SessionStore(':memory:', () => new Date(now));
  const { send, press } = localWorkflow(t, store, now);
  const players = [HOST, ...Array.from({ length: 7 }, (_, index) => String(100000000000004100n + BigInt(index)))];
  for (const player of players) {
    await send(command('profile', { bungie_name: `${'*'.repeat(95)}#1234` }, player));
  }
  const original = messageData(await send(command('create', { request: 'Eight players total for Marathon Friday noon–3 pm UTC.' })));
  assert.match(original.content, /1\/8 players/);
  const draft = messageData(await press(original, 'Share my Bungie ID: Yes'));
  const [, , id] = buttonNamed(draft, 'Publish').custom_id.split(':');
  const card = messageData(await press(draft, 'Publish'));
  let roster = card;
  for (const player of players.slice(1)) {
    roster = messageData(await send(buttonPress(`ns:join-share:${id}`, player)));
  }
  assert.match(roster.content, /8\/8 players/);
  assert.doesNotMatch(roster.content, /#1234\b/);
  assert.ok(roster.content.length <= 2000);
  const ids = messageData(await press(card, 'Show group IDs'));
  assert.equal(ids.flags! & EPHEMERAL, EPHEMERAL);
  assert.equal(ids.content.split('\\#1234').length - 1, 8);
  assert.ok(ids.content.length <= 2000, `Group IDs reply has ${ids.content.length} characters`);
});

test('a signed all-weekend request is a recoverable date-only draft until exact times are reviewed', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'squadwaddle-weekend-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'weekend.sqlite');
  const now = Date.parse('2026-11-25T12:00:00Z');
  const clock = () => new Date(now);
  const host = { userId: HOST, guildId: GUILD, channelId: CHANNEL };
  const firstStore = new SessionStore(path, clock);
  const first = localWorkflow(t, firstStore, now);
  assert.match(messageData(await first.send(command('create', { request: 'Two more for Marathon all weekend.' }))).content,
    /Add a time zone/);
  const request = 'Six players total for Marathon all weekend in Pacific for Expedition practice.';
  const weekend = messageData(await first.send(command('create', { request })));
  assert.equal(weekend.flags! & EPHEMERAL, EPHEMERAL);
  assert.match(weekend.content, /Saturday, November 28, 2026 – Sunday, November 29, 2026/);
  assert.match(weekend.content, /Flexible hours/);
  assert.match(weekend.content, /1\/6 players/);
  assert.doesNotMatch(weekend.content, /<t:/);
  const oldPublish = buttonNamed(weekend, 'Publish');
  assert.equal(oldPublish.disabled, true);
  const [, , id] = oldPublish.custom_id.split(':');
  assert.equal(firstStore.getDraft(host, id).session.startAt, undefined);
  const timed = new DatabaseSync(path);
  assert.equal(timed.prepare('SELECT COUNT(*) AS count FROM sessions').get()!.count, 0);
  timed.close();
  firstStore.close();

  const store = new SessionStore(path, clock);
  const { send, press } = localWorkflow(t, store, now);
  const help = messageData(await send(command('help')));
  const drafts = messageData(await press(help, 'My drafts'));
  assert.match(drafts.content, /exact times pending/);
  assert.match(messageData(await press(drafts, 'Open 1', GUEST)).content, /session is unavailable/);
  const recovered = messageData(await press(drafts, 'Open 1'));
  assert.deepEqual(recovered, weekend);
  assert.match(messageData(await press(recovered, 'Publish')).content, /exact times in Edit/);

  await send(command('profile', { bungie_name: 'WeekendHost#9876' }));
  const sharing = messageData(await press(recovered, 'Share my Bungie ID: Yes'));
  const sizeForm = await press(sharing, 'Edit');
  assert.equal(sizeForm.type, 9);
  const resized = messageData(await send(submitForm(sizeForm.data.custom_id, { capacity: '4' })));
  assert.match(resized.content, /1\/4 players/);
  assert.match(resized.content, /share with joined members/);
  assert.equal(buttonNamed(resized, 'Publish').disabled, true);
  const form = await press(resized, 'Edit');
  assert.equal(form.type, 9);
  for (const wrong of ['Two more for Marathon Friday noon–3 pm Pacific.', 'Two more for Marathon Saturday noon–3 pm UTC.']) {
    assert.match(messageData(await send(submitForm(form.data.custom_id, { request: wrong }))).content,
      /one day of this weekend, in the selected time zone/);
  }
  assert.equal(store.getDraft(host, id).session.startAt, undefined);
  const exact = messageData(await send(submitForm(form.data.custom_id, {
    request: 'Marathon Saturday noon–3 pm Pacific.', platform: 'PC',
  })));
  assert.equal(exact.flags! & EPHEMERAL, EPHEMERAL);
  assert.equal(buttonNamed(exact, 'Publish').disabled, false);
  assert.equal(buttonNamed(exact, 'Publish').custom_id.split(':')[2], id);
  assert.match(exact.content, /Marathon · Expedition practice/);
  assert.match(exact.content, /share with joined members/);
  const confirmed = store.getDraft(host, id);
  assert.equal(confirmed.availability, undefined);
  assert.equal(confirmed.session.startAt, '2026-11-28T20:00:00.000Z');
  assert.equal(confirmed.session.endAt, '2026-11-28T23:00:00.000Z');
  assert.equal(confirmed.session.capacity, 4);
  assert.deepEqual(store.listDrafts(host, 1).drafts.map(draft => draft.id), [id]);
  assert.match(messageData(await press(sharing, 'Publish')).content, /out of date/);
  assert.match(messageData(await send(command('find'))).content, /No open sessions/);
  const card = messageData(await press(exact, 'Publish'));
  assert.equal(card.flags! & EPHEMERAL, 0);
  assert.match(card.content, /1\/4 players/);
  assert.doesNotMatch(card.content, /WeekendHost/);
  assert.match(messageData(await press(card, 'Show group IDs')).content, /WeekendHost/);

  const preferred = messageData(await send(command('create', {
    request: 'Two more for Marathon all weekend from noon to 3 pm UTC.',
  })));
  assert.match(preferred.content, /Preferred each day · 12:00\sPM to 3:00\sPM/);
  assert.equal(buttonNamed(preferred, 'Publish').disabled, true);
  assert.match(messageData(await press(preferred, 'Discard')).content, /Draft discarded/);
  assert.deepEqual(store.listDrafts(host, 1).drafts, []);
});

test('signed weekend dates follow the organizer zone at a UTC day boundary', async t => {
  const now = Date.parse('2026-11-29T01:00:00Z');
  const { send } = localWorkflow(t, new SessionStore(':memory:', () => new Date(now)), now);
  const pacific = messageData(await send(command('create', { request: 'Two more for Marathon all weekend Pacific.' })));
  assert.match(pacific.content, /Saturday, November 28, 2026 – Sunday, November 29, 2026/);
  const utc = messageData(await send(command('create', { request: 'Two more for Marathon all weekend UTC.' })));
  assert.match(utc.content, /Saturday, December 5, 2026 – Sunday, December 6, 2026/);
  assert.equal(buttonNamed(pacific, 'Publish').disabled, true);
  assert.equal(buttonNamed(utc, 'Publish').disabled, true);
});

test('real SQLite store through signed HTTP enforces preview, consent, membership and revocation end to end', t =>
  verifySignedSessionFlow(t, 'structured'));

test('offline solo rehearsal', t => verifySignedSessionFlow(t, 'text'));

async function verifySignedSessionFlow(t: TestContext, draftSource: 'structured' | 'text') {
  const rehearsal = draftSource === 'text';
  const checkpoint = (message: string) => { if (rehearsal) t.diagnostic(`PASS ${message}`); };
  const now = Date.parse('2026-11-25T12:00:00Z');
  const store = new SessionStore(':memory:', () => new Date(now));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const hex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const server = createInteractionServer({ ...PILOT, publicKey: hex, host: '127.0.0.1', port: 3000, dbPath: ':memory:' }, store, () => now);
  t.after(() => store.close());
  const http = rehearsal
    ? (path: string, init?: TestRequest) => requestOverStream(server, path, init)
    : await testHttp(t, server);
  let nextId = 100000000000000100n;
  const send = async (input: unknown) => {
    const raw = JSON.stringify({ ...(input as Record<string, unknown>), id: String(nextId++) });
    const timestamp = String(now / 1000);
    const signature = sign(null, Buffer.from(timestamp + raw), privateKey).toString('hex');
    const response = await http('/interactions', { method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-Signature-Timestamp': timestamp, 'X-Signature-Ed25519': signature }, body: raw });
    assert.equal(response.status, 200);
    return await response.json() as ReturnType<typeof handleInteraction>;
  };
  const fictionalNames = /HostSecret|GuestSecret|PrivateSecret/;
  function privateReply(response: ReturnType<typeof handleInteraction>) {
    const data = messageData(response);
    assert.equal(response.type, 4);
    assert.equal(data.flags! & EPHEMERAL, EPHEMERAL);
    return data;
  }
  function publicReply(response: ReturnType<typeof handleInteraction>, type: 4 | 7) {
    const data = messageData(response);
    assert.equal(response.type, type);
    assert.equal(data.flags! & EPHEMERAL, 0);
    assert.doesNotMatch(JSON.stringify(response), fictionalNames);
    return data;
  }
  const click = (card: MessageData, label: string, user = HOST) => {
    const button = card.components?.flatMap(row => row.components).find(button => button.label === label);
    assert.ok(button && !button.disabled, `Expected an enabled "${label}" button`);
    return buttonPress(button.custom_id, user, card.flags);
  };

  const third = '100000000000000006';
  const fourth = '100000000000000007';
  await send(command('profile', { bungie_name: 'HostSecret#1111' }));
  await send(command('profile', { bungie_name: 'GuestSecret#2222' }, GUEST));
  if (rehearsal) {
    const saved = privateReply(await send(command('profile', { bungie_name: 'PrivateSecret#3333' }, third)));
    assert.match(saved.content, /Bungie Name saved privately/);
  }
  const draftCommand = rehearsal
    ? command('create', { request: EXPEDITION_REQUEST })
    : command('create', { activity: INPUT.activity, start: INPUT.startAt, end: INPUT.endAt, timezone: INPUT.timeZone, share: true });
  let preview = privateReply(await send(draftCommand));
  if (rehearsal) {
    assert.match(preview.content, /Your Bungie Name: keep private/);
    preview = privateReply(await send(click(preview, 'Share my Bungie ID: Yes')));
  }
  assert.match(preview.content, /Private draft/);
  assert.match(preview.content, /Your Bungie Name: share with joined members/);
  assert.doesNotMatch(preview.content, fictionalNames);
  assert.deepEqual(preview.components![0].components.map(button => button.label), ['Publish', 'Discard', 'Edit', 'My drafts']);
  assert.match(privateReply(await send(command('find'))).content, /No open sessions/);
  assert.match(privateReply(await send(command('find', {}, GUEST))).content, /No open sessions/);
  const custom = preview.components![0].components[0].custom_id;
  const id = custom.split(':')[2];
  const host = { userId: HOST, guildId: GUILD, channelId: CHANNEL };
  const draft = store.getSession(host, id);
  assert.equal(draft.status, 'draft');
  if (rehearsal) {
    assert.match(preview.content, /Marathon · Expedition practice/);
    assert.match(preview.content, /Friday, December 11, 2026.+6:30\sPM to 8:00\sPM/);
    assert.equal(draft.activity, 'Expedition practice');
    assert.equal(draft.startAt, '2026-12-12T02:30:00.000Z');
    assert.equal(draft.endAt, '2026-12-12T04:00:00.000Z');
    assert.equal(draft.timeZone, 'America/Los_Angeles');
    checkpoint('Private Expedition practice draft for Friday, December 11, 2026, 6:30–8:00 pm Pacific. Search stayed empty.');
  }

  const rejectedPublish = privateReply(await send(click(preview, 'Publish', GUEST)));
  assert.match(rejectedPublish.content, /session is unavailable|action is not available/);
  assert.equal(store.getSession(host, id).status, 'draft');
  const publishId = String(nextId);
  const published = publicReply(await send(click(preview, 'Publish')), 4);
  assert.match(published.content, /1\/3 players · open/);
  checkpoint('The guest was denied Publish. The host published a card without Bungie Names.');

  const cardId = '100000000000000300';
  const guestChoices = privateReply(await send({ ...click(published, 'Join', GUEST), message: { application_id: APP, channel_id: CHANNEL,
    flags: 4, id: cardId, interaction_metadata: { type: 3, id: publishId } } }));
  const guestJoin = privateReply(await send(click(guestChoices, 'Join & share Bungie Name', GUEST)));
  assert.match(guestJoin.content, /2\/3 players/);
  const discovery = privateReply(await send(command('find', {}, GUEST)));
  assert.ok(discovery.content.includes(`https://discord.com/channels/${GUILD}/${CHANNEL}/${cardId}`));
  assert.doesNotMatch(discovery.content, fictionalNames);
  const thirdChoices = privateReply(await send(click(published, 'Join', third)));
  const filled = privateReply(await send(click(thirdChoices, 'Join only', third)));
  assert.match(filled.content, /3\/3 players/);
  const fourthChoices = privateReply(await send(click(published, 'Join', fourth)));
  const full = privateReply(await send(click(fourthChoices, 'Join only', fourth)));
  assert.match(full.content, /full/);
  checkpoint('Join & share and Join only filled the remaining seats. A fourth player was refused.');

  const members = privateReply(await send(click(filled, 'Show group IDs', third)));
  assert.match(members.content, /HostSecret/);
  assert.match(members.content, /GuestSecret/);
  assert.doesNotMatch(members.content, /PrivateSecret/);
  assert.match(members.content, /ID not shared/);
  assert.equal(members.content.includes('ID not shared. Ask this player how they want to connect. — ID not shared'), false);
  const outsider = privateReply(await send(click(filled, 'Show group IDs', fourth)));
  assert.doesNotMatch(outsider.content, fictionalNames);
  assert.match(outsider.content, /Join this session/);
  checkpoint('Only confirmed players could see shared names privately. The Join only player’s saved name stayed private.');

  privateReply(await send(click(privateReply(await send(click(published, 'Show group IDs'))), 'Stop sharing')));
  const afterRevoke = privateReply(await send(click(filled, 'Show group IDs', third)));
  assert.equal(afterRevoke.content.includes('HostSecret'), false);
  assert.match(afterRevoke.content, /GuestSecret/);
  const reopened = publicReply(await send(click(published, 'Leave', GUEST)), 7);
  assert.match(reopened.content, /2\/3 players/);
  const afterLeave = privateReply(await send(click(reopened, 'Show group IDs', GUEST)));
  assert.match(afterLeave.content, /Join this session/);
  assert.doesNotMatch(afterLeave.content, fictionalNames);
  assert.doesNotMatch(privateReply(await send(click(reopened, 'Show group IDs'))).content, fictionalNames);
  checkpoint('Revocation hid the host’s name. Leaving removed the guest’s name and group-ID access, and freed a seat.');

  const confirmation = privateReply(await send(click(reopened, 'Host Cancel')));
  const cancelled = privateReply(await send(click(confirmation, 'Confirm cancellation')));
  assert.ok(cancelled.content.includes(cardId));
  const refreshed = publicReply(await send(click(reopened, 'Refresh')), 7);
  assert.match(refreshed.content, /cancelled/);
  assert.match(publicReply(await send(click(reopened, 'Join', third)), 7).content, /cancelled/);
  for (const late of [click(thirdChoices, 'Join only', third), click(reopened, 'Show group IDs', third)]) {
    const denied = privateReply(await send(late));
    assert.match(denied.content, /no longer open/);
    assert.doesNotMatch(denied.content, fictionalNames);
  }
  assert.match(privateReply(await send(command('find'))).content, /No open sessions/);
  checkpoint('Cancellation removed the session from search and closed joins and group-ID lookups.');
}
