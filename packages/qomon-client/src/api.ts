import type {
  QomonBundle,
  QomonCodeCampaign,
  QomonContact,
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

/**
 * The contract the tool depends on. `QomonClient` (real REST) and
 * `InMemoryQomon` (contract-test fake) both implement it, and the contract
 * suite runs against either.
 */
export interface QomonApi {
  listTransactionBundles(params?: ListBundlesParams): Promise<ListPage<QomonBundle>>;
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
  updateContact(id: number, changes: Partial<QomonContact>): Promise<QomonContact>;
  getContact(id: number): Promise<QomonContact>;
}
