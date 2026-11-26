import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MAX_CAPACITY, MIN_CAPACITY, isValidCapacity } from './capacity.ts';

type RoomRequest = { sessionId: string; guildId: string; categoryId: string; capacity: number };
export type VoiceRoomLink = RoomRequest & { provisionId: string; roomId: string | null };
export type CreatedVoiceRoom = VoiceRoomLink & { roomId: string };

const LINKS = `SELECT session_id AS sessionId, guild_id AS guildId, category_id AS categoryId,
  capacity, provision_id AS provisionId, room_id AS roomId FROM voice_room_links`;

/** Stores bot provisioning receipts only. Use a dedicated local file for mocked restart tests. */
export class VoiceRoomRegistry {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS voice_room_links (
        session_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        category_id TEXT NOT NULL,
        capacity INTEGER NOT NULL CHECK (typeof(capacity) = 'integer' AND capacity BETWEEN ${MIN_CAPACITY} AND ${MAX_CAPACITY}),
        provision_id TEXT NOT NULL UNIQUE,
        room_id TEXT UNIQUE
      );
    `);
  }

  reserve(request: RoomRequest): VoiceRoomLink {
    if (!isValidCapacity(request.capacity)) throw new Error('Cannot provision a room with invalid session capacity.');
    const { sessionId, guildId, categoryId, capacity } = request;
    this.db.prepare(`INSERT INTO voice_room_links (session_id, guild_id, category_id, capacity, provision_id)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING`)
      .run(sessionId, guildId, categoryId, capacity, randomUUID());
    const link = this.db.prepare(`${LINKS} WHERE session_id = ?`).get(sessionId) as VoiceRoomLink | undefined;
    if (!link || link.guildId !== guildId || link.categoryId !== categoryId || link.capacity !== capacity) {
      throw new Error('The saved voice room link does not match this session and category.');
    }
    return link;
  }

  confirm(link: VoiceRoomLink, roomId: string): CreatedVoiceRoom {
    if (typeof roomId !== 'string' || !roomId) throw new Error('The voice adapter did not return a room ID.');
    const result = this.db.prepare(`UPDATE voice_room_links SET room_id = ?
      WHERE session_id = ? AND provision_id = ? AND (room_id IS NULL OR room_id = ?)`)
      .run(roomId, link.sessionId, link.provisionId, roomId);
    if (result.changes !== 1) throw new Error('The voice provisioning receipt no longer matches.');
    return { ...link, roomId };
  }

  createdRooms(): CreatedVoiceRoom[] {
    return this.db.prepare(`${LINKS} WHERE room_id IS NOT NULL`).all() as CreatedVoiceRoom[];
  }

  forget(link: CreatedVoiceRoom): void {
    this.db.prepare('DELETE FROM voice_room_links WHERE session_id = ? AND provision_id = ? AND room_id = ?')
      .run(link.sessionId, link.provisionId, link.roomId);
  }

  close(): void {
    this.db.close();
  }
}
