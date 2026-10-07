import type { QomonContact } from './types.js';

/**
 * Guarded contact-write wrapper (data-model §4, qomon-api-reference §6 gap 14).
 *
 * Qomon has three contact-write paths and two are hazardous for a money-linked
 * pipeline:
 *  - `POST /contacts/upsert` is asynchronous, returns no id, and DROPS records
 *    silently when a form reference is invalid ("errors will not be logged").
 *  - `PATCH /contacts/{id}` behaves as a full replace: any omitted field is
 *    cleared.
 *
 * This wrapper exposes only the safe operations: the synchronous create (which
 * yields an id in one round trip) and a field-complete replace that refuses to
 * run unless the caller supplied a whole object. The async upsert is not
 * reachable through it.
 */

export class IncompleteContactError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `replaceContact needs a field-complete object (PATCH is a full replace); missing/blank: ${missing.join(', ')}`,
    );
    this.name = 'IncompleteContactError';
  }
}

export interface ContactWriteTransport {
  createContact(contact: QomonContact): Promise<QomonContact>;
  replaceContact(id: number, contact: QomonContact): Promise<QomonContact>;
  getContact(id: number): Promise<QomonContact>;
}

/** Fields we insist are present on a full replace so a PATCH cannot blank a
 *  donor's identity or address out from under an issued receipt. */
const REQUIRED_FOR_REPLACE: Array<keyof QomonContact> = [
  'firstname',
  'surname',
  'mail',
  'address',
];

export class GuardedContactWriter {
  constructor(private readonly transport: ContactWriteTransport) {}

  async createContact(contact: QomonContact): Promise<{ id: number }> {
    const created = await this.transport.createContact(stripId(contact));
    if (typeof created.id !== 'number') {
      throw new Error('Qomon contact create did not return an id');
    }
    return { id: created.id };
  }

  async replaceContact(
    id: number,
    contact: QomonContact,
  ): Promise<QomonContact> {
    const missing = REQUIRED_FOR_REPLACE.filter((k) => {
      const v = contact[k];
      return v === undefined || v === null || v === '';
    }).map(String);
    if (missing.length > 0) throw new IncompleteContactError(missing);
    return this.transport.replaceContact(id, { ...contact, id });
  }

  /** Read-modify-write: the merged object is field-complete by
   *  construction (Qomon's own current record plus the changes), so it does
   *  not go through the {@link replaceContact} completeness check, which
   *  would refuse a contact Qomon itself holds with no email. */
  async updateContact(id: number, changes: Partial<QomonContact>): Promise<QomonContact> {
    const current = await this.transport.getContact(id);
    await this.transport.replaceContact(id, mergeContact(current, changes, id));
    return this.transport.getContact(id);
  }

  getContact(id: number): Promise<QomonContact> {
    return this.transport.getContact(id);
  }
}

/** `changes` onto `current`, keeping every field (and address key) the
 *  caller did not name, including ones this client does not model. */
export function mergeContact(
  current: QomonContact,
  changes: Partial<QomonContact>,
  id: number,
): QomonContact {
  const { id: _id, address, ...rest } = changes;
  void _id;
  const merged: QomonContact = { ...current, ...rest, id };
  if (address !== undefined) {
    merged.address = address === null ? null : { ...(current.address ?? {}), ...address };
  }
  return merged;
}

function stripId(contact: QomonContact): QomonContact {
  const { id: _id, ...rest } = contact;
  void _id;
  return rest;
}
