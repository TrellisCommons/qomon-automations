import type {
  BundlePatch,
  CreateBundleInput,
  ListBundlesParams,
  ListPage,
  QomonApi,
  SearchCondition,
  SearchContactsParams,
  SearchNode,
  SearchQuery,
  TransactionCoreFields,
} from './api.js';
import {
  QomonAuthError,
  QomonNotFoundError,
  QomonValidationError,
} from './errors.js';
import {
  syncedFieldsToQomon,
  type QomonSyncedFields,
} from './transaction-extra-fields.js';
import { assertUpsertId, mergeContact } from './contact-write.js';
import type {
  QomonBundle,
  QomonCodeCampaign,
  QomonContact,
  QomonContactUpsert,
  QomonForm,
  QomonFormAnswer,
  QomonFormData,
  QomonFormType,
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
 *  - `POST /search` over a two-level query, paged with no total
 *  - forms by type, `data` wrapped in an object
 *  - asynchronous upsert by id: applied a few calls later, and dropped
 *    without an error when it names an unknown contact, form, or value
 *  - one answer per form: a new Presence replaces the old one, dated when
 *    the write was applied whatever date the caller sent
 *
 * CI runs the contract suite against this fake with no network. The same suite
 * runs against the sandbox when QOMON_SANDBOX=1 (see sandbox.test.ts).
 */

export interface InMemoryQomonOptions {
  apiKey?: string;
  statuses?: QomonTransactionStatus[];
  codeCampaigns?: QomonCodeCampaign[];
  settings?: Partial<QomonTransactionSettings>;
  /** Forms by type. Defaults to one Presence form with the four canvass
   *  values. */
  forms?: Partial<Record<QomonFormType, QomonForm[]>>;
  /** Calls after an upsert before it becomes visible (default 1). */
  upsertLagCalls?: number;
}

/** Upsert keys that carry form answers, all resolved the same way. */
const FORM_ANSWER_KEYS = [
  'name_presences',
  'status',
  'consents',
  'forms',
  'actions',
] as const;

export const FAKE_PRESENCE_FORM: QomonForm = {
  id: 9001,
  label: 'Presence',
  type: 'radio',
  refvalues: [
    { id: 9101, form_id: 9001, label: 'Absent', value: 'Absent' },
    { id: 9102, form_id: 9001, label: 'Accepted', value: 'Accepted' },
    { id: 9103, form_id: 9001, label: 'Refused', value: 'Refused' },
    {
      id: 9104,
      form_id: 9001,
      label: 'Come back later',
      value: 'Come back later',
    },
  ],
};

interface PendingUpsert {
  contact: QomonContactUpsert;
  visibleAtCall: number;
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
  private readonly forms: Map<QomonFormType, QomonForm[]>;
  private readonly upsertLagCalls: number;
  private pendingUpserts: PendingUpsert[] = [];
  /** Upserts Qomon would have accepted with a 202 and then thrown away. */
  droppedUpserts: QomonContactUpsert[] = [];

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
    this.forms = new Map(
      Object.entries(
        opts.forms ?? { presence_status: [FAKE_PRESENCE_FORM] },
      ) as Array<[QomonFormType, QomonForm[]]>,
    );
    this.upsertLagCalls = opts.upsertLagCalls ?? 1;
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
    this.applyDueUpserts();
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
      {
        transaction_bundle_id: id,
        kind: 'transaction',
        old: null,
        new: { id },
        CreatedAt: now,
      },
    ]);
    return structuredClone(full);
  }

  seedContact(contact: QomonContact): QomonContact {
    const id = contact.id ?? nextId();
    const now = new Date().toISOString();
    const full = { CreatedAt: now, UpdatedAt: now, ...contact, id };
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
      (a, b) => Date.parse(b.CreatedAt ?? '') - Date.parse(a.CreatedAt ?? ''),
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

  async createTransactionBundle(
    input: CreateBundleInput,
  ): Promise<QomonBundle> {
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
        b.transactions[idx] = {
          ...b.transactions[idx]!,
          ...t,
        } as QomonTransaction;
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
    const currentExtraJson = current.transactions.find(
      (t) => t.id === transactionId,
    )?.extra_json;
    const mergedExtraJson = {
      ...(typeof currentExtraJson === 'object' && currentExtraJson !== null
        ? currentExtraJson
        : {}),
      ...syncedFieldsToQomon(syncedFields),
    };
    return this.patchTransactionBundle({
      id: bundleId,
      transactions: [
        { id: transactionId, ...core, extra_json: mergedExtraJson },
      ],
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

  async replaceContact(
    id: number,
    contact: QomonContact,
  ): Promise<QomonContact> {
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

  async updateContact(
    id: number,
    changes: Partial<QomonContact>,
  ): Promise<QomonContact> {
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

  async upsertContact(contact: QomonContactUpsert): Promise<void> {
    assertUpsertId(contact);
    this.tick();
    this.pendingUpserts.push({
      contact: structuredClone(contact),
      visibleAtCall: this.callCount + this.upsertLagCalls,
    });
  }

  /** Apply every queued upsert now, as if Qomon's queue drained. */
  flushUpserts(): void {
    for (const p of this.pendingUpserts) this.applyUpsert(p.contact);
    this.pendingUpserts = [];
  }

  private applyDueUpserts(): void {
    const due = this.pendingUpserts.filter(
      (p) => p.visibleAtCall <= this.callCount,
    );
    if (due.length === 0) return;
    this.pendingUpserts = this.pendingUpserts.filter(
      (p) => p.visibleAtCall > this.callCount,
    );
    for (const p of due) this.applyUpsert(p.contact);
  }

  private applyUpsert(upsert: QomonContactUpsert): void {
    const current = this.contacts.get(upsert.id);
    if (!current) {
      this.droppedUpserts.push(upsert);
      return;
    }
    const answers: QomonFormData[] = [];
    for (const key of FORM_ANSWER_KEYS) {
      for (const answer of upsert[key] ?? []) {
        const formData = this.resolveAnswer(answer, upsert.id);
        if (!formData) {
          this.droppedUpserts.push(upsert);
          return;
        }
        answers.push(formData);
      }
    }
    const { id, address, ...rest } = upsert;
    const fields = Object.fromEntries(
      Object.entries(rest).filter(
        ([k]) => !(FORM_ANSWER_KEYS as readonly string[]).includes(k),
      ),
    );
    const formIds = new Set(answers.map((a) => a.form_id));
    const next: QomonContact = {
      ...current,
      ...fields,
      id,
      UpdatedAt: new Date().toISOString(),
      formdatas: [
        ...(current.formdatas ?? []).filter((f) => !formIds.has(f.form_id)),
        ...answers,
      ],
    };
    if (address !== undefined)
      next.address = { ...(current.address ?? {}), ...address };
    this.contacts.set(id, next);
  }

  private resolveAnswer(
    answer: QomonFormAnswer,
    contactId: number,
  ): QomonFormData | null {
    const all = [...this.forms.values()].flat();
    const form = all.find((f) =>
      answer.id !== undefined ? f.id === answer.id : f.label === answer.label,
    );
    // Qomon accepts a refvalue's label as well as its value.
    const ref = form?.refvalues.find(
      (r) => r.value === answer.value || r.label === answer.value,
    );
    if (!form || !ref) return null;
    const now = new Date().toISOString();
    return {
      id: nextId(),
      contact_id: contactId,
      form_id: form.id,
      form_ref_id: ref.id,
      data: ref.value,
      // Qomon ignores a requested date and records when it applied the write.
      date: now,
      created_at: now,
      updated_at: now,
    };
  }

  seedForm(type: QomonFormType, form: QomonForm): QomonForm {
    this.forms.set(type, [...(this.forms.get(type) ?? []), form]);
    return structuredClone(form);
  }

  async listFormsByType(type: QomonFormType): Promise<QomonForm[]> {
    this.tick();
    return structuredClone(this.forms.get(type) ?? []);
  }

  async searchContacts(params: SearchContactsParams): Promise<QomonContact[]> {
    this.tick();
    const perPage = params.perPage ?? 1000;
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > 1000) {
      throw new QomonValidationError('per_page must be 1 to 1000', {
        method: 'POST',
        path: '/search',
        attempt: 1,
        httpStatus: 422,
      });
    }
    validateQuery(params.query);
    const page = params.page ?? 0;
    const matches = [...this.contacts.values()]
      .filter((c) => matchesQuery(c, params.query))
      .sort((a, b) => a.id! - b.id!);
    return matches
      .slice(page * perPage, (page + 1) * perPage)
      .map((c) => structuredClone(c));
  }
}

function invalidQuery(detail: string): QomonValidationError {
  return new QomonValidationError(`validation failed: ${detail}`, {
    method: 'POST',
    path: '/search',
    attempt: 1,
    httpStatus: 422,
  });
}

function validateQuery(query: SearchQuery): void {
  const nodes =
    '$all' in query
      ? query.$all
      : '$at_least_one' in query
        ? query.$at_least_one
        : null;
  if (!Array.isArray(nodes))
    throw invalidQuery('expected $all or $at_least_one at the root');
  for (const node of nodes) {
    const conditions =
      '$all' in node
        ? node.$all
        : '$at_least_one' in node
          ? node.$at_least_one
          : null;
    if (!Array.isArray(conditions))
      throw invalidQuery('a condition must sit under a level-2 node');
    for (const c of conditions) {
      if (!c || typeof c !== 'object' || !('$condition' in c)) {
        throw invalidQuery('a level-2 node holds only conditions');
      }
    }
  }
}

function logic<T>(
  node: { $all: T[] } | { $at_least_one: T[] },
  test: (item: T) => boolean,
): boolean {
  if ('$all' in node) return node.$all.every(test);
  if ('$at_least_one' in node) return node.$at_least_one.some(test);
  throw invalidQuery('expected $all or $at_least_one');
}

function matchesQuery(contact: QomonContact, query: SearchQuery): boolean {
  return logic<SearchNode>(query, (node) => {
    if ('$condition' in node)
      throw invalidQuery('a condition must sit under a level-2 node');
    return logic<SearchCondition>(node, (c) => matchesCondition(contact, c));
  });
}

function matchesCondition(
  contact: QomonContact,
  { $condition: c }: SearchCondition,
): boolean {
  if (c === undefined)
    throw invalidQuery('a level-2 node holds only conditions');
  if (c.attr === 'form' || c.attr === 'custom_fields') {
    const cond = c as Extract<typeof c, { form_id: number }>;
    const answers = (contact.formdatas ?? []).filter(
      (f) =>
        f.form_id === cond.form_id &&
        !f.deleted_at &&
        (cond.form_ref_ids.length === 0 ||
          cond.form_ref_ids.includes(f.form_ref_id ?? -1)),
    );
    switch (c.ope) {
      case 'ext':
        return answers.length > 0;
      case 'not_ext':
        return answers.length === 0;
      case 'eql':
        return answers.some((f) => f.data === c.value);
      default:
        throw invalidQuery(`the fake does not support form operator ${c.ope}`);
    }
  }
  const actual = readPath(contact, c.attr);
  const present = actual !== undefined && actual !== null && actual !== '';
  switch (c.ope) {
    case 'ext':
      return present;
    case 'not_ext':
      return !present;
    case 'eql':
      return (
        present &&
        String(actual).toLowerCase() === String(c.value ?? '').toLowerCase()
      );
    case 'not_eql':
      return (
        !present ||
        String(actual).toLowerCase() !== String(c.value ?? '').toLowerCase()
      );
    case 'start_with':
      return (
        present &&
        String(actual)
          .toLowerCase()
          .startsWith(String(c.value ?? '').toLowerCase())
      );
    default:
      throw invalidQuery(`the fake does not support operator ${c.ope}`);
  }
}

function readPath(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (v, key) =>
        v && typeof v === 'object'
          ? (v as Record<string, unknown>)[key]
          : undefined,
      value,
    );
}
