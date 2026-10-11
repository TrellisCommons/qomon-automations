import {
  collectContacts,
  paginateContacts,
  type QomonApi,
  type QomonContact,
  type SearchCondition,
  type SearchQuery,
} from '@trellis/qomon-client';
import { householdKeyOf, householdNumberOf, inMunicipality } from './plan.js';
import {
  classifyPresence,
  type OwnWrites,
  type PresenceConfig,
} from './presence.js';

/** How far before the cursor an incremental search starts. Covers clock
 *  skew between this host and Qomon, and search trailing writes by a few
 *  seconds; re-reading a contact is harmless because the plan is idempotent. */
export const CURSOR_OVERLAP_MS = 5 * 60_000;
/** More changed contacts than this (an import, a bulk edit) and a full fetch
 *  is cheaper than searching their streets. */
export const MAX_CHANGED = 2_000;
/** Street conditions per search request. */
const STREET_CONDITIONS_PER_QUERY = 50;

export interface Fetched {
  contacts: QomonContact[];
  scope: 'full' | 'incremental';
  /** incremental: contacts changed since the cursor */
  changed?: number;
  /** incremental: distinct street prefixes searched */
  streets?: number;
  /** why an incremental run fetched everything instead */
  fallback?: string;
  /** when the first search was sent: the next run's cursor */
  searchedAt: Date;
}

export interface FetchOptions {
  incremental: boolean;
  cursor: Date | null;
  presence: PresenceConfig;
  ownWrites: OwnWrites;
  municipality: string | null;
  now: () => Date;
}

/**
 * The contacts a run plans over. A full run fetches the whole space. An
 * incremental run fetches the contacts changed since the cursor, then
 * searches the streets of those that could start or join a household match
 * and keeps only the members of their households, so each household it plans
 * over is as complete as the street search finds it. Qomon moves `UpdatedAt`
 * on any change, a canvasser's Presence included, and search can filter on
 * it (2026-10-11).
 */
export async function fetchContacts(
  qomon: Pick<QomonApi, 'searchContacts'>,
  opts: FetchOptions,
): Promise<Fetched> {
  const searchedAt = opts.now();
  const full = async (fallback?: string): Promise<Fetched> => ({
    contacts: await collectContacts(qomon, { $all: [] }),
    scope: 'full',
    searchedAt,
    ...(fallback ? { fallback } : {}),
  });
  if (!opts.incremental) return full();
  if (!opts.cursor) return full('no cursor yet');

  const since = new Date(opts.cursor.getTime() - CURSOR_OVERLAP_MS);
  const changed: QomonContact[] = [];
  for await (const contact of paginateContacts(
    qomon,
    changedSinceQuery(since),
  )) {
    changed.push(contact);
    // a bulk change: stop paying for it page by page
    if (changed.length > MAX_CHANGED)
      return full(`more than ${MAX_CHANGED} contacts changed`);
  }

  const byId = new Map<number, QomonContact>();
  const households = new Set<string>();
  const streets = new Map<string, Set<string>>();
  for (const contact of changed) {
    // the job's own writes change nothing about their household
    if (
      classifyPresence(contact, opts.presence, opts.ownWrites).kind ===
      'written'
    )
      continue;
    if (contact.id !== undefined) byId.set(contact.id, contact);
    if (!inMunicipality(contact, opts.municipality)) continue;
    const key = householdKeyOf(contact);
    const number = householdNumberOf(contact);
    const stem = streetStem(contact.address?.street ?? '');
    if (key === null || number === null || stem === null) continue;
    households.add(key);
    const numbers = streets.get(stem) ?? new Set<string>();
    numbers.add(number);
    streets.set(stem, numbers);
  }

  for (const query of streetQueries(streets)) {
    for (const contact of await collectContacts(qomon, query)) {
      const key = householdKeyOf(contact);
      if (contact.id !== undefined && key !== null && households.has(key))
        byId.set(contact.id, contact);
    }
  }
  return {
    contacts: [...byId.values()],
    scope: 'incremental',
    changed: changed.length,
    streets: streets.size,
    searchedAt,
  };
}

export function changedSinceQuery(since: Date): SearchQuery {
  return {
    $all: [
      {
        $all: [
          {
            $condition: {
              attr: 'UpdatedAt',
              ope: 'gte',
              value: since.toISOString(),
            },
          },
        ],
      },
    ],
  };
}

/**
 * The first word of a street name, as stored, for a `start_with` search
 * that finds the whole street: "Example St", "Example Street", and
 * "example st." all start with "Example" whatever their case. A leading
 * street number ("345 Example St") is dropped. Null when there is no name.
 */
export function streetStem(street: string): string | null {
  const name = street.trim().replace(/^\d+[a-z]?(?:-\d+)?\s+/i, '');
  const stem = /^[\p{L}\p{N}']+/u.exec(name)?.[0];
  return stem && !/^\d+$/.test(stem) ? stem : null;
}

/**
 * Searches covering every street: each stem in its stored case, lower case,
 * and capitalized, and each with the household's number in front for
 * contacts whose number is in the street field. Conditions are OR'd, at most
 * STREET_CONDITIONS_PER_QUERY to a request.
 */
export function streetQueries(
  streets: ReadonlyMap<string, ReadonlySet<string>>,
): SearchQuery[] {
  const values = new Set<string>();
  for (const [stem, numbers] of streets) {
    const lower = stem.toLowerCase();
    const forms = [stem, lower, lower[0]!.toUpperCase() + lower.slice(1)];
    for (const form of forms) {
      values.add(form);
      for (const n of numbers) values.add(`${n} ${form}`);
    }
  }
  const conditions: SearchCondition[] = [...values].map((value) => ({
    $condition: { attr: 'address.street', ope: 'start_with', value },
  }));
  const queries: SearchQuery[] = [];
  for (let i = 0; i < conditions.length; i += STREET_CONDITIONS_PER_QUERY) {
    queries.push({
      $all: [
        { $at_least_one: conditions.slice(i, i + STREET_CONDITIONS_PER_QUERY) },
      ],
    });
  }
  return queries;
}
