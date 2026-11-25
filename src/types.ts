/** Supplied by a trusted transport. User input must never choose the acting identity. */
export type Actor = { userId: string; guildId: string; channelId: string };

export type SessionInput = {
  activity: string;
  /** ISO 8601 with explicit Z or numeric UTC offset. */
  startAt: string;
  endAt: string;
  /** An IANA zone, e.g. America/Los_Angeles; not a fixed PST abbreviation. */
  timeZone: string;
  expectations: string;
  platformNotes: string;
};

export type PublicSession = {
  id: string;
  game: "Marathon";
  guildId: string;
  channelId: string;
  hostUserId: string;
  activity: string;
  startAt: string;
  endAt: string;
  timeZone: string;
  expectations: string;
  platformNotes: string;
  capacity: 3;
  status: "draft" | "open" | "cancelled";
  members: Array<{ userId: string; isHost: boolean }>;
};

/** This object must only be returned privately to a current confirmed member. */
export type GroupMember = {
  userId: string;
  bungieName: string | null;
  connectionNote: string;
};

export type SessionStoreContract = {
  saveProfile(actor: Actor, bungieName: string): void;
  getProfile(actor: Actor): { bungieName: string | null };
  clearProfile(actor: Actor): void;
  createDraft(actor: Actor, input: SessionInput, shareName?: boolean): PublicSession;
  publish(actor: Actor, id: string): PublicSession;
  join(actor: Actor, id: string, shareName?: boolean): PublicSession;
  leave(actor: Actor, id: string): PublicSession;
  setSharing(actor: Actor, id: string, shareName: boolean): PublicSession;
  cancel(actor: Actor, id: string): PublicSession;
  getSession(actor: Actor, id: string): PublicSession;
  listSessions(actor: Actor): PublicSession[];
  getSharedNames(actor: Actor, id: string): GroupMember[];
  close(): void;
};
