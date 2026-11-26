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
  /** Total seats including the host. Omission uses the default capacity. */
  capacity?: number;
};

export type PublicSession = {
  id: string;
  game: "Marathon";
  guildId: string;
  channelId: string;
  hostUserId: string;
  publicMessageId?: string;
  activity: string;
  startAt: string;
  endAt: string;
  timeZone: string;
  expectations: string;
  platformNotes: string;
  capacity: number;
  status: "draft" | "open" | "cancelled";
  members: Array<{ userId: string; isHost: boolean }>;
};

export type DraftSchedule = Pick<SessionInput, "activity" | "startAt" | "endAt" | "timeZone">;
export type DraftEdit = Partial<DraftSchedule> & { platformNotes?: string; shareName?: boolean; capacity?: number };
export type WeekendAvailability = {
  saturday: string;
  sunday: string;
  timeZone: string;
  preferredStartMinute?: number;
  preferredEndMinute?: number;
};
export type WeekendDraftInput = Pick<SessionInput, "activity" | "expectations" | "platformNotes" | "capacity"> & { availability: WeekendAvailability };
export type DraftPreview = { revision: number; shareName: boolean } & (
  { session: PublicSession; availability?: undefined } |
  { session: Omit<PublicSession, "startAt" | "endAt"> & { startAt?: undefined; endAt?: undefined }; availability: WeekendAvailability }
);
export type DraftListPage = {
  drafts: Array<Pick<PublicSession, "id" | "timeZone"> & {
    startAt: string | null; endAt: string | null; saturday: string | null; sunday: string | null;
  }>;
  hasMore: boolean;
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
  createWeekendDraft(actor: Actor, input: WeekendDraftInput, shareName?: boolean): DraftPreview;
  listDrafts(actor: Actor, page: number): DraftListPage;
  getDraft(actor: Actor, id: string): DraftPreview;
  editDraft(actor: Actor, id: string, expectedRevision: number, changes: DraftEdit): DraftPreview;
  /** Discord supplies the verified interaction ID. Only a new publication returns a card. */
  publish(actor: Actor, id: string, interactionId?: string, expectedRevision?: number): PublicSession;
  confirmPublicCard(actor: Actor, id: string, publishInteractionId: string, messageId: string): void;
  join(actor: Actor, id: string, shareName?: boolean): PublicSession;
  leave(actor: Actor, id: string): PublicSession;
  setSharing(actor: Actor, id: string, shareName: boolean): PublicSession;
  /** Discard supplies the preview revision to restrict cancellation to that draft. */
  cancel(actor: Actor, id: string, draftRevision?: number): PublicSession;
  discardDraft(actor: Actor, id: string, draftRevision: number): void;
  getSession(actor: Actor, id: string): PublicSession;
  listSessions(actor: Actor): PublicSession[];
  getSharedNames(actor: Actor, id: string): GroupMember[];
  close(): void;
};
