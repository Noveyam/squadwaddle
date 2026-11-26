import type { Actor, PublicSession, SessionStoreContract } from './types.ts';
import type { CreatedVoiceRoom, VoiceRoomLink, VoiceRoomRegistry } from './voice-room-registry.ts';

export const VOICE_EMPTY_GRACE_MS = 120_000;

export type VoicePresence =
  | { state: 'unknown' }
  | { state: 'missing' }
  | { state: 'known'; epoch: number; revision: number; occupants: number };
type KnownPresence = Extract<VoicePresence, { state: 'known' }>;
type RoomAddress = { guildId: string; roomId: string };

/** Local adapter contract. A reconnect changes the epoch and invalidates cached presence.
 * The revision changes on every occupancy change, even if the count later returns to zero.
 * Only report missing after a fresh authoritative check, never from an incomplete cache.
 * deleteIfEmpty must recheck the same continuous empty observation immediately before deletion.
 */
export interface VoiceGateway {
  /** Retrying a provisionId returns the same created room, even after a lost acknowledgement. */
  createPrivateRoom(request: { provisionId: string; guildId: string; categoryId: string; capacity: number;
    allowedUserIds: readonly string[] }): Promise<string>;
  presence(address: RoomAddress): VoicePresence;
  deleteIfEmpty(address: RoomAddress, expected: KnownPresence): Promise<boolean>;
}

/** Local lifecycle only. The live interaction server does not construct this service. */
export class VoiceRooms {
  private readonly creating = new Map<string, Promise<CreatedVoiceRoom>>();
  private readonly emptySince = new Map<string, { epoch: number; revision: number; time: number }>();
  private readonly deleting = new Set<string>();
  private readonly categories: ReadonlyMap<string, string>;
  private readonly sessions: Pick<SessionStoreContract, 'getSession'>;
  private readonly gateway: VoiceGateway;
  private readonly registry: VoiceRoomRegistry;
  private readonly now: () => number;

  constructor(
    sessions: Pick<SessionStoreContract, 'getSession'>,
    gateway: VoiceGateway,
    registry: VoiceRoomRegistry,
    categories: ReadonlyMap<string, string> = new Map(),
    now: () => number = Date.now,
  ) {
    this.sessions = sessions;
    this.gateway = gateway;
    this.registry = registry;
    this.categories = new Map(categories);
    this.now = now;
  }

  private authorizedSession(actor: Actor, sessionId: string): PublicSession {
    const session = this.sessions.getSession(actor, sessionId);
    if (session.guildId !== actor.guildId || session.channelId !== actor.channelId ||
        session.status !== 'open' || Date.parse(session.endAt) <= this.now() ||
        !session.members.some(member => member.userId === actor.userId)) {
      throw new Error('Only confirmed players in an open session can request its voice room.');
    }
    return session;
  }

  async roomFor(actor: Actor, sessionId: string): Promise<string> {
    const categoryId = this.categories.get(actor.guildId);
    if (!categoryId) throw new Error('Voice rooms are disabled in this server.');
    const session = this.authorizedSession(actor, sessionId);
    const request = { sessionId: session.id, guildId: session.guildId, categoryId, capacity: session.capacity };
    let link = this.registry.reserve(request);
    if (this.deleting.has(link.provisionId)) throw new Error('Voice room cleanup is in progress.');
    if (link.roomId !== null) {
      const room = { ...link, roomId: link.roomId };
      if (this.gateway.presence({ guildId: room.guildId, roomId: room.roomId }).state !== 'missing') {
        return room.roomId;
      }
      this.registry.forget(room);
      this.emptySince.delete(room.provisionId);
      link = this.registry.reserve(request);
      if (link.roomId !== null) return link.roomId;
    }
    const provisionId = link.provisionId;
    let pending = this.creating.get(provisionId);
    if (!pending) {
      pending = this.createRoom(session, link).finally(() => this.creating.delete(provisionId));
      this.creating.set(provisionId, pending);
    }
    const room = await pending;
    this.authorizedSession(actor, sessionId);
    return room.roomId;
  }

  private async createRoom(session: PublicSession, link: VoiceRoomLink): Promise<CreatedVoiceRoom> {
    const roomId = await this.gateway.createPrivateRoom({
      provisionId: link.provisionId,
      guildId: link.guildId,
      categoryId: link.categoryId,
      capacity: link.capacity,
      allowedUserIds: session.members.map(member => member.userId),
    });
    return this.registry.confirm(link, roomId);
  }

  /** Call periodically or after a presence change. Unknown presence never starts or continues the grace period. */
  async reapEmptyRooms(): Promise<void> {
    for (const room of this.registry.createdRooms()) {
      const key = room.provisionId;
      if (this.categories.get(room.guildId) !== room.categoryId || this.deleting.has(key)) continue;
      const address = { guildId: room.guildId, roomId: room.roomId };
      const seen = this.gateway.presence(address);
      if (seen.state === 'missing') {
        this.registry.forget(room);
        this.emptySince.delete(key);
        continue;
      }
      if (seen.state !== 'known' || seen.occupants !== 0) {
        this.emptySince.delete(key);
        continue;
      }
      const current = this.now();
      const empty = this.emptySince.get(key);
      if (!empty || empty.epoch !== seen.epoch || empty.revision !== seen.revision) {
        this.emptySince.set(key, { epoch: seen.epoch, revision: seen.revision, time: current });
        continue;
      }
      if (current - empty.time < VOICE_EMPTY_GRACE_MS) continue;
      this.deleting.add(key);
      try {
        if (await this.gateway.deleteIfEmpty(address, { ...seen })) this.registry.forget(room);
      } finally {
        this.deleting.delete(key);
        this.emptySince.delete(key);
      }
    }
  }
}
