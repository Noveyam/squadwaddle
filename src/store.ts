import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CAPACITY_HINT, DEFAULT_CAPACITY, MAX_CAPACITY, MIN_CAPACITY, isValidCapacity } from "./capacity.ts";
import type {
  Actor,
  DraftEdit,
  DraftListPage,
  DraftPreview,
  DraftSchedule,
  GroupMember,
  PublicSession,
  SessionInput,
  SessionStoreContract,
  WeekendAvailability,
  WeekendDraftInput,
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
  capacity: number;
  status: "draft" | "open" | "cancelled";
  draft_revision: number;
  message_id: string | null;
};

type MemberRow = {
  user_id: string;
  is_host: number;
  shared_name: string | null;
};
type WeekendRow = Pick<SessionRow, 'id' | 'guild_id' | 'channel_id' | 'host_user_id' | 'activity' |
  'expectations' | 'time_zone' | 'platform_notes' | 'capacity' | 'draft_revision'> & {
  saturday: string; sunday: string;
  preferred_start: number | null; preferred_end: number | null;
  shared_name: string | null;
};

const CAPACITY_COLUMN = `capacity INTEGER NOT NULL DEFAULT ${DEFAULT_CAPACITY}
  CHECK (typeof(capacity) = 'integer' AND capacity BETWEEN ${MIN_CAPACITY} AND ${MAX_CAPACITY})`;
const DRAFTS_PER_PAGE = 5;
const SESSION_WITH_CARD = `SELECT sessions.*, public_cards.message_id FROM sessions
  LEFT JOIN public_cards ON public_cards.session_id = sessions.id`;

function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

function validateCapacity(value: unknown = DEFAULT_CAPACITY): number {
  if (!isValidCapacity(value)) fail("INVALID_CAPACITY", CAPACITY_HINT);
  return value;
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

function validateDraftSchedule(input: Partial<DraftSchedule>, saved?: SessionRow) {
  const activity = input.activity === undefined && saved ? saved.activity : textField(input.activity, "Activity", 160, true);
  const start = input.startAt === undefined && saved
    ? { iso: saved.start_at, milliseconds: saved.start_ms }
    : parseInstant(input.startAt, "Start time");
  const end = input.endAt === undefined && saved
    ? { iso: saved.end_at, milliseconds: saved.end_ms }
    : parseInstant(input.endAt, "End time");
  const timeZone = input.timeZone === undefined && saved ? saved.time_zone : validateTimeZone(input.timeZone);
  if (end.milliseconds <= start.milliseconds) fail("VALIDATION_ERROR", "End time must be after start time.");
  return { activity, start, end, timeZone };
}

function localDate(instant: number, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const { year, month, day } = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
  return `${year.padStart(4, "0")}-${month}-${day}`;
}

function validateWeekend(availability: WeekendAvailability, now: number): string {
  if (!availability || typeof availability !== "object") fail("VALIDATION_ERROR", "Choose weekend dates.");
  const { saturday, sunday, preferredStartMinute: start, preferredEndMinute: end } = availability;
  const timeZone = validateTimeZone(availability.timeZone);
  const first = parseInstant(`${saturday}T00:00:00Z`, "Saturday").milliseconds;
  const last = parseInstant(`${sunday}T00:00:00Z`, "Sunday").milliseconds;
  if (new Date(first).getUTCDay() !== 6 || last - first !== 86_400_000 || sunday < localDate(now, timeZone)) {
    fail("VALIDATION_ERROR", "Choose a Saturday and its following Sunday.");
  }
  if ((start !== undefined || end !== undefined) && (start === undefined || end === undefined ||
      !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= 1440 || start >= end)) {
    fail("VALIDATION_ERROR", "Choose valid preferred hours.");
  }
  return timeZone;
}

/**
 * Synchronous, persistent session rules. The transport supplies Actor from a
 * verified interaction, never from command text or a caller-chosen user ID.
 * Memberships and name snapshots are per session.
 */
export class SessionStore implements SessionStoreContract {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;
  private readonly guildScopedProfiles: boolean;
  private closed = false;

  constructor(filename = ":memory:", now: () => Date = () => new Date(), options: { guildScopedProfiles?: boolean } = {}) {
    this.now = now;
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
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
        status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'cancelled')),
        draft_revision INTEGER NOT NULL DEFAULT 0,
        ${CAPACITY_COLUMN}
      );
      CREATE INDEX IF NOT EXISTS sessions_scope_time ON sessions (guild_id, channel_id, status, end_ms);
      CREATE TABLE IF NOT EXISTS publish_receipts (
        interaction_id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS public_cards (
        session_id TEXT PRIMARY KEY NOT NULL REFERENCES publish_receipts(session_id) ON DELETE CASCADE,
        message_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS members (
        join_order INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        is_host INTEGER NOT NULL CHECK (is_host IN (0, 1)),
        shared_name TEXT,
        UNIQUE (session_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS members_user ON members (user_id);
      CREATE TABLE IF NOT EXISTS weekend_drafts (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        host_user_id TEXT NOT NULL,
        activity TEXT NOT NULL,
        time_zone TEXT NOT NULL,
        expectations TEXT NOT NULL,
        platform_notes TEXT NOT NULL,
        saturday TEXT NOT NULL,
        sunday TEXT NOT NULL,
        preferred_start INTEGER,
        preferred_end INTEGER,
        shared_name TEXT,
        draft_revision INTEGER NOT NULL DEFAULT 0,
        ${CAPACITY_COLUMN}
      );
      CREATE INDEX IF NOT EXISTS weekend_draft_scope ON weekend_drafts (guild_id, channel_id, host_user_id);
    `);
    this.guildScopedProfiles = this.transaction(() => {
      const columns = this.db.prepare("PRAGMA table_info(sessions)").all();
      if (!columns.some(column => column.name === "draft_revision")) {
        this.db.exec("ALTER TABLE sessions ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 0");
      }
      if (!columns.some(column => column.name === "capacity")) {
        this.db.exec(`ALTER TABLE sessions ADD COLUMN ${CAPACITY_COLUMN}`);
      }
      if (!this.db.prepare("PRAGMA table_info(weekend_drafts)").all().some(column => column.name === "capacity")) {
        this.db.exec(`ALTER TABLE weekend_drafts ADD COLUMN ${CAPACITY_COLUMN}`);
      }
      if (this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'guild_profiles'").get()) return true;
      if (options.guildScopedProfiles !== true) {
        this.db.exec("CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY, bungie_name TEXT NOT NULL)");
        return false;
      }
      // The legacy names have no guild provenance. Retire them and invalidate drafts whose displayed consent changed.
      this.db.exec(`
        CREATE TABLE guild_profiles (
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          bungie_name TEXT NOT NULL,
          PRIMARY KEY (guild_id, user_id)
        );
        UPDATE sessions SET draft_revision = draft_revision + 1 WHERE status = 'draft' AND id IN (
          SELECT session_id FROM members WHERE is_host = 1 AND shared_name IS NOT NULL
        );
        UPDATE members SET shared_name = NULL WHERE shared_name IS NOT NULL;
        UPDATE weekend_drafts SET shared_name = NULL, draft_revision = draft_revision + 1 WHERE shared_name IS NOT NULL;
        DROP TABLE IF EXISTS profiles;
      `);
      return true;
    });
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

  /** Acquire the SQLite write lock before checking state for a mutation. */
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
    const row = this.db.prepare(`${SESSION_WITH_CARD} WHERE id = ? AND guild_id = ? AND channel_id = ?`)
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

  private ownedDraft(actor: Actor, id: string): SessionRow {
    const row = this.session(actor, id);
    if (row.host_user_id !== actor.userId) fail("NOT_FOUND", "Draft not found in this channel.");
    if (row.status !== "draft") fail("NOT_A_DRAFT", "Only unpublished drafts can be edited.");
    return row;
  }

  private requireDraftRevision(row: Pick<SessionRow, "draft_revision">, expectedRevision: number): void {
    if (row.draft_revision !== expectedRevision) fail("STALE_DRAFT", "That draft preview is out of date.");
  }

  private draftPreview(row: SessionRow): DraftPreview {
    return {
      session: this.publicSession(row),
      revision: row.draft_revision,
      shareName: this.member(row.id, row.host_user_id)?.shared_name != null,
    };
  }

  private weekendDraft(actor: Actor, id: string): WeekendRow | undefined {
    this.ensureOpen();
    validateActor(actor);
    if (typeof id !== "string" || id.length < 1 || id.length > 128) return undefined;
    return this.db.prepare("SELECT * FROM weekend_drafts WHERE id = ? AND guild_id = ? AND channel_id = ? AND host_user_id = ?")
      .get(id, actor.guildId, actor.channelId, actor.userId) as WeekendRow | undefined;
  }

  private weekendPreview(row: WeekendRow): DraftPreview {
    return {
      session: {
        id: row.id, game: "Marathon", guildId: row.guild_id, channelId: row.channel_id, hostUserId: row.host_user_id,
        activity: row.activity, timeZone: row.time_zone, expectations: row.expectations, platformNotes: row.platform_notes,
        capacity: row.capacity, status: "draft", members: [{ userId: row.host_user_id, isHost: true }],
      },
      revision: row.draft_revision,
      shareName: row.shared_name !== null,
      availability: {
        saturday: row.saturday, sunday: row.sunday, timeZone: row.time_zone,
        ...(row.preferred_start === null || row.preferred_end === null ? {} : {
          preferredStartMinute: row.preferred_start, preferredEndMinute: row.preferred_end,
        }),
      },
    };
  }

  private sharedName(actor: Actor, shareName: boolean): string | null {
    if (!shareName) return null;
    const { bungieName } = this.getProfile(actor);
    if (bungieName === null) fail("PROFILE_REQUIRED", "Save your Bungie Name before choosing to share it with this session.");
    return bungieName;
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
      ...(row.message_id ? { publicMessageId: row.message_id } : {}),
      activity: row.activity,
      startAt: row.start_at,
      endAt: row.end_at,
      timeZone: row.time_zone,
      expectations: row.expectations,
      platformNotes: row.platform_notes,
      capacity: row.capacity,
      status: row.status,
      members: members.map(member => ({ userId: member.user_id, isHost: member.is_host === 1 })),
    };
  }

  saveProfile(actor: Actor, bungieName: string): void {
    validateActor(actor);
    const name = validateBungieName(bungieName);
    this.transaction(() => {
      if (this.guildScopedProfiles) {
        this.db.prepare(`INSERT INTO guild_profiles (guild_id, user_id, bungie_name) VALUES (?, ?, ?)
          ON CONFLICT(guild_id, user_id) DO UPDATE SET bungie_name = excluded.bungie_name`).run(actor.guildId, actor.userId, name);
      } else {
        this.db.prepare(`INSERT INTO profiles (user_id, bungie_name) VALUES (?, ?)
          ON CONFLICT(user_id) DO UPDATE SET bungie_name = excluded.bungie_name`).run(actor.userId, name);
      }
      // Deliberately do not update existing per-session consent snapshots.
    });
  }

  getProfile(actor: Actor): { bungieName: string | null } {
    this.ensureOpen();
    validateActor(actor);
    const row = (this.guildScopedProfiles
      ? this.db.prepare("SELECT bungie_name FROM guild_profiles WHERE guild_id = ? AND user_id = ?").get(actor.guildId, actor.userId)
      : this.db.prepare("SELECT bungie_name FROM profiles WHERE user_id = ?").get(actor.userId)) as { bungie_name: string } | undefined;
    return { bungieName: row?.bungie_name ?? null };
  }

  clearProfile(actor: Actor): void {
    validateActor(actor);
    this.transaction(() => {
      if (this.guildScopedProfiles) {
        this.db.prepare("DELETE FROM guild_profiles WHERE guild_id = ? AND user_id = ?").run(actor.guildId, actor.userId);
        this.db.prepare(`UPDATE sessions SET draft_revision = draft_revision + 1 WHERE guild_id = ? AND status = 'draft' AND id IN (
          SELECT session_id FROM members WHERE user_id = ? AND is_host = 1 AND shared_name IS NOT NULL
        )`).run(actor.guildId, actor.userId);
        this.db.prepare(`UPDATE members SET shared_name = NULL WHERE user_id = ? AND shared_name IS NOT NULL
          AND session_id IN (SELECT id FROM sessions WHERE guild_id = ?)`).run(actor.userId, actor.guildId);
        this.db.prepare(`UPDATE weekend_drafts SET shared_name = NULL, draft_revision = draft_revision + 1
          WHERE guild_id = ? AND host_user_id = ? AND shared_name IS NOT NULL`).run(actor.guildId, actor.userId);
        return;
      }
      this.db.prepare("DELETE FROM profiles WHERE user_id = ?").run(actor.userId);
      this.db.prepare("UPDATE members SET shared_name = NULL WHERE user_id = ?").run(actor.userId);
      this.db.prepare("UPDATE weekend_drafts SET shared_name = NULL WHERE host_user_id = ?").run(actor.userId);
    });
  }

  private insertTimedDraft(actor: Actor, id: string, schedule: ReturnType<typeof validateDraftSchedule>,
    expectations: string, platform: string, snapshot: string | null, revision: number, capacity: number): PublicSession {
    const { activity, start, end, timeZone } = schedule;
    this.db.prepare(`INSERT INTO sessions
      (id, guild_id, channel_id, host_user_id, activity, start_at, end_at, start_ms, end_ms, time_zone, expectations, platform_notes, status, draft_revision, capacity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`)
      .run(id, actor.guildId, actor.channelId, actor.userId, activity, start.iso, end.iso, start.milliseconds, end.milliseconds,
        timeZone, expectations, platform, revision, capacity);
    this.db.prepare("INSERT INTO members (session_id, user_id, is_host, shared_name) VALUES (?, ?, 1, ?)")
      .run(id, actor.userId, snapshot);
    return this.publicSession(this.session(actor, id));
  }

  createDraft(actor: Actor, input: SessionInput, shareName = false): PublicSession {
    validateActor(actor);
    validateSharing(shareName);
    if (!input || typeof input !== "object") fail("VALIDATION_ERROR", "Session details are required.");
    const schedule = validateDraftSchedule(input);
    const capacity = validateCapacity(input.capacity);
    const expectations = textField(input.expectations, "Expectations", 1000);
    const platformNotes = textField(input.platformNotes, "Platform notes", 500);
    return this.transaction(() => {
      if (schedule.start.milliseconds <= this.clock()) fail("VALIDATION_ERROR", "Choose a start time in the future.");
      return this.insertTimedDraft(actor, randomUUID(), schedule, expectations, platformNotes,
        this.sharedName(actor, shareName), 0, capacity);
    });
  }

  createWeekendDraft(actor: Actor, input: WeekendDraftInput, shareName = false): DraftPreview {
    validateActor(actor);
    validateSharing(shareName);
    const { availability } = input;
    const capacity = validateCapacity(input.capacity);
    const activity = textField(input.activity, "Activity", 160, true);
    const expectations = textField(input.expectations, "Expectations", 1000);
    const platform = textField(input.platformNotes, "Platform", 180);
    return this.transaction(() => {
      const zone = validateWeekend(availability, this.clock());
      const id = randomUUID();
      this.db.prepare(`INSERT INTO weekend_drafts
        (id, guild_id, channel_id, host_user_id, activity, time_zone, expectations, platform_notes,
          saturday, sunday, preferred_start, preferred_end, shared_name, capacity)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, actor.guildId, actor.channelId, actor.userId, activity, zone, expectations, platform,
          availability.saturday, availability.sunday, availability.preferredStartMinute ?? null,
          availability.preferredEndMinute ?? null, this.sharedName(actor, shareName), capacity);
      return this.weekendPreview(this.weekendDraft(actor, id)!);
    });
  }

  getDraft(actor: Actor, id: string): DraftPreview {
    const weekend = this.weekendDraft(actor, id);
    return weekend ? this.weekendPreview(weekend) : this.draftPreview(this.ownedDraft(actor, id));
  }

  listDrafts(actor: Actor, page: number): DraftListPage {
    this.ensureOpen();
    validateActor(actor);
    if (!Number.isSafeInteger(page) || page < 1 || page > Math.floor(Number.MAX_SAFE_INTEGER / DRAFTS_PER_PAGE)) {
      fail("INVALID_DRAFT_PAGE", "Choose a valid draft page number.");
    }
    const scope = [actor.guildId, actor.channelId, actor.userId] as const;
    const rows = this.db.prepare(`SELECT id, startAt, endAt, timeZone, saturday, sunday FROM (
      SELECT id, start_at AS startAt, end_at AS endAt, time_zone AS timeZone, NULL AS saturday, NULL AS sunday, start_ms AS sort_date
        FROM sessions WHERE guild_id = ? AND channel_id = ? AND host_user_id = ? AND status = 'draft'
      UNION ALL
      SELECT id, NULL, NULL, time_zone, saturday, sunday, CAST(strftime('%s', saturday) AS INTEGER) * 1000
        FROM weekend_drafts WHERE guild_id = ? AND channel_id = ? AND host_user_id = ?
      ) ORDER BY sort_date ASC, id ASC LIMIT ? OFFSET ?`)
      .all(...scope, ...scope, DRAFTS_PER_PAGE + 1, (page - 1) * DRAFTS_PER_PAGE) as DraftListPage["drafts"];
    return { drafts: rows.slice(0, DRAFTS_PER_PAGE), hasMore: rows.length > DRAFTS_PER_PAGE };
  }

  /** Runs inside editDraft's transaction. Conversion keeps the draft ID and sharing snapshot. */
  private editWeekend(actor: Actor, row: WeekendRow, changes: DraftEdit): DraftPreview {
    const activity = changes.activity === undefined ? row.activity : textField(changes.activity, "Activity", 160, true);
    const platform = changes.platformNotes === undefined ? row.platform_notes : textField(changes.platformNotes, "Platform", 180);
    const capacity = changes.capacity === undefined ? row.capacity : validateCapacity(changes.capacity);
    let snapshot = row.shared_name;
    if (changes.shareName !== undefined) {
      validateSharing(changes.shareName);
      snapshot = this.sharedName(actor, changes.shareName);
    }
    const timeZone = changes.timeZone === undefined ? row.time_zone : validateTimeZone(changes.timeZone);
    if (timeZone !== row.time_zone) fail("WEEKEND_SLOT", "Use the weekend's selected time zone.");
    if (changes.startAt !== undefined || changes.endAt !== undefined) {
      const schedule = validateDraftSchedule({ ...changes, activity, timeZone });
      const day = localDate(schedule.start.milliseconds, timeZone);
      if ((day !== row.saturday && day !== row.sunday) || day !== localDate(schedule.end.milliseconds, timeZone)) {
        fail("WEEKEND_SLOT", "Choose a single day within that weekend.");
      }
      if (schedule.start.milliseconds <= this.clock()) fail("VALIDATION_ERROR", "Choose a start time in the future.");
      const revision = row.draft_revision + 1;
      const session = this.insertTimedDraft(actor, row.id, schedule, row.expectations, platform, snapshot, revision, capacity);
      this.db.prepare("DELETE FROM weekend_drafts WHERE id = ?").run(row.id);
      return { session, revision, shareName: snapshot !== null };
    }
    this.db.prepare(`UPDATE weekend_drafts SET activity = ?, platform_notes = ?, shared_name = ?, capacity = ?,
      draft_revision = draft_revision + 1 WHERE id = ?`).run(activity, platform, snapshot, capacity, row.id);
    return this.weekendPreview(this.weekendDraft(actor, row.id)!);
  }

  editDraft(actor: Actor, id: string, expectedRevision: number, changes: DraftEdit): DraftPreview {
    return this.transaction(() => {
      const weekend = this.weekendDraft(actor, id);
      if (weekend) {
        this.requireDraftRevision(weekend, expectedRevision);
        return this.editWeekend(actor, weekend, changes);
      }
      const row = this.ownedDraft(actor, id);
      this.requireDraftRevision(row, expectedRevision);
      const { activity, start, end, timeZone } = validateDraftSchedule(changes, row);
      if (start.milliseconds <= this.clock()) fail("VALIDATION_ERROR", "Choose a start time in the future.");
      const platform = changes.platformNotes === undefined ? row.platform_notes : textField(changes.platformNotes, "Platform", 180);
      const capacity = changes.capacity === undefined ? row.capacity : validateCapacity(changes.capacity);
      if (changes.shareName !== undefined) {
        validateSharing(changes.shareName);
        const snapshot = this.sharedName(actor, changes.shareName);
        this.db.prepare("UPDATE members SET shared_name = ? WHERE session_id = ? AND user_id = ?")
          .run(snapshot, id, actor.userId);
      }
      this.db.prepare(`UPDATE sessions SET activity = ?, start_at = ?, end_at = ?, start_ms = ?, end_ms = ?,
        time_zone = ?, platform_notes = ?, capacity = ?, draft_revision = draft_revision + 1 WHERE id = ?`)
        .run(activity, start.iso, end.iso, start.milliseconds, end.milliseconds, timeZone, platform, capacity, id);
      return this.draftPreview(this.session(actor, id));
    });
  }

  publish(actor: Actor, id: string, interactionId?: string, expectedRevision = 0): PublicSession {
    return this.transaction(() => {
      const weekend = this.weekendDraft(actor, id);
      if (weekend) {
        this.requireDraftRevision(weekend, expectedRevision);
        fail("EXACT_TIMES_REQUIRED", "Choose exact times before publishing.");
      }
      // Preserve private draft visibility on the Discord button path.
      const row = this.session(actor, id, interactionId !== undefined);
      if (row.host_user_id !== actor.userId) fail("FORBIDDEN", "Only the host can publish this draft.");
      if (interactionId !== undefined) {
        if (typeof interactionId !== "string" || !/^\d{17,20}$/.test(interactionId)) {
          fail("VALIDATION_ERROR", "A valid Discord interaction ID is required.");
        }
        if (this.db.prepare("SELECT 1 FROM publish_receipts WHERE interaction_id = ?").get(interactionId)) {
          fail("PUBLISH_REPLAY", "This Publish request was already handled.");
        }
      }
      if (row.status === "open") fail("ALREADY_PUBLISHED", "This session is already published; do not post it again.");
      if (row.status !== "draft") fail("SESSION_NOT_OPEN", "A cancelled session cannot be published.");
      this.requireDraftRevision(row, expectedRevision);
      if (row.start_ms <= this.clock()) fail("VALIDATION_ERROR", "The planned start has passed. Create a draft with a future start time.");
      this.db.prepare("UPDATE sessions SET status = 'open' WHERE id = ?").run(id);
      if (interactionId !== undefined) {
        this.db.prepare("INSERT INTO publish_receipts (interaction_id, session_id) VALUES (?, ?)").run(interactionId, id);
      }
      return this.publicSession({ ...row, status: "open" });
    });
  }

  confirmPublicCard(actor: Actor, id: string, publishInteractionId: string, messageId: string): void {
    this.ensureOpen();
    validateActor(actor);
    if (!/^\d{17,20}$/.test(messageId) || !/^\d{17,20}$/.test(publishInteractionId)) return;
    // Only the original stored Publish receipt can identify this session's card.
    this.db.prepare(`INSERT INTO public_cards (session_id, message_id)
      SELECT s.id, ? FROM sessions s JOIN publish_receipts p ON p.session_id = s.id
      WHERE s.id = ? AND s.guild_id = ? AND s.channel_id = ? AND p.interaction_id = ?
      ON CONFLICT DO NOTHING`).run(messageId, id, actor.guildId, actor.channelId, publishInteractionId);
  }

  join(actor: Actor, id: string, shareName = false): PublicSession {
    validateSharing(shareName);
    return this.transaction(() => {
      const row = this.session(actor, id);
      this.requireOpenSession(row);
      // A retried button press must never grant or revoke name-sharing consent.
      if (this.member(id, actor.userId)) return this.publicSession(row);
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM members WHERE session_id = ?").get(id) as { count: number };
      if (count.count >= row.capacity) fail("SESSION_FULL", `All ${row.capacity} seats, including the host, are taken.`);
      const snapshot = this.sharedName(actor, shareName);
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
      const snapshot = this.sharedName(actor, shareName);
      this.db.prepare("UPDATE members SET shared_name = ? WHERE session_id = ? AND user_id = ?")
        .run(snapshot, id, actor.userId);
      return this.publicSession(row);
    });
  }

  private markCancelled(id: string): void {
    this.db.prepare("UPDATE sessions SET status = 'cancelled' WHERE id = ?").run(id);
    this.db.prepare("UPDATE members SET shared_name = NULL WHERE session_id = ?").run(id);
  }

  cancel(actor: Actor, id: string, draftRevision?: number): PublicSession {
    return this.transaction(() => {
      const row = draftRevision === undefined ? this.session(actor, id, false) : this.ownedDraft(actor, id);
      if (row.host_user_id !== actor.userId) fail("FORBIDDEN", "Only the host can cancel this session.");
      if (draftRevision !== undefined) this.requireDraftRevision(row, draftRevision);
      this.markCancelled(id);
      return this.publicSession({ ...row, status: "cancelled" });
    });
  }

  discardDraft(actor: Actor, id: string, draftRevision: number): void {
    this.transaction(() => {
      const weekend = this.weekendDraft(actor, id);
      const draft = weekend ?? this.ownedDraft(actor, id);
      this.requireDraftRevision(draft, draftRevision);
      if (weekend) {
        this.db.prepare("DELETE FROM weekend_drafts WHERE id = ?").run(id);
      } else {
        this.markCancelled(id);
      }
    });
  }

  getSession(actor: Actor, id: string): PublicSession {
    return this.publicSession(this.session(actor, id));
  }

  listSessions(actor: Actor): PublicSession[] {
    this.ensureOpen();
    validateActor(actor);
    const rows = this.db.prepare(`${SESSION_WITH_CARD} WHERE guild_id = ? AND channel_id = ? AND status = 'open' AND end_ms > ? ORDER BY start_ms ASC, id ASC`)
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
