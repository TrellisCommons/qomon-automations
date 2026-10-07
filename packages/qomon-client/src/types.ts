import { z } from 'zod';

/**
 * Qomon REST shapes. Grounded in the confidential OpenAPI digest
 * (research/qomon-api-reference.md) AND probed against the live sandbox
 * 2026-09-10; where they disagree the sandbox wins and the difference is
 * recorded in open-questions.md. Notable live facts:
 *  - the success envelope is `{status:"success", data, total?}`
 *  - bundles and items DO carry `group_id`, `CreatedAt`, `UpdatedAt`
 *  - transactions DO expose a readable `status_id`
 *  - transaction status `kind` can be a value outside the documented enum
 *    (the sandbox has `cancel`), so we keep it an open string
 *  - transactions carry a staff-editable `extra_json` custom-fields object
 *    (assumption A1 / R1 superseded 2026-09; see transaction-extra-fields.ts)
 */

export const QomonSuccess = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    status: z.literal('success'),
    data,
    total: z.number().optional(),
  });

/** RFC7807-ish error body observed on the sandbox; older docs describe a bare
 *  `{status:"fail"}`, still tolerated by the client. */
export const QomonErrorBody = z.union([
  z.object({
    title: z.string().optional(),
    status: z.number().optional(),
    detail: z.string().optional(),
  }),
  z.object({ status: z.literal('fail') }),
]);
export type QomonErrorBody = z.infer<typeof QomonErrorBody>;

export const QomonContactSummary = z
  .object({
    id: z.number().int(),
    group_id: z.number().int().optional(),
    firstname: z.string().nullish(),
    surname: z.string().nullish(),
  })
  .passthrough();

export const QomonTransaction = z
  .object({
    id: z.number().int(),
    group_id: z.number().int().optional(),
    transaction_bundle_id: z.number().int().optional(),
    CreatedAt: z.string().optional(),
    UpdatedAt: z.string().optional(),
    amount: z.number().int(),
    currency: z.string(),
    payment_method_kind: z.string().nullish(),
    contact_id: z.number().int(),
    date: z.string(),
    code_campaign: z.string().nullish(),
    comment: z.string().nullish(),
    delivered_at: z.string().nullish(),
    delivery_token: z.string().nullish(),
    reimbursed_amount: z.number().int().nullish(),
    unpaid_amount: z.number().int().nullish(),
    external_transaction_id: z.number().int().nullish(),
    status_id: z.number().int().nullish(),
    /** Qomon's real staff-editable custom fields (2026-08/09 investigation:
     *  the named columns discussed with Qomon and this tool's originally-
     *  planned envelope shape both never shipped). A flat object keyed by
     *  literal UI field labels, defaulting to `{}` until something writes to
     *  it; typed loosely here and parsed with transaction-extra-fields.ts's
     *  qomonToSyncedFields. */
    extra_json: z.unknown().nullish(),
  })
  .passthrough();
export type QomonTransaction = z.infer<typeof QomonTransaction>;

export const QomonDonation = z
  .object({
    id: z.number().int(),
    contact_id: z.number().int(),
    date: z.string(),
    amount: z.number().int(),
    currency: z.string(),
    donation_price_id: z.number().int().nullish(),
    comment: z.string().nullish(),
  })
  .passthrough();

export const QomonMembership = z
  .object({
    id: z.number().int(),
    contact_id: z.number().int(),
    amount: z.number().int(),
    currency: z.string(),
  })
  .passthrough();

export const QomonBundle = z
  .object({
    id: z.number().int(),
    group_id: z.number().int().optional(),
    CreatedAt: z.string().optional(),
    UpdatedAt: z.string().optional(),
    transactions: z.array(QomonTransaction).default([]),
    donations: z.array(QomonDonation).default([]),
    memberships: z.array(QomonMembership).default([]),
    summary: z
      .object({
        transactions_count: z.number().int().optional(),
        donations_count: z.number().int().optional(),
        memberships_count: z.number().int().optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();
export type QomonBundle = z.infer<typeof QomonBundle>;

export const QomonTransactionStatus = z
  .object({
    id: z.number().int(),
    name: z.string(),
    color: z.string().nullish(),
    archived: z.boolean().optional(),
    /** Documented enum is valid|unpaid|reimbursed|bank_error|other; the
     *  sandbox also returns `cancel`. Keep it open, resolve logic by kind. */
    kind: z.string(),
  })
  .passthrough();
export type QomonTransactionStatus = z.infer<typeof QomonTransactionStatus>;

export const QomonCodeCampaign = z
  .object({ code: z.string() })
  .passthrough();
export type QomonCodeCampaign = z.infer<typeof QomonCodeCampaign>;

export const QomonTransactionSettings = z
  .object({
    payment_method_kinds: z.array(z.string()).default([]),
    currency: z.string().optional(),
    default_status_id: z.number().int().nullish(),
    max_batch_size: z.number().int().nullish(),
  })
  .passthrough();
export type QomonTransactionSettings = z.infer<typeof QomonTransactionSettings>;

export const QomonHistoryEntry = z
  .object({
    id: z.number().int().optional(),
    CreatedAt: z.string().optional(),
    transaction_bundle_id: z.number().int().optional(),
    kind: z.string().optional(),
    target_id: z.number().int().optional(),
    old: z.unknown().nullable().optional(),
    new: z.unknown().nullable().optional(),
  })
  .passthrough();
export type QomonHistoryEntry = z.infer<typeof QomonHistoryEntry>;

/** Full Qomon Contact (subset the tool touches). PATCH is a full replace, so
 *  the guarded writer requires the whole object. */
export const QomonContact = z
  .object({
    id: z.number().int().optional(),
    firstname: z.string().nullish(),
    surname: z.string().nullish(),
    married_name: z.string().nullish(),
    mail: z.string().nullish(),
    phone: z.string().nullish(),
    mobile: z.string().nullish(),
    address: z
      .object({
        housenumber: z.string().nullish(),
        street: z.string().nullish(),
        postalcode: z.string().nullish(),
        city: z.string().nullish(),
        state: z.string().nullish(),
        country: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    black_list: z.boolean().optional(),
  })
  .passthrough();
export type QomonContact = z.infer<typeof QomonContact>;
