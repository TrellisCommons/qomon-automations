import { addressKey } from '@trellis/address-match-core';
import type { QomonContact } from '@trellis/qomon-client';
import { presenceOf, type PresenceConfig } from './presence.js';

/**
 * The household match, as pure functions over a fetched space.
 *
 * Run rules (issue #1):
 *  1. A contact that already has any Presence value is never modified.
 *  2. When a contact at an address has a canvassed Presence value, every
 *     other contact at that address gets the household value. Every contact
 *     counts, not only voters.
 *  3. Written values are never revisited.
 *
 * A value an earlier run wrote is a Presence, so rule 1 protects it, and it
 * is not canvassed, so it never triggers rule 2. That makes the run
 * idempotent: the next run plans only what is still missing.
 */

export interface PlannedHouseholdWrite {
  contactId: number;
  triggerContactId: number;
  triggerValue: string;
  /** when the triggering Presence was recorded (ISO), if Qomon has it */
  triggerDate: string | null;
}

export interface PlanStats {
  fetched: number;
  outsideMunicipality: number;
  /** in scope, but no street number or street name to key on */
  unkeyable: number;
  households: number;
  canvassedHouseholds: number;
  /** contacts in canvassed households left alone by rule 1 */
  alreadyHavePresence: number;
  planned: number;
}

export interface Plan {
  writes: PlannedHouseholdWrite[];
  stats: PlanStats;
}

/** Cities compare case-, accent-, and spacing-insensitively. */
export function normalizeCity(city: string): string {
  return city
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/** A contact is in scope when the space has no municipality, or the
 *  contact's city is that municipality or blank. Search's `eql` is a token
 *  match, so this is decided here, not in the query. */
export function inMunicipality(
  contact: QomonContact,
  municipality: string | null,
): boolean {
  if (municipality === null) return true;
  const city = normalizeCity(contact.address?.city ?? '');
  return city === '' || city === normalizeCity(municipality);
}

export function householdKeyOf(contact: QomonContact): string | null {
  const a = contact.address;
  return addressKey({
    house: a?.housenumber,
    door: a?.door,
    line2: a?.addition,
    street: a?.street,
  });
}

function byEarliest(
  a: { date: string | null; id: number },
  b: { date: string | null; id: number },
) {
  const ta = a.date ? Date.parse(a.date) : Number.POSITIVE_INFINITY;
  const tb = b.date ? Date.parse(b.date) : Number.POSITIVE_INFINITY;
  return ta - tb || a.id - b.id;
}

export function planHouseholdMatch(
  contacts: readonly QomonContact[],
  presence: PresenceConfig,
  municipality: string | null,
): Plan {
  const stats: PlanStats = {
    fetched: contacts.length,
    outsideMunicipality: 0,
    unkeyable: 0,
    households: 0,
    canvassedHouseholds: 0,
    alreadyHavePresence: 0,
    planned: 0,
  };

  const households = new Map<string, QomonContact[]>();
  for (const contact of contacts) {
    if (contact.id === undefined) continue;
    if (!inMunicipality(contact, municipality)) {
      stats.outsideMunicipality += 1;
      continue;
    }
    const key = householdKeyOf(contact);
    if (key === null) {
      stats.unkeyable += 1;
      continue;
    }
    const members = households.get(key);
    if (members) members.push(contact);
    else households.set(key, [contact]);
  }
  stats.households = households.size;

  const writes: PlannedHouseholdWrite[] = [];
  for (const members of households.values()) {
    const withPresence = members.map((c) => ({
      id: c.id!,
      presence: presenceOf(c, presence.form),
    }));
    const triggers = withPresence
      .filter((m) => m.presence && presence.canvassed.has(m.presence.value))
      .map((m) => ({
        id: m.id,
        value: m.presence!.value,
        date: m.presence!.date,
      }))
      .sort(byEarliest);
    const trigger = triggers[0];
    if (!trigger) continue;
    stats.canvassedHouseholds += 1;
    for (const member of withPresence) {
      if (member.presence) {
        if (member.id !== trigger.id) stats.alreadyHavePresence += 1;
        continue;
      }
      writes.push({
        contactId: member.id,
        triggerContactId: trigger.id,
        triggerValue: trigger.value,
        triggerDate: trigger.date,
      });
    }
  }
  writes.sort((a, b) => a.contactId - b.contactId);
  stats.planned = writes.length;
  return { writes, stats };
}
