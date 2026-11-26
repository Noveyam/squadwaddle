import { DiscordVoiceGateway, type DiscordVoiceRest } from './discord-voice-gateway.ts';
import type { Actor, SessionStoreContract } from './types.ts';
import type { VoiceRoomRegistry } from './voice-room-registry.ts';
import { VoiceRoomError, VoiceRooms } from './voice-rooms.ts';

export type VoicePilotScope = Pick<Actor, 'guildId' | 'channelId'> & { categoryId: string };
export type VoicePilotDependencies = { registry: VoiceRoomRegistry; rest: DiscordVoiceRest };

/** The enclosing process provides dispatches and chooses when to run cleanup. */
export class VoicePilot {
  readonly gateway: DiscordVoiceGateway;
  private readonly rooms: VoiceRooms;
  private readonly scopes: ReadonlyMap<string, VoicePilotScope>;

  constructor(store: Pick<SessionStoreContract, 'getSession'>, scopes: readonly VoicePilotScope[],
    allowedPairs: readonly Pick<Actor, 'guildId' | 'channelId'>[], dependencies: VoicePilotDependencies, now: () => number) {
    const byGuild = new Map(scopes.map(scope => [scope.guildId, { ...scope }]));
    if (byGuild.size !== scopes.length || scopes.some(scope => scope.categoryId === scope.channelId ||
        scope.categoryId === scope.guildId || !allowedPairs.some(pair =>
          pair.guildId === scope.guildId && pair.channelId === scope.channelId))) {
      throw new Error('Voice pilot scopes must use one allowed text channel and a separate voice category per guild.');
    }
    const categories = new Map(scopes.map(scope => [scope.guildId, scope.categoryId]));
    const textChannels = new Map(scopes.map(scope => [scope.guildId, scope.channelId]));
    this.scopes = byGuild;
    this.gateway = new DiscordVoiceGateway(dependencies.rest, dependencies.registry, categories);
    this.rooms = new VoiceRooms(store, this.gateway, dependencies.registry, categories, now, textChannels);
  }

  async roomFor(actor: Actor, sessionId: string): Promise<string> {
    const scope = this.scopes.get(actor.guildId);
    if (!scope || scope.channelId !== actor.channelId) throw new VoiceRoomError('Voice rooms are disabled in this channel.');
    if (!this.gateway.hasTrustedCategory(scope.guildId, scope.categoryId)) {
      throw new VoiceRoomError('Voice presence is unavailable. Try again after it reconnects.');
    }
    const roomId = await this.rooms.roomFor(actor, sessionId);
    if (this.gateway.presence({ guildId: actor.guildId, roomId }).state !== 'known') {
      throw new VoiceRoomError('The voice room is awaiting confirmation. Try again once voice presence is available.');
    }
    return roomId;
  }

  reapEmptyRooms(): Promise<void> {
    return this.rooms.reapEmptyRooms();
  }
}
