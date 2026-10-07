/** The tax-receipts tool's descriptive metadata, inlined from
 *  `@gpo/tax-receipts-core` (not copied here) so this package has no
 *  dependency on the tax-receipts domain. Only the fields Qomon stores. */
interface GpoMetadataDescriptive {
  period_id: number;
  riding_number: number | null;
  entity_kind: 'CA' | 'CAMPAIGN' | 'PARTY' | 'LEADERSHIP';
  goods_services: boolean;
  processed_date: string | null;
  source_code: string;
}

/**
 * Qomon's real custom fields on a transaction's `extra_json`, confirmed
 * 2026-09 from the PSM space's "add/edit transaction" form (live HTML) and a
 * real submitted payload. Supersedes both the named-fields plan from the
 * 2026-08 email thread with Qomon and this tool's originally-built {v, gpo}
 * envelope: neither shipped. `extra_json` is a flat object keyed by these
 * literal UI labels, editable by Qomon staff directly through that form —
 * not an opaque blob owned exclusively by this tool.
 *
 * Five of GpoMetadataDescriptive's fields have no Qomon counterpart at all
 * and stay tool-local only, never written to or read from Qomon:
 * `received_by` (derived at intake — see intake/defaults.ts, and confirmed
 * unnecessary here since it's determined from the entry space, not the
 * transaction), `eo_contributor_id`, `exception_reason`,
 * `non_deductible_cents`, `external_ref`.
 *
 * Qomon's "Political Entity Type" dropdown's "Leadership Contestant" maps to
 * LEADERSHIP. Which contestant is tool-local (`leadership_contestant_id`):
 * Qomon has no field for it, so an imported leadership contribution arrives
 * with none and rule A2 flags it until an operator names the contestant.
 *
 * Three more Qomon-owned keys exist in the same object but are NOT this
 * tool's to read or write: "Reported to EO On" (likely an RTD-filing echo —
 * a separate future write path, once one exists), "Target Entity", and
 * "Contributor Address Snapshot" (purpose unconfirmed). Every write MUST
 * merge onto the transaction's current extra_json rather than replacing it
 * wholesale, or it would silently erase those fields (Qomon's PATCH
 * re-validates and replaces the whole transaction item, the same way it
 * requires amount/contact_id/date resent on every metadata-only edit).
 */

const SOURCE_CODE = 'Source Code';
const PROCESSED_DATE = 'Accounting Deposit Date';
const PERIOD_ID = 'EO Contribution Period';
const GOODS_SERVICES = 'Contribution Type';
const ENTITY_KIND = 'Political Entity Type';
const RIDING_NUMBER = 'Electoral District (Riding) Number';

const ENTITY_KIND_TO_QOMON: Record<GpoMetadataDescriptive['entity_kind'], string> = {
  PARTY: 'Party',
  CA: 'Association',
  CAMPAIGN: 'Candidate',
  LEADERSHIP: 'Leadership Contestant',
};

const ENTITY_KIND_FROM_QOMON: Record<string, GpoMetadataDescriptive['entity_kind']> = {
  Party: 'PARTY',
  Association: 'CA',
  Candidate: 'CAMPAIGN',
  'Leadership Contestant': 'LEADERSHIP',
};

/** The subset of GpoMetadataDescriptive that actually lives in Qomon. */
export type QomonSyncedFields = Pick<
  GpoMetadataDescriptive,
  'period_id' | 'riding_number' | 'entity_kind' | 'goods_services' | 'processed_date' | 'source_code'
>;

export const QOMON_SYNCED_FIELD_KEYS: readonly (keyof QomonSyncedFields)[] = [
  'period_id',
  'riding_number',
  'entity_kind',
  'goods_services',
  'processed_date',
  'source_code',
];

/** Translate this tool's synced fields into Qomon's flat, label-keyed shape.
 *  Merge the result onto the transaction's EXISTING extra_json before
 *  PATCHing (see the module doc) — never send this object alone. */
export function syncedFieldsToQomon(d: QomonSyncedFields): Record<string, unknown> {
  return {
    [SOURCE_CODE]: d.source_code,
    [PROCESSED_DATE]: d.processed_date,
    [PERIOD_ID]: String(d.period_id),
    [GOODS_SERVICES]: d.goods_services ? 'In Kind' : 'Monetary',
    [ENTITY_KIND]: ENTITY_KIND_TO_QOMON[d.entity_kind],
    // riding_number is null for party-level contributions; representation of
    // "no riding" unconfirmed against the live API, null is the best guess
    // for a number-typed field.
    [RIDING_NUMBER]: d.riding_number != null ? String(d.riding_number).padStart(3, '0') : null,
  };
}

/** Translate Qomon's flat extra_json back into this tool's synced fields.
 *  Returns null if it isn't an object, or any of this tool's six fields is
 *  missing or holds a value this tool doesn't recognize (an unmapped
 *  entity type, for instance) — treated the same as
 *  "no metadata set yet" rather than guessing at a partial result. */
export function qomonToSyncedFields(raw: unknown): QomonSyncedFields | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const sourceCode = obj[SOURCE_CODE];
  if (typeof sourceCode !== 'string') return null;

  const processedDateRaw = obj[PROCESSED_DATE];
  const processedDate: string | null =
    processedDateRaw == null || processedDateRaw === '' ? null : (processedDateRaw as never);
  if (processedDate !== null && typeof processedDate !== 'string') return null;

  const periodId = toInt(obj[PERIOD_ID]);
  if (periodId === undefined) return null;

  const goodsServicesRaw = obj[GOODS_SERVICES];
  const goodsServices =
    goodsServicesRaw === 'In Kind' ? true : goodsServicesRaw === 'Monetary' ? false : undefined;
  if (goodsServices === undefined) return null;

  const entityKindRaw = obj[ENTITY_KIND];
  const entityKind =
    typeof entityKindRaw === 'string' ? ENTITY_KIND_FROM_QOMON[entityKindRaw] : undefined;
  if (!entityKind) return null;

  const ridingRaw = obj[RIDING_NUMBER];
  let ridingNumber: number | null;
  if (ridingRaw == null || ridingRaw === '') {
    ridingNumber = null;
  } else {
    const n = toInt(ridingRaw);
    if (n === undefined) return null;
    ridingNumber = n;
  }

  return {
    source_code: sourceCode,
    processed_date: processedDate,
    period_id: periodId,
    goods_services: goodsServices,
    entity_kind: entityKind,
    riding_number: ridingNumber,
  };
}

function toInt(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isInteger(n) ? n : undefined;
}

/** True when the synced-field subset of two descriptive objects differ. */
export function syncedFieldsChanged(a: QomonSyncedFields, b: QomonSyncedFields): boolean {
  return QOMON_SYNCED_FIELD_KEYS.some((k) => a[k] !== b[k]);
}
