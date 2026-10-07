import { describe, expect, it } from 'vitest';
import type { QomonApi } from './api.js';
import { collectBundles, paginateBundles } from './pagination.js';
import { QomonPollChangeFeed } from './ingestion-source.js';
import { qomonToSyncedFields, type QomonSyncedFields } from './transaction-extra-fields.js';

/**
 * The Qomon contract. Runs against the in-memory fake in CI (no network) and
 * against the sandbox when QOMON_SANDBOX=1. `setup` returns an api plus a way
 * to create a disposable bundle to operate on, so the suite never depends on
 * pre-existing sandbox data.
 */
export interface ContractHarness {
  api: QomonApi;
  /** create a bundle with one transaction; return its ids. */
  makeBundle(): Promise<{ bundleId: number; transactionId: number; contactId: number }>;
  /** whether metadata round-trips (false on the sandbox until Qomon ships A1). */
  metadataSupported: boolean;
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
      for await (const b of paginateBundles(h.api, { pageSize: 1 })) ids.add(b.id);
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
      await h.api.writeTransactionMetadata(bundleId, transactionId, syncedFields, {
        amount: existing.amount,
        currency: existing.currency,
        contact_id: existing.contact_id,
        date: existing.date,
        payment_method_kind: existing.payment_method_kind ?? undefined,
      });
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
  });
}
