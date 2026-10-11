import { createHmac } from 'node:crypto';
import type { QomonContact } from '@trellis/qomon-client';
import { householdKeyOf, inMunicipality } from './plan.js';
import { presenceOf, type PresenceConfig } from './presence.js';

/** One contact as the incremental job keeps it (the `contact_mirror` row,
 *  without the space). */
export interface MirrorRow {
  contactId: number;
  updatedAt: string;
  inScope: boolean;
  householdHash: string;
  presenceRefId: number | null;
  presenceValue: string | null;
  presenceDate: string | null;
  markerRefId: number | null;
}

/**
 * Households are grouped by an HMAC of the address key, so the mirror holds
 * no addresses. A contact with no usable address is a household of one, so
 * a marker on it can still be re-marked.
 */
export function householdHashOf(
  contact: QomonContact,
  spaceKey: string,
  secret: Buffer,
): string {
  const key = householdKeyOf(contact);
  if (key === null) return `solo:${contact.id}`;
  return createHmac('sha256', secret)
    .update(`${spaceKey}\0${key}`)
    .digest('base64url');
}

export function mirrorRowOf(
  contact: QomonContact,
  presence: PresenceConfig,
  municipality: string | null,
  spaceKey: string,
  secret: Buffer,
): MirrorRow {
  const answer = presenceOf(contact, presence.form);
  const marker = contact.custom_fields?.find(
    (f) => f.form_id === presence.marker.form.id,
  );
  return {
    contactId: contact.id!,
    updatedAt: contact.UpdatedAt ?? '',
    inScope: inMunicipality(contact, municipality),
    householdHash: householdHashOf(contact, spaceKey, secret),
    presenceRefId: answer?.refId ?? null,
    presenceValue: answer?.value ?? null,
    presenceDate: answer?.date ?? null,
    markerRefId: marker?.form_ref_id ?? null,
  };
}

/** Enough of a contact for the household rules (`classifyPresence`). */
export function contactOf(
  row: MirrorRow,
  presence: PresenceConfig,
): QomonContact {
  return {
    id: row.contactId,
    UpdatedAt: row.updatedAt,
    formdatas:
      row.presenceRefId === null
        ? []
        : [
            {
              form_id: presence.form.id,
              form_ref_id: row.presenceRefId,
              data: row.presenceValue,
              date: row.presenceDate,
            },
          ],
    custom_fields:
      row.markerRefId === null
        ? []
        : [{ form_id: presence.marker.form.id, form_ref_id: row.markerRefId }],
  };
}

/** Whether a change matters to the rules. `updatedAt` alone does not. */
export function relevantChange(before: MirrorRow, after: MirrorRow): boolean {
  return (
    before.inScope !== after.inScope ||
    before.householdHash !== after.householdHash ||
    before.presenceRefId !== after.presenceRefId ||
    before.presenceDate !== after.presenceDate ||
    before.markerRefId !== after.markerRefId
  );
}
