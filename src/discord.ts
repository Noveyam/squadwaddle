import { checkActivityName, hasBungieName, parseScheduleText, parseWeekendText, SCHEDULE_TEXT_EXAMPLE, SCHEDULE_TEXT_LIMIT, ScheduleTextError } from './schedule-text.ts';
import { CAPACITY_HINT, MAX_CAPACITY, MIN_CAPACITY, isValidCapacity } from './capacity.ts';
import type { Actor, DraftPreview, DraftSchedule, PublicSession, SessionInput, SessionStoreContract } from './types.ts';
import type { VoicePilot, VoicePilotScope } from './voice-pilot.ts';
import { VoiceRoomError } from './voice-rooms.ts';

/** Official protocol references, checked 2026-11-25:
 * https://docs.discord.com/developers/interactions/receiving-and-responding
 * https://docs.discord.com/developers/components/reference
 * Legacy content + action-row buttons remain supported; no privileged message intent is used.
 */
export const EPHEMERAL = 64;
export const REPLAY_NOTICE = 'This request was already handled. Check the channel or use /session find to see the current session.';
const PUBLISH_DISABLED = 'Publishing is disabled for this test. You can edit or discard this draft.';
const SUPPRESS_EMBEDS = 4;
const SNOWFLAKE = /^\d{17,20}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const EDIT_FIELDS = { request: SCHEDULE_TEXT_LIMIT, activity: 120, platform: 180, capacity: 16 };
const TEXT_DRAFT_DEFAULTS = {
  activity: 'Group play',
  expectations: 'Relaxed run. Learning welcome. Finish at the scheduled end time.',
  platformNotes: '',
};

type RecordValue = Record<string, unknown>;
type Button = { type: 2; style: number; label: string; custom_id: string; disabled?: boolean };
type Row = { type: 1; components: Button[] };
export type MessageData = { content: string; flags?: number; allowed_mentions: { parse: never[] }; components?: Row[] };
type TextInput = { type: 4; custom_id: string; label: string; style: 1; max_length: number; required: boolean; value?: string };
type ModalData = { custom_id: string; title: string; components: Array<{ type: 1; components: [TextInput] }> };
export type InteractionResponse = { type: 1 } | { type: 4 | 7; data: MessageData } | { type: 9; data: ModalData };
export type PilotConfig = {
  applicationId: string;
  allowedPairs: ReadonlyArray<Pick<Actor, 'guildId' | 'channelId'>>;
  publishingEnabled?: boolean;
  voiceScopes?: readonly VoicePilotScope[];
};

class InputError extends Error {}
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('Invalid interaction.');
  return value as RecordValue;
}

/** Display only: removes controls, neutralizes mentions/angle markup, escapes Markdown. */
export function safeText(value: string, limit = 240): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .slice(0, limit).replace(/@/g, '@\u200b').replace(/</g, '‹').replace(/>/g, '›')
    .replace(/([\\`*_{}\[\]()~|#])/g, '\\$1');
}
function publicText(value: string, limit: number): string {
  return safeText(hasBungieName(value) ? 'Hidden to protect Bungie Names' : value, limit);
}

function message(content: string, components: Row[] = [], privateMessage = true): InteractionResponse {
  return { type: 4, data: { content, flags: SUPPRESS_EMBEDS | (privateMessage ? EPHEMERAL : 0),
    allowed_mentions: { parse: [] }, components } };
}
function button(action: string, id: string, label: string, style = 2, disabled = false): Button {
  return { type: 2, style, label, custom_id: `ns:${action}:${id}`, disabled };
}
function modal(customId: string, title: string, inputs: TextInput[]): InteractionResponse {
  return { type: 9, data: { custom_id: customId, title, components: inputs.map(input => ({ type: 1, components: [input] })) } };
}
function field(id: string, label: string, limit: number, value?: string, required = false): TextInput {
  return { type: 4, custom_id: id, label, style: 1, max_length: limit, required, ...(value ? { value } : {}) };
}
function modalInputs(data: RecordValue, limits: Record<string, number>): Map<string, string> {
  if (!Array.isArray(data.components)) throw new InputError('Submit the form again.');
  const inputs = new Map<string, string>();
  for (const component of data.components) {
    const row = record(component);
    if (row.type !== 1 || !Array.isArray(row.components) || row.components.length !== 1) throw new InputError('Invalid form field.');
    const input = record(row.components[0]);
    const id = input.custom_id;
    if (input.type !== 4 || typeof id !== 'string' || !Object.hasOwn(limits, id) || inputs.has(id) ||
        typeof input.value !== 'string' || input.value.length > limits[id]) throw new InputError('Invalid form field.');
    inputs.set(id, input.value);
  }
  return inputs;
}
function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new InputError('Choose a valid session.');
  return value;
}
function draftReference(value: unknown): { id: string; revision: number } {
  const match = typeof value === 'string' && /^([A-Za-z0-9_-]{1,64})(?::(0|[1-9]\d{0,15}))?$/.exec(value);
  if (!match) throw new InputError('Use the draft code from your private preview.');
  const revision = Number(match[2] ?? '0');
  if (!Number.isSafeInteger(revision)) throw new InputError('Use the draft code from your private preview.');
  return { id: match[1], revision };
}
function timestamp(iso: string): string {
  const seconds = Math.floor(Date.parse(iso) / 1000);
  if (!Number.isFinite(seconds)) throw new InputError('This session has an invalid time.');
  return `<t:${seconds}:f>`;
}
function dateWindow(saturday: string, sunday: string): string {
  const format = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeZone: 'UTC' });
  return `${format.format(Date.parse(saturday))} – ${format.format(Date.parse(sunday))}`;
}

function organizerWindow(session: PublicSession): string {
  const timeStyle = { timeStyle: 'short', timeZone: session.timeZone } as const;
  const localDate = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeZone: session.timeZone });
  const datedTime = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', ...timeStyle });
  const startMs = Date.parse(session.startAt);
  const endMs = Date.parse(session.endAt);
  const start = datedTime.format(startMs);
  const end = localDate.format(startMs) === localDate.format(endMs)
    ? new Intl.DateTimeFormat('en-US', timeStyle).format(endMs)
    : datedTime.format(endMs);
  return `${start} to ${end}`;
}

/** Explicit allowlist projection. Never serialize a store object into a Discord message. */
export function publicCard(session: PublicSession, voiceEnabled = false): MessageData {
  const id = sessionId(session.id);
  const open = session.status === 'open';
  const roster = session.members.filter(m => SNOWFLAKE.test(m.userId))
    .map(m => `<@${m.userId}>${m.isHost ? ' (host)' : ''}`).join(', ');
  return {
    content: [
      `**Marathon · ${publicText(session.activity, 120)}**`,
      `${timestamp(session.startAt)} → ${timestamp(session.endAt)}`,
      `Source zone: ${safeText(session.timeZone, 64)} · ${session.members.length}/${session.capacity} players · ${safeText(session.status, 12)}`,
      `Plan: ${publicText(session.expectations, 240)}`,
      session.platformNotes ? `Platform / cross-play: ${publicText(session.platformNotes, 180)}` : '',
      `Group: ${roster || 'No players'}`,
      `Session: ${id}`,
      'Bungie Names are optional and visible only to joined members who request them.',
      'Join only: I’ll arrange my in-game connection with the host.',
    ].filter(Boolean).join('\n'),
    flags: SUPPRESS_EMBEDS,
    allowed_mentions: { parse: [] },
    components: [{ type: 1, components: [
      button('choose-join', id, 'Join', 1, !open),
      button('ids', id, 'Show group IDs', 2, !open),
      button('leave', id, 'Leave', 2, !open),
      button('refresh', id, 'Refresh'),
      button('cancel-open', id, 'Host Cancel', 4, !open),
    ] }, ...(voiceEnabled && open ? [{ type: 1 as const, components: [button('voice-room', id, 'Join voice')] }] : [])],
  };
}

function privateCard(session: PublicSession, prefix = '', voiceEnabled = false): InteractionResponse {
  const data = publicCard(session, voiceEnabled);
  return { type: 4, data: { ...data, content: prefix + data.content, flags: SUPPRESS_EMBEDS | EPHEMERAL } };
}

function draftMessage(draft: DraftPreview, publishingEnabled: boolean, showOrganizerTime: boolean,
  defaultDuration = false): InteractionResponse {
  const { session, revision, shareName, availability } = draft;
  const code = `${session.id}:${revision}`;
  const time = new Intl.DateTimeFormat('en-US', { timeStyle: 'short', timeZone: 'UTC' });
  const schedule = availability ? [
    dateWindow(availability.saturday, availability.sunday),
    availability.preferredStartMinute === undefined || availability.preferredEndMinute === undefined
      ? 'Flexible hours'
      : `Preferred each day · ${time.format(availability.preferredStartMinute * 60_000)} to ${time.format(availability.preferredEndMinute * 60_000)}`,
    publishingEnabled ? 'Pick one day and exact times in Edit before publishing.' : 'Use Edit to pick one day and exact times.',
  ] : [
    `${timestamp(draft.session.startAt)} → ${timestamp(draft.session.endAt)}`,
    showOrganizerTime ? `Organizer’s time · ${organizerWindow(draft.session)}` : '',
    defaultDuration ? 'Default duration · 2 hours (edit to change)' : '',
  ];
  return message([
    publishingEnabled ? '**Private draft — review before publishing**' : '**Private draft**',
    publishingEnabled ? '' : PUBLISH_DISABLED,
    `**Marathon · ${safeText(session.activity, 120)}**`,
    ...schedule,
    `${safeText(session.timeZone, 64)} · ${session.members.length}/${session.capacity} players`,
    session.platformNotes ? `Platform · ${safeText(session.platformNotes, 180)}` : 'Platform · optional',
    `Your Bungie Name: ${shareName ? 'share with joined members' : 'keep private'}.`,
  ].filter(Boolean).join('\n'), [
    { type: 1, components: [button('publish', code, 'Publish', 1, !publishingEnabled || availability !== undefined), button('discard', code, 'Discard', 4),
      button('edit', code, 'Edit'), button('draft-page', '1', 'My drafts')] },
    { type: 1, components: [button('draft-share-on', code, 'Share my Bungie ID: Yes', 2, shareName),
      button('draft-share-off', code, 'Share my Bungie ID: No', 2, !shareName)] },
  ]);
}

function channelCardLink(session: PublicSession): string {
  if (!session.publicMessageId || ![session.guildId, session.channelId, session.publicMessageId].every(id => SNOWFLAKE.test(id))) return '';
  return `[Open channel card](https://discord.com/channels/${session.guildId}/${session.channelId}/${session.publicMessageId})`;
}

function draftList(actor: Actor, store: SessionStoreContract, page: number): InteractionResponse {
  const { drafts, hasMore } = store.listDrafts(actor, page);
  const navigation = [
    ...(page > 1 ? [button('draft-page', String(page - 1), 'Previous page')] : []),
    ...(hasMore ? [button('draft-page', String(page + 1), 'Next page')] : []),
  ];
  const rows: Row[] = [];
  if (drafts.length) rows.push({ type: 1, components: drafts.map((draft, index) =>
    button('open-draft', sessionId(draft.id), `Open ${index + 1}`)) });
  if (navigation.length) rows.push({ type: 1, components: navigation });
  if (!drafts.length) return message(page === 1 ? 'You have no unpublished drafts in this channel.' :
    'There are no drafts on this page.', rows);
  const lines = drafts.map((draft, index) => {
    const window = draft.startAt !== null && draft.endAt !== null
      ? `${timestamp(draft.startAt)} → ${timestamp(draft.endAt)}`
      : `${dateWindow(draft.saturday!, draft.sunday!)} · exact times pending`;
    return `${index + 1}. ${window} · ${safeText(draft.timeZone, 64)}`;
  });
  return message(`**Your unpublished drafts · Page ${page}**\n${lines.join('\n')}\nChoose an Open button to review a draft.`, rows);
}

function profileMessage(actor: Actor, store: SessionStoreContract): InteractionResponse {
  const profile = store.getProfile(actor);
  const controls = [button('profile-edit', 'me', 'Save Bungie ID')];
  if (profile.bungieName) controls.push(button('profile-clear', 'me', 'Clear Bungie ID', 4));
  return message(profile.bungieName ? `Your saved Bungie Name: ${safeText(profile.bungieName, 100)}` :
    'No Bungie Name saved. You can create or join without sharing one.', [{ type: 1, components: controls }]);
}

function hostSession(actor: Actor, store: SessionStoreContract, id: string): PublicSession {
  const session = store.getSession(actor, id);
  if (session.hostUserId !== actor.userId) throw new InputError('Only the host can cancel this session.');
  if (session.status === 'draft') throw new InputError('Use Discard in your private draft.');
  return session;
}

function cancelPrompt(session: PublicSession): InteractionResponse {
  if (session.status === 'cancelled') return privateCard(session);
  return message(`Cancel **${safeText(session.activity, 120)}**? This closes the session to new joins.`, [
    { type: 1, components: [button('confirm-cancel', session.id, 'Confirm cancellation', 4),
      button('view', session.id, 'Keep session')] },
  ]);
}

/** Discord includes the original interaction metadata on an interaction response message. */
function confirmSourceCard(payload: RecordValue, actor: Actor, id: string, store: SessionStoreContract): void {
  if (!payload.message || typeof payload.message !== 'object') return;
  const source = payload.message as RecordValue;
  if (source.channel_id !== actor.channelId || source.application_id !== payload.application_id ||
      typeof source.flags !== 'number' || (source.flags & EPHEMERAL) !== 0 ||
      typeof source.id !== 'string' || !SNOWFLAKE.test(source.id) ||
      !source.interaction_metadata || typeof source.interaction_metadata !== 'object') return;
  const origin = source.interaction_metadata as RecordValue;
  if (origin.type === 3 && typeof origin.id === 'string' && SNOWFLAKE.test(origin.id) &&
      origin.original_response_message_id === undefined) {
    store.confirmPublicCard(actor, id, origin.id, source.id);
  }
}

function options(data: RecordValue): { name: string; values: Map<string, unknown> } {
  if (data.name !== 'session' || !Array.isArray(data.options) || data.options.length !== 1) {
    throw new InputError('Use a /session command.');
  }
  const sub = record(data.options[0]);
  if (sub.type !== 1 || typeof sub.name !== 'string') throw new InputError('Choose a /session subcommand.');
  const values = new Map<string, unknown>();
  if (sub.options !== undefined && !Array.isArray(sub.options)) throw new InputError('Invalid command options.');
  for (const raw of (sub.options ?? []) as unknown[]) {
    const option = record(raw);
    if (typeof option.name !== 'string' || values.has(option.name)) throw new InputError('Invalid command options.');
    values.set(option.name, option.value);
  }
  return { name: sub.name, values };
}
function textOption(values: Map<string, unknown>, name: string, fallback?: string): string {
  const value = values.get(name) ?? fallback;
  if (typeof value !== 'string') throw new InputError(`Provide the ${name} option.`);
  return value;
}
function boolOption(values: Map<string, unknown>, name: string, fallback = false): boolean {
  const value = values.get(name) ?? fallback;
  if (typeof value !== 'boolean') throw new InputError(`The ${name} option must be yes or no.`);
  return value;
}

function draftChanges(values: Map<string, unknown>, referenceMs: number): Partial<DraftSchedule> {
  const fields = { activity: 'activity', start: 'startAt', end: 'endAt', timezone: 'timeZone' } as const;
  if (values.has('request')) {
    if (Object.keys(fields).some(name => values.has(name))) {
      throw new InputError('Use the request sentence or the individual edit fields.');
    }
    return parseScheduleText(textOption(values, 'request'), referenceMs);
  }
  const changes: Partial<DraftSchedule> = {};
  for (const [name, field] of Object.entries(fields)) {
    if (values.has(name)) changes[field] = textOption(values, name);
  }
  if (changes.activity !== undefined) checkActivityName(changes.activity);
  return changes;
}

function actorFrom(payload: RecordValue, config: PilotConfig): Actor {
  const { guild_id: guildId, channel_id: channelId } = payload;
  if (payload.application_id !== config.applicationId || (payload.context !== undefined && payload.context !== 0) ||
      typeof guildId !== 'string' || typeof channelId !== 'string' ||
      !config.allowedPairs.some(pair => pair.guildId === guildId && pair.channelId === channelId)) {
    throw new InputError('This prototype works only in approved pilot channels.');
  }
  const member = record(payload.member);
  const user = record(member.user);
  if (typeof user.id !== 'string' || !SNOWFLAKE.test(user.id) || user.bot === true) {
    throw new InputError('A server member is required.');
  }
  // Never derive the actor from options, custom IDs, top-level DM user, or message author.
  return { userId: user.id, guildId, channelId };
}

function errorMessage(error: unknown): string {
  if (error instanceof InputError || error instanceof ScheduleTextError) return error.message;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const messages: Record<string, string> = {
    FULL: 'That group is full. Use /session find for another session.',
    SESSION_FULL: 'That group is full. Use /session find for another session.',
    NOT_FOUND: 'That session is unavailable in this channel.',
    FORBIDDEN: 'This action is not available to you for that session.',
    NOT_MEMBER: 'Join this session before viewing its group IDs or changing sharing.',
    NOT_A_MEMBER: 'Join this session before viewing its group IDs or changing sharing.',
    HOST_CANNOT_LEAVE: 'As host, use /session cancel to close this group.',
    NO_PROFILE: 'Save your Bungie Name with /session profile before choosing to share it.',
    PROFILE_REQUIRED: 'Save your Bungie Name before choosing to share it.',
    CLOSED: 'That session is no longer open.',
    SESSION_CLOSED: 'That session is no longer open.',
    SESSION_NOT_OPEN: 'That session is no longer open.',
    SESSION_ENDED: 'That session has ended. Use /session find for another group.',
    ALREADY_PUBLISHED: 'This session was already published. Use /session find.',
    NOT_A_DRAFT: 'This session is no longer an unpublished draft.',
    STALE_DRAFT: 'This draft preview is out of date. Use the latest preview or open My drafts from /session help.',
    INVALID_DRAFT_PAGE: 'Choose a positive draft page number.',
    INVALID_CAPACITY: CAPACITY_HINT,
    EXACT_TIMES_REQUIRED: 'Choose a day and exact times in Edit before publishing this weekend draft.',
    WEEKEND_SLOT: 'Choose exact start and end times on one day of this weekend, in the selected time zone.',
    PUBLISH_REPLAY: REPLAY_NOTICE,
    INVALID_INPUT: 'Check your inputs. Use full ISO dates with a UTC offset and an IANA time zone.',
    VALIDATION_ERROR: 'Check your details. Bungie Names need # and four digits; session times need future ISO dates with offsets and an IANA time zone.',
  };
  // Never echo unknown errors: they could contain SQL, local paths, or private profile data.
  return messages[code] ?? 'That action could not be completed. Check the session, profile, and time settings, then try again.';
}

/** Only the signed HTTP handler dispatches asynchronous voice button requests. */
export async function handleVoiceRoomInteraction(payload: RecordValue, config: PilotConfig,
  voice: VoicePilot | undefined): Promise<InteractionResponse> {
  try {
    const actor = actorFrom(payload, config);
    if (!voice) return message('Voice rooms are disabled in this channel.');
    const { custom_id: customId } = record(payload.data);
    if (typeof customId !== 'string' || !customId.startsWith('ns:voice-room:')) throw new InputError('Invalid voice button.');
    const id = sessionId(customId.slice('ns:voice-room:'.length));
    const roomId = await voice.roomFor(actor, id);
    return message(`**Your session voice room**\n<https://discord.com/channels/${actor.guildId}/${roomId}>`);
  } catch (error) {
    return message(error instanceof VoiceRoomError ? error.message : errorMessage(error));
  }
}

/** Call only after verifying Discord's raw HTTP signature. Does no network I/O. */
export function handleInteraction(input: unknown, store: SessionStoreContract, config: PilotConfig,
  referenceMs = Date.now()): InteractionResponse {
  const publishingEnabled = config.publishingEnabled !== false;
  try {
    const payload = record(input);
    if (payload.type === 1) return { type: 1 };
    const actor = actorFrom(payload, config);
    const voiceEnabled = config.voiceScopes?.some(scope => scope.guildId === actor.guildId && scope.channelId === actor.channelId) ?? false;
    const data = record(payload.data);
    if (payload.type === 2) {
      const { name, values } = options(data);
      if (name === 'help') return message(`**SquadWaddle**\nUse /session create with one sentence.\n“${SCHEDULE_TEXT_EXAMPLE}”`, [
        { type: 1, components: [button('draft-page', '1', 'My drafts'), button('profile', 'me', 'My Bungie ID')] },
      ]);
      if (name === 'profile') {
        const clear = boolOption(values, 'clear');
        if (clear && values.has('bungie_name')) throw new InputError('Choose either a new Bungie Name or clear, not both.');
        if (clear) {
          store.clearProfile(actor);
          return message('Your saved Bungie Name was cleared. Previous copies or screenshots cannot be recalled.');
        }
        if (values.has('bungie_name')) {
          store.saveProfile(actor, textOption(values, 'bungie_name'));
          return message('Bungie Name saved privately. Sharing is optional and chosen separately for each session.');
        }
        return profileMessage(actor, store);
      }
      const fromText = name === 'create-text' || name === 'create' && values.has('request');
      if (name === 'create' || name === 'create-text') {
        const request = fromText ? textOption(values, 'request') : undefined;
        // Old command versions may be cached. The current sentence command always starts private.
        const share = name === 'create' && fromText ? false : boolOption(values, 'share');
        const weekend = request === undefined ? undefined : parseWeekendText(request, referenceMs);
        if (weekend) return draftMessage(store.createWeekendDraft(actor, { ...TEXT_DRAFT_DEFAULTS, ...weekend }, share), publishingEnabled, true);
        const parsed = request === undefined ? undefined : parseScheduleText(request, referenceMs);
        const input: SessionInput = parsed !== undefined ? {
          ...TEXT_DRAFT_DEFAULTS,
          ...parsed,
        } : {
          activity: textOption(values, 'activity'), startAt: textOption(values, 'start'), endAt: textOption(values, 'end'),
          timeZone: textOption(values, 'timezone'),
          expectations: textOption(values, 'expectations', 'Relaxed run; learning welcome.'),
          platformNotes: textOption(values, 'platform_notes', 'Check platform and cross-play settings together.'),
        };
        const session = store.createDraft(actor, input, share);
        return draftMessage({ session, revision: 0, shareName: share }, publishingEnabled, fromText, parsed?.defaultDuration);
      }
      if (name === 'edit-draft') {
        const { id, revision } = draftReference(values.get('draft'));
        const changes = draftChanges(values, referenceMs);
        const draft = Object.keys(changes).length
          ? store.editDraft(actor, id, revision, changes)
          : store.getDraft(actor, id);
        return draftMessage(draft, publishingEnabled, true);
      }
      if (name === 'drafts') {
        const page = values.get('page') ?? 1;
        if (typeof page !== 'number') throw new InputError('Choose a positive draft page number.');
        return draftList(actor, store, page);
      }
      if (name === 'find') {
        const sessions = store.listSessions(actor).filter(s => s.guildId === actor.guildId && s.channelId === actor.channelId && s.status === 'open');
        const selected = sessions.slice(0, 5);
        if (!selected.length) return message('No open sessions in this channel yet. Create one with /session create.');
        const lines = selected.map((s, index) => [
          `${index + 1}. **${publicText(s.activity, 75)}**`, timestamp(s.startAt), `${s.members.length}/${s.capacity} players`, channelCardLink(s),
        ].filter(Boolean).join(' · '));
        return message(`**Open sessions in this channel**\n${lines.join('\n')}\nOpen a session to join.${sessions.length > 5 ? '\nShowing the first five sessions.' : ''}`,
          [{ type: 1, components: selected.map((s, index) => button('view', sessionId(s.id), `Open ${index + 1}`)) }]);
      }
      const id = sessionId(values.get('session'));
      if (name === 'share') {
        if (!values.has('enabled')) throw new InputError('Choose enabled:true to share or enabled:false to revoke.');
        const enabled = boolOption(values, 'enabled');
        store.setSharing(actor, id, enabled);
        return message(enabled ? 'Your Bungie Name is shared with current members of this session.' :
          'Future group-ID lookups will no longer show your Bungie Name for this session. Previous copies cannot be recalled.');
      }
      if (name === 'cancel') {
        return cancelPrompt(hostSession(actor, store, id));
      }
      throw new InputError('Choose a supported /session command.');
    }
    if ((payload.type !== 5 && (payload.type !== 3 || data.component_type !== 2)) || typeof data.custom_id !== 'string') {
      throw new InputError('Unsupported interaction.');
    }
    const match = /^ns:([a-z-]+):(.+)$/.exec(data.custom_id);
    if (!match) throw new InputError('Invalid session button.');
    const [, action, reference] = match;
    if (payload.type === 5) {
      if (action === 'save-profile' && reference === 'me') {
        const fields = modalInputs(data, { bungie_name: 100 });
        store.saveProfile(actor, fields.get('bungie_name') ?? '');
        return message('Bungie Name saved privately. Choose separately whether to share it in a session.', [
          { type: 1, components: [button('draft-page', '1', 'My drafts')] },
        ]);
      }
      if (action !== 'save-draft') throw new InputError('Unsupported form.');
      const { id, revision } = draftReference(reference);
      const fields = modalInputs(data, EDIT_FIELDS);
      const request = fields.get('request')?.trim();
      const { defaultDuration, ...schedule } = request ? parseScheduleText(request, referenceMs) : { defaultDuration: undefined };
      const activity = fields.get('activity')?.trim();
      const platformNotes = fields.get('platform');
      const seats = fields.get('capacity')?.trim();
      const capacity = seats ? Number(seats) : undefined;
      if (seats && (!/^\d+$/.test(seats) || !isValidCapacity(capacity) ||
          ('capacity' in schedule && schedule.capacity !== undefined && schedule.capacity !== capacity))) {
        throw new InputError(CAPACITY_HINT);
      }
      if (activity) checkActivityName(activity);
      if (platformNotes) checkActivityName(platformNotes);
      return draftMessage(store.editDraft(actor, id, revision, {
        ...schedule,
        ...(capacity === undefined ? {} : { capacity }),
        ...(activity ? { activity } : {}),
        ...(platformNotes === undefined ? {} : { platformNotes }),
      }), publishingEnabled, true, defaultDuration);
    }
    if (action === 'draft-page') {
      if (!/^\d+$/.test(reference)) throw new InputError('Choose a positive draft page number.');
      return draftList(actor, store, Number(reference));
    }
    if (reference === 'me') {
      if (action === 'profile') return profileMessage(actor, store);
      if (action === 'profile-edit') return modal('ns:save-profile:me', 'Save Bungie ID', [
        field('bungie_name', 'Bungie Name including #1234', 100, store.getProfile(actor).bungieName ?? undefined, true),
      ]);
      if (action === 'profile-clear') {
        store.clearProfile(actor);
        return profileMessage(actor, store);
      }
    }
    if (action === 'edit' || action === 'draft-share-on' || action === 'draft-share-off') {
      const { id, revision } = draftReference(reference);
      if (action !== 'edit') return draftMessage(store.editDraft(actor, id, revision, { shareName: action === 'draft-share-on' }), publishingEnabled, true);
      const draft = store.getDraft(actor, id);
      if (draft.revision !== revision) throw new InputError('This draft preview is out of date. Open the latest from My drafts.');
      return modal(`ns:save-draft:${reference}`, 'Edit draft', [
        field('request', draft.availability ? 'Exact times on one weekend day' : 'New scheduling sentence (optional)', EDIT_FIELDS.request),
        field('activity', 'New activity (optional)', EDIT_FIELDS.activity),
        field('platform', 'Platform (leave blank to skip)', EDIT_FIELDS.platform, draft.session.platformNotes),
        field('capacity', `Total seats including you (${MIN_CAPACITY}–${MAX_CAPACITY})`, EDIT_FIELDS.capacity),
      ]);
    }
    if (action === 'publish') {
      if (!publishingEnabled) return message(PUBLISH_DISABLED);
      if (typeof payload.id !== 'string' || !SNOWFLAKE.test(payload.id)) throw new InputError('Invalid Publish interaction.');
      const { id, revision } = draftReference(reference);
      return { type: 4, data: publicCard(store.publish(actor, id, payload.id, revision), voiceEnabled) };
    }
    if (action === 'discard') {
      const { id, revision } = draftReference(reference);
      store.discardDraft(actor, id, revision);
      return message('Draft discarded. No session card was published.');
    }
    const id = sessionId(reference);
    if (action === 'open-draft') return draftMessage(store.getDraft(actor, id), publishingEnabled, true);
    if (action === 'view') return privateCard(store.getSession(actor, id), '', voiceEnabled);
    if (action === 'share-on' || action === 'share-off') {
      store.setSharing(actor, id, action === 'share-on');
      return message(action === 'share-on' ? 'Your Bungie Name is shared with current members of this session.' :
        'Future group-ID lookups will omit your Bungie Name.');
    }
    if (action === 'confirm-cancel') {
      hostSession(actor, store, id);
      const cancelled = store.cancel(actor, id);
      return message(['**Session cancelled.** New joins are closed. Press Refresh on the channel card to show the cancellation.',
        channelCardLink(cancelled)].filter(Boolean).join('\n'));
    }
    if (!['choose-join', 'cancel-open', 'ids', 'join', 'join-share', 'leave', 'refresh'].includes(action)) throw new InputError('Unsupported session button.');
    confirmSourceCard(payload, actor, id, store);
    const source = payload.message as RecordValue | undefined;
    const onPublicCard = typeof source?.flags === 'number' && (source.flags & EPHEMERAL) === 0;
    if (action === 'cancel-open') return cancelPrompt(hostSession(actor, store, id));
    if (action === 'choose-join') {
      const session = store.getSession(actor, id);
      if (session.status === 'cancelled') return onPublicCard ? { type: 7, data: publicCard(session) } : privateCard(session);
      if (session.status !== 'open') throw new InputError('This session is not open.');
      return message(`Join **${publicText(session.activity, 120)}**?`, [
        { type: 1, components: [button('join', id, 'Join only', 1), button('join-share', id, 'Join & share Bungie Name'),
          button('profile', 'me', 'My Bungie ID')] },
      ]);
    }
    if (action === 'ids') {
      const members = store.getSharedNames(actor, id);
      const lines = members.map(m => `${SNOWFLAKE.test(m.userId) ? `<@${m.userId}>` : 'Member'}: ${m.bungieName
        ? safeText(m.bungieName, 100)
        : 'ID not shared. Ask this player how they want to connect.'}`);
      return message(`**Group IDs — only you can see this reply**\n${lines.join('\n')}\nUse shared names in Marathon’s Runner Connections. Copies cannot be recalled.`, [
        { type: 1, components: [button('share-on', id, 'Share my Bungie ID'), button('share-off', id, 'Stop sharing'),
          button('profile', 'me', 'My Bungie ID')] },
      ]);
    }
    let session: PublicSession;
    if (action === 'join' || action === 'join-share') session = store.join(actor, id, action === 'join-share');
    else if (action === 'leave') session = store.leave(actor, id);
    else session = store.getSession(actor, id);
    // Type 7 changes an existing public card; private search cards receive a private reply.
    if (onPublicCard) {
      return { type: 7, data: publicCard(session, voiceEnabled) };
    }
    return privateCard(session, action.startsWith('join') ? '**You joined this session.**\n' : '', voiceEnabled);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && (error.code === 'PROFILE_REQUIRED' || error.code === 'NO_PROFILE')) {
      return message(errorMessage(error), [{ type: 1, components: [button('profile-edit', 'me', 'Save Bungie ID')] }]);
    }
    return message(errorMessage(error));
  }
}

const stringOption = (name: string, description: string, required = false, max_length = 200) =>
  ({ type: 3, name, description, required, max_length });
/** Guild-scoped POST registration; contexts/integration_types apply to global commands and are omitted. */
export const SESSION_COMMAND = {
  type: 1, name: 'session', description: 'Find a relaxed Marathon group with a clear start and end time',
  options: [
    { type: 1, name: 'create', description: 'Describe a Marathon session and preview it privately', options: [
      stringOption('request', SCHEDULE_TEXT_EXAMPLE, true, SCHEDULE_TEXT_LIMIT),
    ] },
    { type: 1, name: 'find', description: 'See real open sessions in this channel' },
    { type: 1, name: 'help', description: 'See a scheduling example and reopen your drafts' },
  ],
};
