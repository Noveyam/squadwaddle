import type { DraftSchedule, WeekendAvailability } from './types.ts';
import { CAPACITY_HINT, isValidCapacity } from './capacity.ts';

export const SCHEDULE_TEXT_LIMIT = 160;
export const SCHEDULE_TEXT_EXAMPLE = 'Two more for Marathon on Friday from noon to 1:00 pm UTC for Expedition.';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
// Recognize incomplete requests so each missing detail can get its own hint.
const CLOCK = '(noon|(?:0?[1-9]|1[0-2])(?::[0-5]\\d)?(?: ?[ap]m)?)';
const WINDOW = `(?:(?:from|at) )?${CLOCK}(?:( to| ?[–—-])(?: ?${CLOCK})?)?`;
const INTRO = /^(?:(?:i need|need) )?(?:(.+?) for |for )?marathon (?:on )?/i;
const NUMBER_WORDS = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split(' ');
const SIZE_NUMBER = `(?:[+-]?\\d+(?:\\.\\d+)?|${NUMBER_WORDS.join('|')}|dozen)`;
const SIZE_KIND = '(?:more(?: players?)?|(?:players?|people|seats)(?: total)?)';
const SIZE_AT_END = new RegExp(`(?:, ?| with | for )(${SIZE_NUMBER} ${SIZE_KIND})$`, 'i');
const SIZE_IN_BODY = new RegExp(`\\b(?:${SIZE_NUMBER} ${SIZE_KIND}|group of ${SIZE_NUMBER})\\b`, 'i');
const ZONE = '(pacific|america/los_angeles|utc)';
const PATTERN = new RegExp(
  `^(${WEEKDAYS.join('|')}|\\d{4}-\\d{2}-\\d{2}) ${WINDOW}(?: (?:in )?${ZONE})?(?: for (.+))?$`,
  'i',
);
const WEEKEND = new RegExp(`^all weekend(?: ${WINDOW})?,?(?: (?:in )?${ZONE})?(?: for (.+))?$`, 'i');
const MINUTE_MS = 60_000;
const DEFAULT_DURATION_MS = 120 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;

export class ScheduleTextError extends Error {}

export function hasBungieName(value: string): boolean {
  return /#\d{4}\b/.test(value);
}

export function checkActivityName(activity: string): void {
  if (hasBungieName(activity)) {
    throw new ScheduleTextError('Use an activity name without Bungie Names. Use the separate share option to share your saved name.');
  }
}

function minutesSinceMidnight(clock: string, label: 'start' | 'end'): number {
  if (clock === 'noon') return 12 * 60;
  if (!clock.endsWith('am') && !clock.endsWith('pm')) {
    throw new ScheduleTextError(`Add AM or PM to the ${label} time.`);
  }
  const [hour, minute = 0] = clock.slice(0, -2).trim().split(':').map(Number);
  return (hour % 12 + (clock.endsWith('pm') ? 12 : 0)) * 60 + minute;
}

/** Encode the local wall clock as UTC solely for calendar arithmetic and comparison. */
function wallTime(formatter: Intl.DateTimeFormat, instant: number): number {
  const { year, month, day, hour, minute } = Object.fromEntries(
    formatter.formatToParts(instant).map(({ type, value }) => [type, value]),
  );
  return Date.parse(`${year.padStart(4, '0')}-${month}-${day}T${hour}:${minute}:00Z`);
}

function scheduledDate(day: string, today: number): number {
  const weekday = WEEKDAYS.indexOf(day);
  if (weekday !== -1) {
    const daysAhead = (weekday - new Date(today).getUTCDay() + 7) % 7;
    return today + daysAhead * DAY_MS;
  }
  const date = new Date(`${day}T00:00:00Z`);
  // Check the original day because Date can roll impossible dates into the next month.
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) {
    throw new ScheduleTextError('Choose a valid calendar date in YYYY-MM-DD format.');
  }
  return date.getTime();
}

function resolveTime(target: number, offsets: Set<number>, formatter: Intl.DateTimeFormat, label: string): number {
  const matches = [...offsets].map(offset => target - offset)
    .filter(instant => wallTime(formatter, instant) === target);
  if (matches.length === 0) throw new ScheduleTextError(`The ${label} does not exist in that zone on that date. Choose another time.`);
  if (matches.length > 1) throw new ScheduleTextError(`The ${label} occurs twice in that zone on that date. Choose another time.`);
  return matches[0];
}

function normalizedSentence(sentence: string): string {
  if (sentence.length > SCHEDULE_TEXT_LIMIT) {
    throw new ScheduleTextError(`Keep the scheduling sentence within ${SCHEDULE_TEXT_LIMIT} characters.`);
  }
  return sentence.trim().replace(/\.$/, '').trimEnd().replace(/[ \t]+/g, ' ');
}

function scheduleRequest(sentence: string): { body?: string; capacity?: number } {
  const normalized = normalizedSentence(sentence);
  const intro = INTRO.exec(normalized);
  if (!intro) return {};
  const rest = normalized.slice(intro[0].length);
  const suffix = SIZE_AT_END.exec(rest);
  const body = suffix ? rest.slice(0, suffix.index) : rest;
  if ((intro[1] && suffix) || SIZE_IN_BODY.test(body)) throw new ScheduleTextError(CAPACITY_HINT);
  const size = intro[1] ?? suffix?.[1];
  if (size === undefined) return { body };

  const parts = /^(\S+) (more(?: players?)?|(?:players|people|seats) total)$/i.exec(size);
  if (!parts) throw new ScheduleTextError(CAPACITY_HINT);
  const [, count, kind] = parts;
  const amount = /^\d+$/.test(count) ? Number(count) : NUMBER_WORDS.indexOf(count.toLowerCase());
  const capacity = kind.toLowerCase().startsWith('more') ? amount + 1 : amount;
  if (!isValidCapacity(capacity)) throw new ScheduleTextError(CAPACITY_HINT);
  return { body, capacity };
}

function selectedZone(zone?: string): string {
  if (!zone) throw new ScheduleTextError('Add a time zone. Use Pacific, America/Los_Angeles, or UTC.');
  return zone.toLowerCase() === 'utc' ? 'UTC' : 'America/Los_Angeles';
}

function calendarToday(timeZone: string, referenceMs: number): { formatter: Intl.DateTimeFormat; today: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  return { formatter, today: new Date(wallTime(formatter, referenceMs)).setUTCHours(0, 0, 0, 0) };
}

export function parseWeekendText(sentence: string, referenceMs: number):
  { availability: WeekendAvailability; activity?: string; capacity?: number } | undefined {
  const { body, capacity } = scheduleRequest(sentence);
  const match = body !== undefined && WEEKEND.exec(body);
  if (!match) return undefined;
  const [, start, , end, zone, activity] = match;
  const timeZone = selectedZone(zone);
  if (activity !== undefined) checkActivityName(activity);
  const { today } = calendarToday(timeZone, referenceMs);
  const saturdayMs = scheduledDate('saturday', today);
  const availability: WeekendAvailability = {
    saturday: new Date(saturdayMs).toISOString().slice(0, 10),
    sunday: new Date(saturdayMs + DAY_MS).toISOString().slice(0, 10),
    timeZone,
  };
  if (start) {
    if (!end) throw new ScheduleTextError('Include an end time for your preferred hours, or leave the hours out for flexibility.');
    availability.preferredStartMinute = minutesSinceMidnight(start.toLowerCase(), 'start');
    availability.preferredEndMinute = minutesSinceMidnight(end.toLowerCase(), 'end');
    if (availability.preferredEndMinute <= availability.preferredStartMinute) {
      throw new ScheduleTextError('Choose preferred hours that end later on the same day.');
    }
  }
  return { availability, ...(activity === undefined ? {} : { activity }), ...(capacity === undefined ? {} : { capacity }) };
}

export function parseScheduleText(sentence: string, referenceMs: number):
  Omit<DraftSchedule, 'activity'> & { activity?: string; capacity?: number; defaultDuration?: true } {
  const { body, capacity } = scheduleRequest(sentence);
  if (body !== undefined && WEEKEND.test(body)) throw new ScheduleTextError('Pick one day and a start time for this edit.');
  const match = body !== undefined && PATTERN.exec(body);
  if (!match) {
    throw new ScheduleTextError(`Try “${SCHEDULE_TEXT_EXAMPLE}” Use a full weekday or YYYY-MM-DD, noon or h:mm am/pm for the start and any end time, and Pacific, America/Los_Angeles, or UTC. The final “for …” activity is optional. For other formats, use /session create.`);
  }

  const [, day, start, separator, end, zone, activity] = match;
  if (separator && !end) throw new ScheduleTextError('Include an end time after the start, such as “to 1:30 pm”.');
  const startMinute = minutesSinceMidnight(start.toLowerCase(), 'start');
  const endMinute = end === undefined ? undefined : minutesSinceMidnight(end.toLowerCase(), 'end');
  if (!zone) throw new ScheduleTextError('Add a time zone after the ' + (end === undefined ? 'start' : 'end') + ' time. Use Pacific, America/Los_Angeles, or UTC.');
  if (activity !== undefined) checkActivityName(activity);
  const timeZone = selectedZone(zone);
  if (endMinute !== undefined && endMinute <= startMinute) throw new ScheduleTextError('Choose an end after the start on the same day.');

  const { formatter, today } = calendarToday(timeZone, referenceMs);
  const midnight = scheduledDate(day.toLowerCase(), today);
  if (midnight < today) throw new ScheduleTextError('That date has passed in the selected time zone. Choose today or a future date.');

  // For the supported zones (Pacific and UTC), the adjacent days capture both
  // offsets on a clock-change day. Round trips detect skipped and repeated times.
  const offsets = new Set([midnight - DAY_MS, midnight + DAY_MS]
    .map(instant => wallTime(formatter, instant) - instant));
  const startMs = resolveTime(midnight + startMinute * MINUTE_MS, offsets, formatter, 'start time');
  const endMs = endMinute === undefined ? startMs + DEFAULT_DURATION_MS
    : resolveTime(midnight + endMinute * MINUTE_MS, offsets, formatter, 'end time');
  if (startMs <= referenceMs) {
    throw new ScheduleTextError('That start time has passed. Choose a later time or enter a future date as YYYY-MM-DD.');
  }

  return {
    ...(activity === undefined ? {} : { activity }),
    ...(capacity === undefined ? {} : { capacity }),
    ...(endMinute === undefined ? { defaultDuration: true } : {}),
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    timeZone,
  };
}
