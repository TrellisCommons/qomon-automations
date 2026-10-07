import type {
  BundlePatch,
  CreateBundleInput,
  ListBundlesParams,
  ListPage,
  QomonApi,
  TransactionCoreFields,
} from './api.js';
import {
  QomonAuthError,
  QomonNotFoundError,
  QomonValidationError,
} from './errors.js';
import { syncedFieldsToQomon, type QomonSyncedFields } from './transaction-extra-fields.js';
import { mergeContact } from './contact-write.js';
import type {
  QomonBundle,
  QomonCodeCampaign,
  QomonContact,
  QomonHistoryEntry,
  QomonTransaction,
  QomonTransactionSettings,
  QomonTransactionStatus,
} from './types.js';

/**
 * In-memory Qomon contract fake (test-plan §5). Reproduces the behaviours the
 * tool depends on:
 *  - additive-only bundle PATCH (no item removal)
 *  - whole-object metadata write
 *  - limit/offset lists, newest first
 *  - synchronous contact create returning an id
 *  - full-replace contact PATCH
 *  - structured errors with HTTP-ish status codes
 *
 * CI runs the contract suite against this fake with no network. The same suite
 * runs against the sandbox when QOMON_SANDBOX=1 (see sandbox.test.ts).
 */

export interface InMemoryQomonOptions {
  apiKey?: string;
  statuses?: QomonTransactionStatus[];
  codeCampaigns?: QomonCodeCampaign[];
  settings?: Partial<QomonTransactionSettings>;
}

let idSeq = 100_000;
const nextId = (): number => (idSeq += 1);

interface SeedBundleInput {
  id?: number;
  group_id?: number;
  CreatedAt?: string;
  UpdatedAt?: string;
  transactions?: Array<Partial<QomonTransaction>>;
  donations?: unknown[];
  memberships?: unknown[];
  summary?: QomonBundle['summary'];
}

export class InMemoryQomon implements QomonApi {
  private readonly apiKey: string;
  private readonly bundles = new Map<number, QomonBundle>();
  private readonly history = new Map<number, QomonHistoryEntry[]>();
  private readonly contacts = new Map<number, QomonContact>();
  private readonly statuses: QomonTransactionStatus[];
  private readonly codeCampaigns: QomonCodeCampaign[];
  private readonly settings: QomonTransactionSettings;

  /** Fault injection: number of leading calls to fail, and with what. */
  failFor = 0;
  failWith: () => Error = () =>
    Object.assign(new Error('injected server error'), { retryable: true });
  callCount = 0;

  constructor(opts: InMemoryQomonOptions = {}) {
    this.apiKey = opts.apiKey ?? 'test-key';
    this.statuses = opts.statuses ?? [
      { id: 1, name: 'Valid', kind: 'valid', archived: false },
      { id: 2, name: 'Refund', kind: 'reimbursed', archived: false },
      { id: 3, name: 'Cancel', kind: 'cancel', archived: false },
    ];
    this.codeCampaigns = opts.codeCampaigns ?? [];
    this.settings = {
      payment_method_kinds: ['card', 'check', 'cash', 'transfer'],
      currency: 'cad',
      default_status_id: 1,
      ...opts.settings,
    };
  }

  authenticate(key: string): void {
    if (key !== this.apiKey) {
      throw new QomonAuthError('bad key', {
        method: 'GET',
        path: '/',
        attempt: 1,
        httpStatus: 401,
      });
    }
  }

  private tick(): void {
    this.callCount += 1;
    if (this.failFor > 0) {
      this.failFor -= 1;
      throw this.failWith();
    }
  }

  seedBundle(bundle: SeedBundleInput = {}): QomonBundle {
    const id: number = bundle.id ?? nextId();
    const now = new Date().toISOString();
    const transactions = (bundle.transactions ?? []).map((t) => ({
      ...t,
      id: t.id ?? nextId(),
      amount: t.amount ?? 1000,
      currency: t.currency ?? 'cad',
      contact_id: t.contact_id ?? 1,
      date: t.date ?? now,
      transaction_bundle_id: id,
    }));
    const full = {
      id,
      group_id: bundle.group_id ?? 1,
      CreatedAt: bundle.CreatedAt ?? now,
      UpdatedAt: bundle.UpdatedAt ?? now,
      transactions,
      donations: bundle.donations ?? [],
      memberships: bundle.memberships ?? [],
      summary: bundle.summary,
    } as unknown as QomonBundle;
    this.bundles.set(id, full);
    this.history.set(id, [
      { transaction_bundle_id: id, kind: 'transaction', old: null, new: { id }, CreatedAt: now },
    ]);
    return structuredClone(full);
  }

  seedContact(contact: QomonContact): QomonContact {
    const id = contact.id ?? nextId();
    const full = { ...contact, id };
    this.contacts.set(id, full);
    return structuredClone(full);
  }

  async listTransactionBundles(
    params: ListBundlesParams = {},
  ): Promise<ListPage<QomonBundle>> {
    this.tick();
    const limit = Math.min(1000, params.limit ?? 100);
    const offset = params.offset ?? 0;
    const all = [...this.bundles.values()].sort(
      (a, b) =>
        Date.parse(b.CreatedAt ?? '') - Date.parse(a.CreatedAt ?? ''),
    );
    return {
      data: all.slice(offset, offset + limit).map((b) => structuredClone(b)),
      total: all.length,
    };
  }

  async getTransactionBundle(id: number): Promise<QomonBundle> {
    this.tick();
    const b = this.bundles.get(id);
    if (!b) {
      throw new QomonNotFoundError('bundle not found', {
        method: 'GET',
        path: `/v1/transaction_bundles/${id}`,
        attempt: 1,
        httpStatus: 404,
      });
    }
    return structuredClone(b);
  }

  async createTransactionBundle(input: CreateBundleInput): Promise<QomonBundle> {
    this.tick();
    if (!input.transactions || input.transactions.length === 0) {
      throw new QomonValidationError('at least one transaction required', {
        method: 'POST',
        path: '/v1/transaction_bundles',
        attempt: 1,
        httpStatus: 422,
      });
    }
    return this.seedBundle({
      transactions: input.transactions as Array<Partial<QomonTransaction>>,
      donations: input.donations,
      memberships: input.memberships,
    });
  }

  async patchTransactionBundle(patch: BundlePatch): Promise<QomonBundle> {
    this.tick();
    const b = this.bundles.get(patch.id);
    if (!b) {
      throw new QomonNotFoundError('bundle not found', {
        method: 'PATCH',
        path: `/v1/transaction_bundles/${patch.id}`,
        attempt: 1,
        httpStatus: 404,
      });
    }
    // additive semantics: modify by id, add when no id, never remove
    for (const t of patch.transactions ?? []) {
      if (t.id != null) {
        const idx = b.transactions.findIndex((x) => x.id === t.id);
        if (idx === -1) {
          throw new QomonValidationError(`unknown transaction id ${t.id}`, {
            method: 'PATCH',
            path: `/v1/transaction_bundles/${patch.id}`,
            attempt: 1,
            httpStatus: 422,
          });
        }
        b.transactions[idx] = { ...b.transactions[idx]!, ...t } as QomonTransaction;
      } else {
        b.transactions.push({
          ...t,
          id: nextId(),
          amount: typeof t.amount === 'number' ? t.amount : 0,
          currency:
            typeof t.currency === 'string'
              ? t.currency
              : (this.settings.currency ?? 'cad'),
          contact_id: typeof t.contact_id === 'number' ? t.contact_id : 0,
          date: typeof t.date === 'string' ? t.date : new Date().toISOString(),
          transaction_bundle_id: b.id,
        } as QomonTransaction);
      }
    }
    b.UpdatedAt = new Date().toISOString();
    this.history.get(b.id)?.push({
      transaction_bundle_id: b.id,
      kind: 'transaction',
      CreatedAt: b.UpdatedAt,
    });
    return structuredClone(b);
  }

  async getTransactionBundleHistory(id: number): Promise<QomonHistoryEntry[]> {
    this.tick();
    return structuredClone(this.history.get(id) ?? []);
  }

  async listTransactionStatuses(): Promise<QomonTransactionStatus[]> {
    this.tick();
    return structuredClone(this.statuses);
  }

  async listCodeCampaigns(): Promise<QomonCodeCampaign[]> {
    this.tick();
    return structuredClone(this.codeCampaigns);
  }

  async getTransactionSettings(): Promise<QomonTransactionSettings> {
    this.tick();
    return structuredClone(this.settings);
  }

  async writeTransactionMetadata(
    bundleId: number,
    transactionId: number,
    syncedFields: QomonSyncedFields,
    core: TransactionCoreFields,
  ): Promise<QomonBundle> {
    const current = await this.getTransactionBundle(bundleId);
    const currentExtraJson = current.transactions.find((t) => t.id === transactionId)?.extra_json;
    const mergedExtraJson = {
      ...(typeof currentExtraJson === 'object' && currentExtraJson !== null ? currentExtraJson : {}),
      ...syncedFieldsToQomon(syncedFields),
    };
    return this.patchTransactionBundle({
      id: bundleId,
      transactions: [{ id: transactionId, ...core, extra_json: mergedExtraJson }],
    });
  }

  async createContact(contact: QomonContact): Promise<{ id: number }> {
    this.tick();
    if (!contact.firstname || !contact.surname) {
      throw new QomonValidationError('firstname and surname required', {
        method: 'POST',
        path: '/contacts',
        attempt: 1,
        httpStatus: 422,
      });
    }
    const created = this.seedContact({ ...contact, id: undefined });
    return { id: created.id! };
  }

  async replaceContact(id: number, contact: QomonContact): Promise<QomonContact> {
    this.tick();
    if (!this.contacts.has(id)) {
      throw new QomonNotFoundError('contact not found', {
        method: 'PATCH',
        path: `/contacts/${id}`,
        attempt: 1,
        httpStatus: 404,
      });
    }
    // full replace: whatever is passed becomes the whole record
    const replaced = { ...contact, id };
    this.contacts.set(id, replaced);
    return structuredClone(replaced);
  }

  async updateContact(id: number, changes: Partial<QomonContact>): Promise<QomonContact> {
    const current = await this.getContact(id);
    await this.replaceContact(id, mergeContact(current, changes, id));
    return this.getContact(id);
  }

  async getContact(id: number): Promise<QomonContact> {
    this.tick();
    const c = this.contacts.get(id);
    if (!c) {
      throw new QomonNotFoundError('contact not found', {
        method: 'GET',
        path: `/contacts/${id}`,
        attempt: 1,
        httpStatus: 404,
      });
    }
    return structuredClone(c);
  }
}
