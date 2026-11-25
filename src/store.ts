import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  Actor,
  GroupMember,
  PublicSession,
  SessionInput,
  SessionStoreContract,
} from "./types.ts";

/** A predictable application error; callers must not return raw database errors. */
export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

type SessionRow = {
  id: string;
  guild_id: string;
  channel_id: string;
  host_user_id: string;
  activity: string;
  start_at: string;
  end_at: string;
  start_ms: number;
  end_ms: number;
  time_zone: string;
  expectations: string;
  platform_notes: string;
  status: "draft" | "open" | "cancelled";
};

type MemberRow = {
  user_id: string;
  is_host: number;
  shared_name: string | null;
};

const CAPACITY = 3;

function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

function validateActor(actor: Actor): void {
  if (!actor || typeof actor !== "object") {
    fail("VALIDATION_ERROR", "A trusted Discord actor is required.");
  }
  for (const key of ["userId", "guildId", "channelId"] as const) {
    const value = actor[key];
    if (typeof value !== "string" || value.length < 1 || value.length > 128 || /\s/.test(value)) {
      fail("VALIDATION_ERROR", `A valid ${key} is required.`);
    }
  }
}

function textField(value: unknown, label: string, maxLength: number, required = false): string {
  if (typeof value !== "string") fail("VALIDATION_ERROR", `${label} must be text.`);
  const clean = value.trim();
  if ((required && clean.length === 0) || clean.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(clean)) {
    fail("VALIDATION_ERROR", `${label} must ${required ? "not be empty and must " : ""}contain at most ${maxLength} characters without control characters.`);
  }
  return clean;
}

function validateSharing(value: unknown): asserts value is boolean {
  if (typeof value !== "boolean") fail("VALIDATION_ERROR", "Sharing must be an explicit true or false choice.");
}

function validateBungieName(value: unknown): string {
  const name = textField(value, "Bungie Name", 100, true);
  if (!/^[^#\r\n\t]+#[0-9]{4}$/.test(name) || !name.slice(0, -5).trim()) {
    fail("VALIDATION_ERROR", "Use your complete Bungie Name, including # and four digits (for example, Player#1234).");
  }
  return name;
}

/** Date.parse alone silently normalizes some impossible dates, such as February 30. */
function parseInstant(value: unknown, label: string): { iso: string; milliseconds: number } {
  if (typeof value !== "string") fail("VALIDATION_ERROR", `${label} must be an ISO date and time.`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) {
    fail("VALIDATION_ERROR", `${label} must include its date and an explicit UTC offset or Z, for example 2026-12-05T19:00:00-08:00.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) {
    fail("VALIDATION_ERROR", `${label} contains an impossible calendar date or time.`);
  }
  const offset = match[8];
  if (offset !== "Z" && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) {
    fail("VALIDATION_ERROR", `${label} has an invalid UTC offset.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail("VALIDATION_ERROR", `${label} is not a supported date and time.`);
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

function validateTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.length > 100 || (value !== "UTC" && !/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)+$/.test(value))) {
    fail("VALIDATION_ERROR", "Use an IANA time zone such as America/Los_Angeles, or UTC; avoid PST/PDT abbreviations.");
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    fail("VALIDATION_ERROR", "That IANA time zone is not recognized.");
  }
}

/**
 * Synchronous, persistent session rules. The transport supplies Actor from a
 * verified interaction, never from command text or a caller-chosen user ID.
 * Profiles are per user; memberships and name snapshots are per session.
 */
export class SessionStore implements SessionStoreContract {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private closed = false;

  constructor(filename = ":memory:", now: () => Date = () => new Date()) {
    this.now = now;
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS profiles (
        user_id TEXT PRIMARY KEY,
        bungie_name TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        host_user_id TEXT NOT NULL,
        activity TEXT NOT NULL,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
        time_zone TEXT NOT NULL,
        expectations TEXT NOT NULL,
        platform_notes TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'cancelled'))
      );
      CREATE INDEX IF NOT EXISTS sessions_scope_time ON sessions (guild_id, channel_id, status, end_ms);
      CREATE TABLE IF NOT EXISTS members (
        join_order INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        is_host INTEGER NOT NULL CHECK (is_host IN (0, 1)),
        shared_name TEXT,
        UNIQUE (session_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS members_user ON members (user_id);
    `);
  }

  private ensureOpen(): void {
    if (this.closed) fail("STORE_CLOSED", "The session store is closed.");
  }

  private clock(): number {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      fail("VALIDATION_ERROR", "The application clock returned an invalid date.");
    }
    return value.getTime();
  }

  /** All roster changes acquire a SQLite write lock before checking capacity. */
  private transaction<T>(work: () => T): T {
    this.ensureOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  private session(actor: Actor, id: string, hideDraft = true): SessionRow {
    this.ensureOpen();
    validateActor(actor);
    if (typeof id !== "string" || id.length < 1 || id.length > 128) fail("NOT_FOUND", "Session not found in this channel.");
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ? AND guild_id = ? AND channel_id = ?")
      .get(id, actor.guildId, actor.channelId) as SessionRow | undefined;
    if (!row || (hideDraft && row.status === "draft" && row.host_user_id !== actor.userId)) {
      fail("NOT_FOUND", "Session not found in this channel.");
    }
    return row;
  }

  private member(id: string, userId: string): MemberRow | undefined {
    return this.db.prepare("SELECT user_id, is_host, shared_name FROM members WHERE session_id = ? AND user_id = ?")
      .get(id, userId) as MemberRow | undefined;
  }

  private requireMember(id: string, userId: string): MemberRow {
    const member = this.member(id, userId);
    if (!member) fail("NOT_A_MEMBER", "Only a current confirmed participant can use this action.");
    return member;
  }

  private requireOpenSession(row: SessionRow): void {
    if (row.status !== "open") fail("SESSION_NOT_OPEN", "This session is not open.");
    if (this.clock() >= row.end_ms) fail("SESSION_ENDED", "This session has ended.");
  }

  private sharedName(userId: string, shareName: boolean): string | null {
    if (!shareName) return null;
    const profile = this.db.prepare("SELECT bungie_name FROM profiles WHERE user_id = ?").get(userId) as { bungie_name: string } | undefined;
    if (!profile) fail("PROFILE_REQUIRED", "Save your Bungie Name before choosing to share it with this session.");
    return profile.bungie_name;
  }

  /** An explicit projection prevents private profile or snapshot fields leaking. */
  private publicSession(row: SessionRow): PublicSession {
    const members = this.db.prepare("SELECT user_id, is_host FROM members WHERE session_id = ? ORDER BY is_host DESC, join_order ASC")
      .all(row.id) as Array<{ user_id: string; is_host: number }>;
    return {
      id: row.id,
      game: "Marathon",
      guildId: row.guild_id,
      channelId: row.channel_id,
      hostUserId: row.host_user_id,
      activity: row.activity,
      startAt: row.start_at,
      endAt: row.end_at,
      timeZone: row.time_zone,
      expectations: row.expectations,
      platformNotes: row.platform_notes,
      capacity: CAPACITY,
      status: row.status,
      members: members.map(member => ({ userId: member.user_id, isHost: member.is_host === 1 })),
    };
  }

  saveProfile(actor: Actor, bungieName: string): void {
    validateActor(actor);
    const name = validateBungieName(bungieName);
    this.transaction(() => {
      this.db.prepare("INSERT INTO profiles (user_id, bungie_name) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET bungie_name = excluded.bungie_name")
        .run(actor.userId, name);
      // Deliberately do not update existing per-session consent snapshots.
    });
  }

  getProfile(actor: Actor): { bungieName: string | null } {
    this.ensureOpen();
    validateActor(actor);
    const row = this.db.prepare("SELECT bungie_name FROM profiles WHERE user_id = ?").get(actor.userId) as { bungie_name: string } | undefined;
    return { bungieName: row?.bungie_name ?? null };
  }

  clearProfile(actor: Actor): void {
    validateActor(actor);
    this.transaction(() => {
      this.db.prepare("DELETE FROM profiles WHERE user_id = ?").run(actor.userId);
      this.db.prepare("UPDATE members SET shared_name = NULL WHERE user_id = ?").run(actor.userId);
    });
  }

  createDraft(actor: Actor, input: SessionInput, shareName = false): PublicSession {
    validateActor(actor);
    validateSharing(shareName);
    if (!input || typeof input !== "object") fail("VALIDATION_ERROR", "Session details are required.");
    const activity = textField(input.activity, "Activity", 160, true);
    const expectations = textField(input.expectations, "Expectations", 1000);
    const platformNotes = textField(input.platformNotes, "Platform notes", 500);
    const start = parseInstant(input.startAt, "Start time");
    const end = parseInstant(input.endAt, "End time");
    const timeZone = validateTimeZone(input.timeZone);
    if (end.milliseconds <= start.milliseconds) fail("VALIDATION_ERROR", "End time must be after start time.");
    return this.transaction(() => {
      if (start.milliseconds <= this.clock()) fail("VALIDATION_ERROR", "Choose a start time in the future.");
      const snapshot = this.sharedName(actor.userId, shareName);
      const id = randomUUID();
      this.db.prepare(`INSERT INTO sessions
        (id, guild_id, channel_id, host_user_id, activity, start_at, end_at, start_ms, end_ms, time_zone, expectations, platform_notes, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`)
        .run(id, actor.guildId, actor.channelId, actor.userId, activity, start.iso, end.iso, start.milliseconds, end.milliseconds, timeZone, expectations, platformNotes);
      this.db.prepare("INSERT INTO members (session_id, user_id, is_host, shared_name) VALUES (?, ?, 1, ?)")
        .run(id, actor.userId, snapshot);
      return this.publicSession(this.session(actor, id));
    });
  }

  publish(actor: Actor, id: string): PublicSession {
    return this.transaction(() => {
      const row = this.session(actor, id, false);
      if (row.host_user_id !== actor.userId) fail("FORBIDDEN", "Only the host can publish this draft.");
      if (row.status === "open") fail("ALREADY_PUBLISHED", "This session is already published; do not post it again.");
      if (row.status !== "draft") fail("SESSION_NOT_OPEN", "A cancelled session cannot be published.");
      if (row.start_ms <= this.clock()) fail("VALIDATION_ERROR", "The planned start has passed. Create a draft with a future start time.");
      this.db.prepare("UPDATE sessions SET status = 'open' WHERE id = ?").run(id);
      return this.publicSession({ ...row, status: "open" });
    });
  }

  join(actor: Actor, id: string, shareName = false): PublicSession {
    validateSharing(shareName);
    return this.transaction(() => {
      const row = this.session(actor, id);
      this.requireOpenSession(row);
      // A retried button press must never grant or revoke name-sharing consent.
      if (this.member(id, actor.userId)) return this.publicSession(row);
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM members WHERE session_id = ?").get(id) as { count: number };
      if (count.count >= CAPACITY) fail("SESSION_FULL", "All three seats, including the host, are taken.");
      const snapshot = this.sharedName(actor.userId, shareName);
      this.db.prepare("INSERT INTO members (session_id, user_id, is_host, shared_name) VALUES (?, ?, 0, ?)")
        .run(id, actor.userId, snapshot);
      return this.publicSession(row);
    });
  }

  leave(actor: Actor, id: string): PublicSession {
    return this.transaction(() => {
      const row = this.session(actor, id);
      if (row.host_user_id === actor.userId) fail("HOST_CANNOT_LEAVE", "The host must cancel the session instead of leaving it.");
      this.requireMember(id, actor.userId);
      this.db.prepare("DELETE FROM members WHERE session_id = ? AND user_id = ?").run(id, actor.userId);
      return this.publicSession(row);
    });
  }

  setSharing(actor: Actor, id: string, shareName: boolean): PublicSession {
    validateSharing(shareName);
    return this.transaction(() => {
      const row = this.session(actor, id);
      this.requireMember(id, actor.userId);
      // Revocation remains possible after an end or cancellation.
      if (shareName) this.requireOpenSession(row);
      const snapshot = this.sharedName(actor.userId, shareName);
      this.db.prepare("UPDATE members SET shared_name = ? WHERE session_id = ? AND user_id = ?")
        .run(snapshot, id, actor.userId);
      return this.publicSession(row);
    });
  }

  cancel(actor: Actor, id: string): PublicSession {
    return this.transaction(() => {
      const row = this.session(actor, id, false);
      if (row.host_user_id !== actor.userId) fail("FORBIDDEN", "Only the host can cancel this session.");
      this.db.prepare("UPDATE sessions SET status = 'cancelled' WHERE id = ?").run(id);
      this.db.prepare("UPDATE members SET shared_name = NULL WHERE session_id = ?").run(id);
      return this.publicSession({ ...row, status: "cancelled" });
    });
  }

  getSession(actor: Actor, id: string): PublicSession {
    return this.publicSession(this.session(actor, id));
  }

  listSessions(actor: Actor): PublicSession[] {
    this.ensureOpen();
    validateActor(actor);
    const rows = this.db.prepare("SELECT * FROM sessions WHERE guild_id = ? AND channel_id = ? AND status = 'open' AND end_ms > ? ORDER BY start_ms ASC, id ASC")
      .all(actor.guildId, actor.channelId, this.clock()) as SessionRow[];
    return rows.map(row => this.publicSession(row));
  }

  getSharedNames(actor: Actor, id: string): GroupMember[] {
    // One transaction checks membership and reads snapshots consistently.
    return this.transaction(() => {
      const row = this.session(actor, id);
      this.requireOpenSession(row);
      this.requireMember(id, actor.userId);
      const members = this.db.prepare("SELECT user_id, is_host, shared_name FROM members WHERE session_id = ? ORDER BY is_host DESC, join_order ASC")
        .all(id) as MemberRow[];
      return members.map(member => ({
        userId: member.user_id,
        bungieName: member.shared_name,
        connectionNote: member.shared_name === null
          ? "ID not shared. Ask this player how they want to connect."
          : "Use the complete Bungie Name in Marathon's Runner Connections to send an invite.",
      }));
    });
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
