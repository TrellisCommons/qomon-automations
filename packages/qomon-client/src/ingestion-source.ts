import type { QomonApi } from './api.js';
import { paginateBundles } from './pagination.js';
import type { QomonBundle, QomonTransaction } from './types.js';

/**
 * "Where incremental changes come from" is deliberately abstracted behind this
 * interface (build brief, Phase 0). Today the only implementation is
 * {@link QomonPollChangeFeed}, which pages the bundle list newest-first. A
 * future S3-dump feed (Phase 1 mirror sweep 1.1) will be a second
 * implementation; the bucket name, region, object layout, a sample payload,
 * and whether the S3 feed replaces or supplements API polling are open
 * questions raised in open-questions.md and reconciled with data-model §5.
 */

export interface ChangeCursor {
  /** ISO timestamp of the newest record already ingested. */
  since: string | null;
  /** opaque, implementation-defined. */
  token?: string;
}

export interface ChangedTransaction {
  bundle: QomonBundle;
  transaction: QomonTransaction;
  /** best-effort change instant (bundle UpdatedAt / CreatedAt). */
  changedAt: string;
}

export interface ChangeBatch {
  changes: ChangedTransaction[];
  cursor: ChangeCursor;
  /** true when the source believes more is available beyond this batch. */
  hasMore: boolean;
}

export interface ChangeFeedSource {
  readonly kind: string;
  pull(cursor: ChangeCursor | null, opts?: { limit?: number }): Promise<ChangeBatch>;
}

function bundleChangedAt(b: QomonBundle): string {
  return b.UpdatedAt ?? b.CreatedAt ?? new Date(0).toISOString();
}

export class QomonPollChangeFeed implements ChangeFeedSource {
  readonly kind: string;

  constructor(
    private readonly api: Pick<QomonApi, 'listTransactionBundles'>,
    /** `kind` defaults to `'qomon-poll'`; pass one per Qomon space (e.g. a
     *  riding's own space) so each gets its own SyncCursor. */
    private readonly opts: { pageSize?: number; kind?: string } = {},
  ) {
    this.kind = opts.kind ?? 'qomon-poll';
  }

  async pull(
    cursor: ChangeCursor | null,
    opts: { limit?: number } = {},
  ): Promise<ChangeBatch> {
    const since = cursor?.since ? Date.parse(cursor.since) : null;
    const limit = opts.limit ?? 2000;
    const changes: ChangedTransaction[] = [];
    let newest = cursor?.since ?? null;
    let hasMore = false;

    for await (const bundle of paginateBundles(this.api, {
      pageSize: this.opts.pageSize,
    })) {
      const changedAt = bundleChangedAt(bundle);
      const changedMs = Date.parse(changedAt);
      // list is newest-first: once we reach records at or before the cursor we
      // have caught up.
      if (since !== null && changedMs <= since) break;
      if (newest === null || changedMs > Date.parse(newest)) newest = changedAt;
      for (const transaction of bundle.transactions) {
        changes.push({ bundle, transaction, changedAt });
      }
      if (changes.length >= limit) {
        hasMore = true;
        break;
      }
    }

    return {
      changes,
      cursor: { since: newest },
      hasMore,
    };
  }
}
