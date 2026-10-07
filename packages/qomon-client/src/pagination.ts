import type {
  ListBundlesParams,
  QomonApi,
  SearchContactsParams,
  SearchQuery,
} from './api.js';
import type { QomonBundle, QomonContact } from './types.js';

export interface PaginateOptions {
  /** page size, capped at the API max of 1000. */
  pageSize?: number;
  /** stop after this many pages (safety bound for very large spaces). */
  maxPages?: number;
  startOffset?: number;
}

/**
 * Page the limit/offset bundle list (the only listing primitive Qomon offers,
 * newest first). Yields one bundle at a time so callers can stream a full
 * sweep without buffering the whole space.
 */
export async function* paginateBundles(
  api: Pick<QomonApi, 'listTransactionBundles'>,
  options: PaginateOptions = {},
): AsyncGenerator<QomonBundle> {
  const pageSize = Math.min(1000, Math.max(1, options.pageSize ?? 500));
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
  let offset = options.startOffset ?? 0;
  let page = 0;

  for (;;) {
    if (page >= maxPages) return;
    const params: ListBundlesParams = { limit: pageSize, offset };
    const res = await api.listTransactionBundles(params);
    for (const bundle of res.data) yield bundle;
    page += 1;
    if (res.data.length < pageSize) return;
    offset += res.data.length;
    if (res.total !== undefined && offset >= res.total) return;
  }
}

/** Collect every bundle (convenience for small spaces and tests). */
export async function collectBundles(
  api: Pick<QomonApi, 'listTransactionBundles'>,
  options: PaginateOptions = {},
): Promise<QomonBundle[]> {
  const out: QomonBundle[] = [];
  for await (const b of paginateBundles(api, options)) out.push(b);
  return out;
}

export interface PaginateContactsOptions {
  /** page size, capped at the API max of 1000. */
  pageSize?: number;
  /** stop after this many pages (safety bound for very large spaces). */
  maxPages?: number;
  sortAttr?: SearchContactsParams['sortAttr'];
  sortAsc?: boolean;
}

/**
 * Page `POST /search` until a short page. Qomon reports no total, and pages
 * are offsets into a live result set: a contact edited mid-sweep can move
 * between pages and appear twice or not at all. Duplicates are dropped here;
 * a missed contact is picked up by the next run.
 */
export async function* paginateContacts(
  api: Pick<QomonApi, 'searchContacts'>,
  query: SearchQuery,
  options: PaginateContactsOptions = {},
): AsyncGenerator<QomonContact> {
  const pageSize = Math.min(1000, Math.max(1, options.pageSize ?? 1000));
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
  const seen = new Set<number>();

  for (let page = 0; page < maxPages; page += 1) {
    const contacts = await api.searchContacts({
      query,
      perPage: pageSize,
      page,
      sortAttr: options.sortAttr,
      sortAsc: options.sortAsc,
    });
    for (const contact of contacts) {
      if (contact.id !== undefined) {
        if (seen.has(contact.id)) continue;
        seen.add(contact.id);
      }
      yield contact;
    }
    if (contacts.length < pageSize) return;
  }
}

/** Collect every contact matching `query`. */
export async function collectContacts(
  api: Pick<QomonApi, 'searchContacts'>,
  query: SearchQuery,
  options: PaginateContactsOptions = {},
): Promise<QomonContact[]> {
  const out: QomonContact[] = [];
  for await (const c of paginateContacts(api, query, options)) out.push(c);
  return out;
}
