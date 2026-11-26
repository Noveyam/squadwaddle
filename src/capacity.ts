export const DEFAULT_CAPACITY = 3;
export const MIN_CAPACITY = 2;
export const MAX_CAPACITY = 8;
export const CAPACITY_HINT = `How many seats total, including you? Use ${MIN_CAPACITY}–${MAX_CAPACITY} total seats, such as “four players total” or “three more”.`;

export function isValidCapacity(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_CAPACITY && value <= MAX_CAPACITY;
}
