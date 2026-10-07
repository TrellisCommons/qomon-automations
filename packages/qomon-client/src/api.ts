import type {
  QomonBundle,
  QomonCodeCampaign,
  QomonContact,
  QomonContactUpsert,
  QomonForm,
  QomonFormType,
  QomonHistoryEntry,
  QomonTransactionSettings,
  QomonTransactionStatus,
} from './types.js';
import type { QomonSyncedFields } from './transaction-extra-fields.js';

export interface ListPage<T> {
  data: T[];
  total?: number;
}

export interface ListBundlesParams {
  /** default 100, hard cap 1000 (newest first). */
  limit?: number;
  offset?: number;
}

/** Additive bundle PATCH (qomon-api-reference §1.4): include an item `id` to
 *  modify it, omit `id` to add. Items cannot be removed. */
export interface BundlePatch {
  id: number;
  transactions?: Array<{ id?: number; [k: string]: unknown }>;
  donations?: Array<{ id?: number; [k: string]: unknown }>;
  memberships?: Array<{ id?: number; [k: string]: unknown }>;
}

export interface CreateBundleInput {
  transactions: Array<Record<string, unknown>>;
  donations?: Array<Record<string, unknown>>;
  memberships?: Array<Record<string, unknown>>;
}

/** The transaction fields Qomon re-validates as required on every PATCH to an
 *  existing item, metadata-only edits included (live sandbox fact, not
 *  documented in qomon-api-reference: PATCH is additive across bundle items,
 *  but each patched item must itself carry its required fields). */
export interface TransactionCoreFields {
  amount: number;
  currency: string;
  contact_id: number;
  date: string;
  payment_method_kind?: string;
}

/** A condition on a contact attribute, such as `address.city`. */
export interface SearchAttributeCondition {
  attr: string;
  ope: string;
  value?: string | null;
  from?: string | null;
  to?: string | null;
}

/** A condition on a form answer (`attr: 'form'`), such as "Presence exists". */
export interface SearchFormCondition {
  attr: 'form' | 'custom_fields';
  ope: string;
  form_id: number;
  form_ref_ids: number[];
  value?: string | null;
  from?: string | null;
  to?: string | null;
}

export type SearchCondition = {
  $condition: SearchAttributeCondition | SearchFormCondition;
};

/** Level 2 of a search query: a logic operator over conditions. */
export type SearchNode =
  { $all: SearchCondition[] } | { $at_least_one: SearchCondition[] };

/**
 * A `POST /search` query. Qomon accepts exactly two levels: a root logic
 * operator over nodes, each node a logic operator over conditions. A
 * condition directly under the root is rejected (422). `{ $all: [] }`
 * matches every contact.
 */
export type SearchQuery =
  { $all: SearchNode[] } | { $at_least_one: SearchNode[] };

export type SearchSortAttr =
  | 'surname'
  | 'firstname'
  | 'birthdate'
  | 'gender'
  | 'lastchange'
  | 'mail'
  | 'married_name'
  | 'city';

export interface SearchContactsParams {
  query: SearchQuery;
  /** 1 to 1000; default 1000. */
  perPage?: number;
  /** zero-based; default 0. */
  page?: number;
  sortAttr?: SearchSortAttr;
  sortAsc?: boolean;
}

/**
 * The contract the tool depends on. `QomonClient` (real REST) and
 * `InMemoryQomon` (contract-test fake) both implement it, and the contract
 * suite runs against either.
 */
export interface QomonApi {
  listTransactionBundles(
    params?: ListBundlesParams,
  ): Promise<ListPage<QomonBundle>>;
  getTransactionBundle(id: number): Promise<QomonBundle>;
  createTransactionBundle(input: CreateBundleInput): Promise<QomonBundle>;
  patchTransactionBundle(patch: BundlePatch): Promise<QomonBundle>;
  getTransactionBundleHistory(id: number): Promise<QomonHistoryEntry[]>;

  listTransactionStatuses(): Promise<QomonTransactionStatus[]>;
  listCodeCampaigns(): Promise<QomonCodeCampaign[]>;
  getTransactionSettings(): Promise<QomonTransactionSettings>;

  /** Writes this tool's synced descriptive fields onto one transaction's
   *  `extra_json` (D4: the tool always writes the whole synced-field subset,
   *  never a partial merge of ITS OWN fields). Internally reads the
   *  transaction's current extra_json first and merges onto it, preserving
   *  keys this tool doesn't own (Qomon staff-edited fields like "Target
   *  Entity"), then re-reads after the write to return confirmed state:
   *  Qomon's PATCH response never carries extra_json regardless of whether
   *  the write succeeded (live sandbox fact), so it can't be trusted as an
   *  echo. `core` must be the transaction's current amount/currency/contact/
   *  date: Qomon re-validates the whole item on PATCH, so it has to be
   *  resent even when only extra_json is changing. */
  writeTransactionMetadata(
    bundleId: number,
    transactionId: number,
    syncedFields: QomonSyncedFields,
    core: TransactionCoreFields,
  ): Promise<QomonBundle>;

  /** Synchronous create; returns the new contact id in one round trip. */
  createContact(contact: QomonContact): Promise<{ id: number }>;
  /** Full-replace PATCH; every field must be supplied. */
  replaceContact(id: number, contact: QomonContact): Promise<QomonContact>;
  /** Change some fields of a contact: reads the current record, merges
   *  `changes` onto it (the address field by field), writes the whole object
   *  back (PATCH is a full replace), and returns the record as re-read
   *  after the write. */
  updateContact(
    id: number,
    changes: Partial<QomonContact>,
  ): Promise<QomonContact>;
  getContact(id: number): Promise<QomonContact>;

  /** One page of `POST /search`. Qomon returns no total; a page shorter
   *  than `perPage` is the last one. See `paginateContacts`. */
  searchContacts(params: SearchContactsParams): Promise<QomonContact[]>;
  /** Every form of one type, with its accepted values. */
  listFormsByType(type: QomonFormType): Promise<QomonForm[]>;
  /** `POST /contacts/upsert` by Qomon id. Asynchronous: Qomon answers 202
   *  before applying it, and drops a record with an unknown form, label, or
   *  value without any error. A caller must read the contact back to know
   *  whether the write landed. Refuses a contact without an id. */
  upsertContact(contact: QomonContactUpsert): Promise<void>;
}
