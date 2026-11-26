import { isValidCapacity } from './capacity.ts';
import type { VoiceRoomRegistry } from './voice-room-registry.ts';
import { VoiceRoomError, type VoiceGateway, type VoicePresence } from './voice-rooms.ts';

type Payload = Record<string, unknown>;
type Channel = { id: string; type: number; parentId: string | null };
type GuildSnapshot = {
  epoch: number;
  channels: Map<string, Channel>;
  voiceByUser: Map<string, string>;
  revisions: Map<string, number>;
  deletedChannels: Set<string>;
};
type Address = { guildId: string; roomId: string };
type KnownPresence = Extract<VoicePresence, { state: 'known' }>;
export type DiscordVoiceRest = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: Payload) => Promise<unknown>;

const idIsValid = (value: unknown): value is string => typeof value === 'string' && /^\d{17,20}$/.test(value);
const asRecord = (value: unknown): Payload | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Payload : undefined;
const VOICE = 2;
const CATEGORY = 4;
const VIEW_AND_CONNECT = String((1n << 10n) | (1n << 20n));

function readChannel(input: unknown, guildId: string): Channel | undefined {
  const data = asRecord(input);
  if (!data || !idIsValid(data.id) || typeof data.type !== 'number' ||
      (data.guild_id !== undefined && data.guild_id !== guildId)) return undefined;
  return { id: data.id, type: data.type, parentId: idIsValid(data.parent_id) ? data.parent_id : null };
}

function isRoom(input: unknown, roomId: string, guildId: string, categoryId: string): boolean {
  const channel = readChannel(input, guildId);
  return asRecord(input)?.guild_id === guildId && channel?.id === roomId &&
    channel.type === VOICE && channel.parentId === categoryId;
}

/** Discord payload adapter. No socket, authentication, or live server wiring lives here. */
export class DiscordVoiceGateway implements VoiceGateway {
  private readonly rest: DiscordVoiceRest;
  private readonly registry: VoiceRoomRegistry;
  private readonly categories: ReadonlyMap<string, string>;
  private readonly snapshots = new Map<string, GuildSnapshot>();
  private epoch = 0;
  private connection = 0;
  private connected = false;
  private lastSequence: number | undefined;

  constructor(rest: DiscordVoiceRest, registry: VoiceRoomRegistry, categories: ReadonlyMap<string, string> = new Map()) {
    this.rest = rest;
    this.registry = registry;
    this.categories = new Map(categories);
    for (const [guildId, categoryId] of this.categories) {
      if (!idIsValid(guildId) || !idIsValid(categoryId)) throw new Error('Invalid Discord voice category scope.');
    }
  }

  connect(): number {
    this.snapshots.clear();
    this.lastSequence = undefined;
    this.connected = true;
    return ++this.connection;
  }

  disconnect(connection: number): void {
    if (connection !== this.connection) return;
    this.connected = false;
    this.snapshots.clear();
  }

  /** Feed all dispatches in sequence. A resumed stream alone cannot restore a cleared snapshot. */
  dispatch(connection: number, event: { t: string; s: number; d: unknown }): void {
    if (!this.connected || connection !== this.connection) return;
    const { t, s, d } = event;
    if (!Number.isSafeInteger(s)) { this.disconnect(connection); return; }
    if (this.lastSequence !== undefined) {
      if (s <= this.lastSequence) return;
      if (s !== this.lastSequence + 1) this.snapshots.clear();
    }
    this.lastSequence = s;
    if (t === 'READY' || t === 'RESUMED') { this.snapshots.clear(); return; }
    const data = asRecord(d);
    const guildId = t === 'GUILD_CREATE' || t === 'GUILD_DELETE' ? data?.id : data?.guild_id;
    if (!data || !idIsValid(guildId)) {
      if (['GUILD_CREATE', 'GUILD_DELETE', 'VOICE_STATE_UPDATE', 'CHANNEL_CREATE',
        'CHANNEL_UPDATE', 'CHANNEL_DELETE'].includes(t)) this.snapshots.clear();
      return;
    }
    if (!this.categories.has(guildId)) return;
    if (t === 'GUILD_CREATE') { this.loadSnapshot(guildId, data); return; }
    if (t === 'GUILD_DELETE') { this.snapshots.delete(guildId); return; }
    const snapshot = this.snapshots.get(guildId);
    if (!snapshot) return;
    if (t === 'VOICE_STATE_UPDATE') this.updateVoice(guildId, snapshot, data);
    if (t === 'CHANNEL_CREATE' || t === 'CHANNEL_UPDATE' || t === 'CHANNEL_DELETE') {
      const channel = readChannel(data, guildId);
      if (!channel || (t === 'CHANNEL_DELETE' && channel.id === this.categories.get(guildId))) {
        this.snapshots.delete(guildId);
        return;
      }
      if (t === 'CHANNEL_DELETE') {
        snapshot.channels.delete(channel.id);
        snapshot.deletedChannels.add(channel.id);
      } else {
        snapshot.channels.set(channel.id, channel);
        snapshot.deletedChannels.delete(channel.id);
      }
      this.touch(snapshot, channel.id);
    }
  }

  private loadSnapshot(guildId: string, data: Payload): void {
    this.snapshots.delete(guildId);
    if (data.unavailable === true || !Array.isArray(data.channels) || !Array.isArray(data.voice_states)) return;
    const channels = new Map<string, Channel>();
    const voiceByUser = new Map<string, string>();
    for (const entry of data.channels) {
      const channel = readChannel(entry, guildId);
      if (!channel || channels.has(channel.id)) return;
      channels.set(channel.id, channel);
    }
    for (const entry of data.voice_states) {
      const state = asRecord(entry);
      if (!idIsValid(state?.user_id) || !idIsValid(state.channel_id) || voiceByUser.has(state.user_id)) return;
      voiceByUser.set(state.user_id, state.channel_id);
    }
    this.snapshots.set(guildId, {
      epoch: ++this.epoch, channels, voiceByUser, revisions: new Map(), deletedChannels: new Set(),
    });
  }

  private updateVoice(guildId: string, snapshot: GuildSnapshot, data: Payload): void {
    const { user_id: userId, channel_id: next } = data;
    if (!idIsValid(userId) || (next !== null && !idIsValid(next))) {
      this.snapshots.delete(guildId);
      return;
    }
    const previous = snapshot.voiceByUser.get(userId) ?? null;
    if (next === previous) return;
    if (previous) this.touch(snapshot, previous);
    if (next) {
      snapshot.voiceByUser.set(userId, next);
      this.touch(snapshot, next);
    } else snapshot.voiceByUser.delete(userId);
  }

  private touch(snapshot: GuildSnapshot, channelId: string): void {
    snapshot.revisions.set(channelId, (snapshot.revisions.get(channelId) ?? 0) + 1);
  }

  hasTrustedCategory(guildId: string, categoryId: string): boolean {
    return this.categories.get(guildId) === categoryId &&
      this.snapshots.get(guildId)?.channels.get(categoryId)?.type === CATEGORY;
  }

  async createPrivateRoom({ provisionId, guildId, categoryId, capacity, allowedUserIds }:
    Parameters<VoiceGateway['createPrivateRoom']>[0]): Promise<string> {
    const userIds = [...new Set(allowedUserIds)];
    if (this.categories.get(guildId) !== categoryId || !isValidCapacity(capacity) ||
        !userIds.length || userIds.length > capacity || userIds.some(id => !idIsValid(id) || id === guildId)) {
      throw new Error('Invalid Discord voice room scope or roster.');
    }
    if (!this.hasTrustedCategory(guildId, categoryId)) throw new VoiceRoomError('Voice presence is unavailable. Try again after it reconnects.');
    const snapshot = this.snapshots.get(guildId);
    const saved = this.registry.discordCreation(provisionId, guildId, categoryId, capacity);
    if (saved?.roomId) return saved.roomId;
    if (saved) throw new Error('The previous Discord voice creation needs an ownership check.');
    const path = '/channels/' + categoryId;
    const parent = asRecord(await this.rest('GET', path));
    if (parent?.id !== categoryId || parent.guild_id !== guildId || parent.type !== CATEGORY) {
      throw new Error('The configured Discord voice category could not be verified.');
    }
    if (this.snapshots.get(guildId) !== snapshot || !this.hasTrustedCategory(guildId, categoryId)) {
      throw new VoiceRoomError('Voice presence changed during setup. Try again once it is available.');
    }
    if (!this.registry.claimDiscordCreation(provisionId, guildId, categoryId, capacity)) {
      throw new Error('Discord voice creation has already been claimed or does not match the registry.');
    }
    const room = asRecord(await this.rest('POST', '/guilds/' + guildId + '/channels', {
      name: 'squadwaddle-session', type: VOICE, parent_id: categoryId, user_limit: capacity,
      permission_overwrites: [
        { id: guildId, type: 0, deny: VIEW_AND_CONNECT, allow: '0' },
        ...userIds.map(id => ({ id, type: 1, allow: VIEW_AND_CONNECT, deny: '0' })),
      ],
    }));
    if (!idIsValid(room?.id) || !isRoom(room, room.id, guildId, categoryId)) {
      throw new Error('Discord voice creation returned an unexpected room.');
    }
    this.registry.confirmDiscordCreation(provisionId, room.id);
    return room.id;
  }

  presence({ guildId, roomId }: Address): VoicePresence {
    const snapshot = this.snapshots.get(guildId);
    const categoryId = this.categories.get(guildId);
    if (!snapshot || !categoryId || !this.registry.ownsDiscordRoom(guildId, categoryId, roomId)) {
      return { state: 'unknown' };
    }
    const channel = snapshot.channels.get(roomId);
    if (!channel) return { state: snapshot.deletedChannels.has(roomId) ? 'missing' : 'unknown' };
    if (channel.type !== VOICE || channel.parentId !== categoryId ||
        snapshot.channels.get(categoryId)?.type !== CATEGORY) return { state: 'unknown' };
    let occupants = 0;
    for (const current of snapshot.voiceByUser.values()) if (current === roomId) occupants++;
    return { state: 'known', epoch: snapshot.epoch, revision: snapshot.revisions.get(roomId) ?? 0, occupants };
  }

  async deleteIfEmpty(address: Address, expected: KnownPresence): Promise<boolean> {
    const { guildId, roomId } = address;
    const category = this.categories.get(guildId);
    const continuouslyEmpty = () => {
      const actual = this.presence(address);
      return actual.state === 'known' && actual.occupants === 0 && expected.occupants === 0 &&
        actual.epoch === expected.epoch && actual.revision === expected.revision;
    };
    if (!category || !continuouslyEmpty()) return false;
    const path = '/channels/' + roomId;
    const channel = await this.rest('GET', path);
    if (!isRoom(channel, roomId, guildId, category) || !continuouslyEmpty()) return false;
    // Discord has no conditional DELETE. Keep this disconnected from the live runtime pending that gate.
    return isRoom(await this.rest('DELETE', path), roomId, guildId, category);
  }
}
