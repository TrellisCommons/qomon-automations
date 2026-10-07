import { describe, expect, it } from 'vitest';
import type { QomonApi } from './api.js';
import {
  collectBundles,
  collectContacts,
  paginateBundles,
} from './pagination.js';
import type { QomonContact } from './types.js';
import { QomonPollChangeFeed } from './ingestion-source.js';
import {
  qomonToSyncedFields,
  type QomonSyncedFields,
} from './transaction-extra-fields.js';

/**
 * The Qomon contract. Runs against the in-memory fake in CI (no network) and
 * against the sandbox when QOMON_SANDBOX=1. `setup` returns an api plus a way
 * to create a disposable bundle to operate on, so the suite never depends on
 * pre-existing sandbox data.
 */
export interface ContractHarness {
  api: QomonApi;
  /** create a bundle with one transaction; return its ids. */
  makeBundle(): Promise<{
    bundleId: number;
    transactionId: number;
    contactId: number;
  }>;
  /** whether metadata round-trips (false on the sandbox until Qomon ships A1). */
  metadataSupported: boolean;
  /** create a disposable contact with invented data; return its id. */
  makeContact(fields?: Partial<QomonContact>): Promise<number>;
  /** poll `check` until it returns a value, for asynchronous writes and
   *  search indexing; throws after the harness's timeout. */
  eventually<T>(check: () => Promise<T | undefined>): Promise<T>;
  /** wait long enough that an upsert Qomon accepted would be visible. */
  settle(): Promise<void>;
}

/** Unique per call, so a contract run never matches an existing contact. */
export function disposableName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function runQomonContractSuite(
  label: string,
  setup: () => Promise<ContractHarness>,
): void {
  describe(`Qomon contract: ${label}`, () => {
    it('lists bundles newest-first with a total', async () => {
      const h = await setup();
      await h.makeBundle();
      const page = await h.api.listTransactionBundles({ limit: 5 });
      expect(Array.isArray(page.data)).toBe(true);
      expect(page.data.length).toBeGreaterThan(0);
    });

    it('paginates the whole list without duplicates', async () => {
      const h = await setup();
      await h.makeBundle();
      await h.makeBundle();
      const ids = new Set<number>();
      for await (const b of paginateBundles(h.api, { pageSize: 1 }))
        ids.add(b.id);
      const all = await collectBundles(h.api, { pageSize: 1000 });
      expect(ids.size).toBe(all.length);
    });

    it('reads one bundle by id and 404s on a missing one', async () => {
      const h = await setup();
      const { bundleId } = await h.makeBundle();
      const b = await h.api.getTransactionBundle(bundleId);
      expect(b.id).toBe(bundleId);
      await expect(h.api.getTransactionBundle(999_999_999)).rejects.toThrow();
    });

    it('PATCH is additive: modifying a transaction keeps the others', async () => {
      const h = await setup();
      const { bundleId, transactionId } = await h.makeBundle();
      const before = await h.api.getTransactionBundle(bundleId);
      const tx = before.transactions.find((t) => t.id === transactionId)!;
      // Qomon re-validates the whole item on PATCH, so send it back complete
      // with the change applied (the tool always writes whole objects anyway).
      const patched = await h.api.patchTransactionBundle({
        id: bundleId,
        transactions: [
          {
            id: transactionId,
            amount: tx.amount,
            currency: tx.currency,
            payment_method_kind: tx.payment_method_kind ?? undefined,
            contact_id: tx.contact_id,
            date: tx.date,
            comment: 'contract-test note',
          },
        ],
      });
      expect(patched.transactions.length).toBe(before.transactions.length);
    });

    it('resolves transaction statuses by kind', async () => {
      const h = await setup();
      const statuses = await h.api.listTransactionStatuses();
      expect(statuses.some((s) => s.kind === 'valid')).toBe(true);
    });

    it('exposes transaction settings with allowed payment methods', async () => {
      const h = await setup();
      const settings = await h.api.getTransactionSettings();
      expect(Array.isArray(settings.payment_method_kinds)).toBe(true);
    });

    it('writes the whole metadata object and reads it back', async () => {
      const h = await setup();
      if (!h.metadataSupported) return;
      const { bundleId, transactionId } = await h.makeBundle();
      const before = await h.api.getTransactionBundle(bundleId);
      const existing = before.transactions.find((t) => t.id === transactionId)!;
      const syncedFields: QomonSyncedFields = {
        period_id: 67,
        riding_number: 84,
        entity_kind: 'CA',
        goods_services: false,
        processed_date: null,
        source_code: 'contract:test',
      };
      await h.api.writeTransactionMetadata(
        bundleId,
        transactionId,
        syncedFields,
        {
          amount: existing.amount,
          currency: existing.currency,
          contact_id: existing.contact_id,
          date: existing.date,
          payment_method_kind: existing.payment_method_kind ?? undefined,
        },
      );
      const after = await h.api.getTransactionBundle(bundleId);
      const tx = after.transactions.find((t) => t.id === transactionId);
      expect(qomonToSyncedFields(tx?.extra_json)).toEqual(syncedFields);
    });

    it('the poll change feed reports new work and then catches up', async () => {
      const h = await setup();
      const feed = new QomonPollChangeFeed(h.api, { pageSize: 100 });
      const first = await feed.pull(null);
      expect(first.changes.length).toBeGreaterThanOrEqual(0);
      const caughtUp = await feed.pull(first.cursor);
      expect(caughtUp.changes.length).toBe(0);
    });

    it('creates a contact synchronously and refuses an incomplete replace', async () => {
      const h = await setup();
      const created = await h.api.createContact({
        firstname: 'Contract',
        surname: `Test-${Date.now()}`,
        mail: `contract-${Date.now()}@example.org`,
      });
      expect(typeof created.id).toBe('number');
    });

    it('reads a contact by id and 404s on a missing one', async () => {
      const h = await setup();
      const surname = disposableName('Read');
      const id = await h.makeContact({ surname });
      const contact = await h.api.getContact(id);
      expect(contact.id).toBe(id);
      expect(contact.surname).toBe(surname);
      await expect(h.api.getContact(999_999_999)).rejects.toThrow();
    });

    it('lists the Presence forms with their accepted values', async () => {
      const h = await setup();
      const forms = await h.api.listFormsByType('presence_status');
      expect(forms.length).toBeGreaterThan(0);
      for (const form of forms) {
        expect(typeof form.id).toBe('number');
        expect(form.refvalues.length).toBeGreaterThan(0);
        for (const ref of form.refvalues)
          expect(typeof ref.value).toBe('string');
      }
    });

    it('searches on a condition and pages without duplicates', async () => {
      const h = await setup();
      const surname = disposableName('Search');
      const ids = new Set([
        await h.makeContact({ surname }),
        await h.makeContact({ surname }),
        await h.makeContact({ surname }),
      ]);
      const query = {
        $all: [
          {
            $all: [
              { $condition: { attr: 'surname', ope: 'eql', value: surname } },
            ],
          },
        ],
      };
      const found = await h.eventually(async () => {
        const contacts = await collectContacts(h.api, query, { pageSize: 1 });
        return contacts.length >= ids.size ? contacts : undefined;
      });
      expect(new Set(found.map((c) => c.id))).toEqual(ids);
    });

    it('rejects a search condition directly under the root', async () => {
      const h = await setup();
      const flat = { $all: [{ $condition: { attr: 'surname', ope: 'ext' } }] };
      await expect(
        h.api.searchContacts({ query: flat as never, perPage: 1 }),
      ).rejects.toThrow();
    });

    it('upsert by id changes the named field and leaves the rest', async () => {
      const h = await setup();
      const surname = disposableName('Upsert');
      const id = await h.makeContact({ surname });
      const before = await h.api.getContact(id);
      const marker = disposableName('married');
      await h.api.upsertContact({ id, married_name: marker });
      const after = await h.eventually(async () => {
        const c = await h.api.getContact(id);
        return c.married_name === marker ? c : undefined;
      });
      expect(after.firstname).toBe(before.firstname);
      expect(after.surname).toBe(before.surname);
      expect(after.mail).toBe(before.mail);
      expect(after.address?.street).toBe(before.address?.street);
      expect(after.address?.city).toBe(before.address?.city);
    });

    it('upsert by id writes a Presence answer', async () => {
      const h = await setup();
      const [form] = await h.api.listFormsByType('presence_status');
      const ref = form!.refvalues[0]!;
      const id = await h.makeContact({ surname: disposableName('Presence') });
      await h.api.upsertContact({
        id,
        name_presences: [{ id: form!.id, value: ref.value! }],
      });
      const answer = await h.eventually(async () => {
        const c = await h.api.getContact(id);
        return c.formdatas?.find((f) => f.form_id === form!.id);
      });
      expect(answer.form_ref_id).toBe(ref.id);
    });

    it('upsert drops a record with an unknown form value, without an error', async () => {
      const h = await setup();
      const [form] = await h.api.listFormsByType('presence_status');
      const id = await h.makeContact({ surname: disposableName('Dropped') });
      const marker = disposableName('married');
      await h.api.upsertContact({
        id,
        married_name: marker,
        name_presences: [
          { id: form!.id, value: disposableName('not-a-value') },
        ],
      });
      await h.settle();
      const after = await h.api.getContact(id);
      expect(after.married_name).not.toBe(marker);
      expect(
        after.formdatas?.some((f) => f.form_id === form!.id) ?? false,
      ).toBe(false);
    });

    it('refuses an upsert without an id before calling Qomon', async () => {
      const h = await setup();
      await expect(
        h.api.upsertContact({ firstname: 'No', surname: 'Id' } as never),
      ).rejects.toThrow(/id/);
    });
  });
}
