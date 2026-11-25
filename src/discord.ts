import type { Actor, PublicSession, SessionInput, SessionStoreContract } from './types.ts';

/** Official protocol references, checked 2026-11-25:
 * https://docs.discord.com/developers/interactions/receiving-and-responding
 * https://docs.discord.com/developers/components/reference
 * Legacy content + action-row buttons remain supported; no privileged message intent is used.
 */
export const EPHEMERAL = 64;
const SUPPRESS_EMBEDS = 4;
const SNOWFLAKE = /^\d{17,20}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

type RecordValue = Record<string, unknown>;
type Button = { type: 2; style: number; label: string; custom_id: string; disabled?: boolean };
type Row = { type: 1; components: Button[] };
export type MessageData = { content: string; flags?: number; allowed_mentions: { parse: never[] }; components?: Row[] };
export type InteractionResponse = { type: 1 } | { type: 4 | 7; data: MessageData };
export type PilotConfig = { applicationId: string; guildId: string; channelId: string };

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

function message(content: string, components: Row[] = [], privateMessage = true): InteractionResponse {
  return { type: 4, data: { content, flags: SUPPRESS_EMBEDS | (privateMessage ? EPHEMERAL : 0),
    allowed_mentions: { parse: [] }, components } };
}
function button(action: string, id: string, label: string, style = 2, disabled = false): Button {
  return { type: 2, style, label, custom_id: `ns:${action}:${id}`, disabled };
}
function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new InputError('Choose a valid session.');
  return value;
}
function timestamp(iso: string): string {
  const seconds = Math.floor(Date.parse(iso) / 1000);
  if (!Number.isFinite(seconds)) throw new InputError('This session has an invalid time.');
  return `<t:${seconds}:f>`;
}

/** Explicit allowlist projection. Never serialize a store object into a Discord message. */
export function publicCard(session: PublicSession): MessageData {
  const id = sessionId(session.id);
  const open = session.status === 'open';
  const roster = session.members.filter(m => SNOWFLAKE.test(m.userId))
    .map(m => `<@${m.userId}>${m.isHost ? ' (host)' : ''}`).join(', ');
  return {
    content: [
      `**Marathon · ${safeText(session.activity, 120)}**`,
      `${timestamp(session.startAt)} → ${timestamp(session.endAt)}`,
      `Source zone: ${safeText(session.timeZone, 64)} · ${session.members.length}/3 players · ${safeText(session.status, 12)}`,
      `Plan: ${safeText(session.expectations, 240)}`,
      `Platform / cross-play: ${safeText(session.platformNotes, 180)}`,
      `Group: ${roster || 'No players'}`,
      `Session: ${id}`,
      'Bungie Names are optional and visible only to joined members who request them.',
      'Join only: I’ll arrange my in-game connection with the host.',
    ].join('\n'),
    flags: SUPPRESS_EMBEDS,
    allowed_mentions: { parse: [] },
    components: [{ type: 1, components: [
      button('join-share', id, 'Join & share Bungie Name', 1, !open),
      button('join', id, 'Join only', 2, !open),
      button('ids', id, 'Show group IDs', 2, !open),
      button('leave', id, 'Leave', 2, !open),
      button('refresh', id, 'Refresh'),
    ] }],
  };
}

function privateCard(session: PublicSession, prefix = ''): InteractionResponse {
  const data = publicCard(session);
  return { type: 4, data: { ...data, content: prefix + data.content, flags: SUPPRESS_EMBEDS | EPHEMERAL } };
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

function actorFrom(payload: RecordValue, config: PilotConfig): Actor {
  if (payload.application_id !== config.applicationId || payload.guild_id !== config.guildId ||
      payload.channel_id !== config.channelId || (payload.context !== undefined && payload.context !== 0)) {
    throw new InputError('This prototype works only in its configured pilot server and channel.');
  }
  const member = record(payload.member);
  const user = record(member.user);
  if (typeof user.id !== 'string' || !SNOWFLAKE.test(user.id) || user.bot === true) {
    throw new InputError('A server member is required.');
  }
  // Never derive the actor from options, custom IDs, top-level DM user, or message author.
  return { userId: user.id, guildId: config.guildId, channelId: config.channelId };
}

function errorMessage(error: unknown): string {
  if (error instanceof InputError) return error.message;
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
    PROFILE_REQUIRED: 'Save your Bungie Name with /session profile before choosing to share it.',
    CLOSED: 'That session is no longer open.',
    SESSION_CLOSED: 'That session is no longer open.',
    SESSION_NOT_OPEN: 'That session is no longer open.',
    SESSION_ENDED: 'That session has ended. Use /session find for another group.',
    ALREADY_PUBLISHED: 'This session was already published. Use /session find.',
    INVALID_INPUT: 'Check your inputs. Use full ISO dates with a UTC offset and an IANA time zone.',
    VALIDATION_ERROR: 'Check your details. Bungie Names need # and four digits; session times need future ISO dates with offsets and an IANA time zone.',
  };
  // Never echo unknown errors: they could contain SQL, local paths, or private profile data.
  return messages[code] ?? 'That action could not be completed. Check the session, profile, and time settings, then try again.';
}

/** Call only after verifying Discord's raw HTTP signature. Does no network I/O. */
export function handleInteraction(input: unknown, store: SessionStoreContract, config: PilotConfig): InteractionResponse {
  try {
    const payload = record(input);
    if (payload.type === 1) return { type: 1 };
    const actor = actorFrom(payload, config);
    const data = record(payload.data);
    if (payload.type === 2) {
      const { name, values } = options(data);
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
        const profile = store.getProfile(actor);
        return message(profile.bungieName ? `Your saved Bungie Name: ${safeText(profile.bungieName, 100)}\nUse clear:true to remove it.` :
          'No Bungie Name saved. You can join without sharing one, or use /session profile bungie_name:YourName#1234.');
      }
      if (name === 'create') {
        const input: SessionInput = {
          activity: textOption(values, 'activity'), startAt: textOption(values, 'start'), endAt: textOption(values, 'end'),
          timeZone: textOption(values, 'timezone'),
          expectations: textOption(values, 'expectations', 'Relaxed run; learning welcome.'),
          platformNotes: textOption(values, 'platform_notes', 'Check platform and cross-play settings together.'),
        };
        const share = boolOption(values, 'share');
        const draft = store.createDraft(actor, input, share);
        const data = publicCard(draft);
        return message(`**Private draft — review before publishing**\n${data.content}\nYour Bungie Name: ${share ? 'share with joined members' : 'keep private'}.\nPublish makes the session card visible in this channel.`, [
          { type: 1, components: [button('publish', draft.id, 'Publish', 1), button('discard', draft.id, 'Discard', 4)] },
        ]);
      }
      if (name === 'find') {
        const sessions = store.listSessions(actor).filter(s => s.guildId === actor.guildId && s.channelId === actor.channelId && s.status === 'open');
        const selected = sessions.slice(0, 5);
        if (!selected.length) return message('No open sessions in this channel yet. Create one with /session create.');
        const lines = selected.map((s, index) => `${index + 1}. **${safeText(s.activity, 75)}** · ${timestamp(s.startAt)} · ${s.members.length}/3 players`);
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
        store.cancel(actor, id);
        return message('Session cancelled. Existing cards can be refreshed; the app will reject new joins.');
      }
      throw new InputError('Choose a supported /session command.');
    }
    if (payload.type !== 3 || data.component_type !== 2 || typeof data.custom_id !== 'string') {
      throw new InputError('Unsupported interaction.');
    }
    const match = /^ns:([a-z-]+):([A-Za-z0-9_-]{1,64})$/.exec(data.custom_id);
    if (!match) throw new InputError('Invalid session button.');
    const [, action, id] = match;
    if (action === 'publish') {
      if (store.getSession(actor, id).status !== 'draft') throw new InputError('This draft was already published or discarded. Use /session find.');
      return { type: 4, data: publicCard(store.publish(actor, id)) };
    }
    if (action === 'discard') {
      const draft = store.getSession(actor, id);
      if (draft.status !== 'draft') throw new InputError('This is no longer a draft. Use /session cancel for an open session.');
      store.cancel(actor, id);
      return message('Draft discarded. No session card was published.');
    }
    if (action === 'ids') {
      const members = store.getSharedNames(actor, id);
      const lines = members.map(m => `${SNOWFLAKE.test(m.userId) ? `<@${m.userId}>` : 'Member'}: ${m.bungieName
        ? `${safeText(m.bungieName, 100)}${m.connectionNote ? ` — ${safeText(m.connectionNote, 120)}` : ''}`
        : 'ID not shared. Ask this player how they want to connect.'}`);
      return message(`**Group IDs — only you can see this reply**\n${lines.join('\n')}\nUse shared Names to add players in-game. Sharing can be revoked with /session share enabled:false; copies cannot be recalled.`);
    }
    if (action === 'view') return privateCard(store.getSession(actor, id));
    let session: PublicSession;
    if (action === 'join' || action === 'join-share') session = store.join(actor, id, action === 'join-share');
    else if (action === 'leave') session = store.leave(actor, id);
    else if (action === 'refresh') session = store.getSession(actor, id);
    else throw new InputError('Unsupported session button.');
    const sourceMessage = payload.message && typeof payload.message === 'object' ? payload.message as RecordValue : {};
    // Type 7 changes an existing public card; private search cards receive a private reply.
    if (typeof sourceMessage.flags === 'number' && (sourceMessage.flags & EPHEMERAL) === 0) {
      return { type: 7, data: publicCard(session) };
    }
    return privateCard(session, action.startsWith('join') ? '**You joined this session.**\n' : '');
  } catch (error) {
    return message(errorMessage(error));
  }
}

const stringOption = (name: string, description: string, required = false, max_length = 200) =>
  ({ type: 3, name, description, required, max_length });
const booleanOption = (name: string, description: string, required = false) => ({ type: 5, name, description, required });
/** Guild-scoped POST registration; contexts/integration_types apply to global commands and are omitted. */
export const SESSION_COMMAND = {
  type: 1, name: 'session', description: 'Find a relaxed Marathon group with a clear start and end time',
  options: [
    { type: 1, name: 'profile', description: 'Save, view, or clear your optional private Bungie Name', options: [
      stringOption('bungie_name', 'Your full Bungie Name, including #1234; unverified and optional', false, 100),
      booleanOption('clear', 'Clear your saved Bungie Name'),
    ] },
    { type: 1, name: 'create', description: 'Preview a three-player session privately before publishing', options: [
      stringOption('activity', 'What would you like to play?', true, 120),
      stringOption('start', 'ISO date with offset, for example 2026-12-05T12:00:00-08:00', true, 40),
      stringOption('end', 'ISO date with offset, for example 2026-12-05T14:00:00-08:00', true, 40),
      stringOption('timezone', 'IANA zone, for example America/Los_Angeles', true, 64),
      stringOption('expectations', 'Pace, learning preferences, or voice chat expectations', false, 240),
      stringOption('platform_notes', 'Platforms and cross-play settings to check', false, 180),
      booleanOption('share', 'Share your saved Bungie Name with joined members of this session only'),
    ] },
    { type: 1, name: 'find', description: 'See real open sessions in this channel' },
    { type: 1, name: 'share', description: 'Change your Bungie Name sharing for a joined session', options: [
      stringOption('session', 'Session ID shown on the card', true, 64),
      booleanOption('enabled', 'Share with current members (yes) or revoke future access (no)', true),
    ] },
    { type: 1, name: 'cancel', description: 'Cancel a session you host', options: [
      stringOption('session', 'Session ID shown on the card', true, 64),
    ] },
  ],
};
