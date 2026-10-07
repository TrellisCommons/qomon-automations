import type { ListBundlesParams, QomonApi } from './api.js';
import type { QomonBundle } from './types.js';

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
