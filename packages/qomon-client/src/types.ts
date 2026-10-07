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

export const QomonCodeCampaign = z.object({ code: z.string() }).passthrough();
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

/** Qomon's examples show some address parts (house number, postal code,
 *  floor) as numbers; accept either and normalize to a string. */
const looseString = z
  .union([z.string(), z.number().transform((n) => String(n))])
  .nullish();

/** One answer to a form (Presence, consent, survey, ...) on a contact: a
 *  contact (`contact_id`) picked a refvalue (`form_ref_id`) of a form
 *  (`form_id`). */
export const QomonFormData = z
  .object({
    id: z.number().int().optional(),
    form_id: z.number().int(),
    form_ref_id: z.number().int().nullish(),
    data: z.string().nullish(),
    date: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
    deleted_at: z.string().nullish(),
  })
  .passthrough();
export type QomonFormData = z.infer<typeof QomonFormData>;

/** Full Qomon Contact (subset the tool touches). PATCH is a full replace, so
 *  the guarded writer requires the whole object. */
export const QomonContact = z
  .object({
    id: z.number().int().optional(),
    CreatedAt: z.string().optional(),
    UpdatedAt: z.string().optional(),
    firstname: z.string().nullish(),
    surname: z.string().nullish(),
    married_name: z.string().nullish(),
    mail: z.string().nullish(),
    phone: z.string().nullish(),
    mobile: z.string().nullish(),
    address: z
      .object({
        housenumber: looseString,
        street: looseString,
        /** Qomon's "Address line 2". */
        addition: looseString,
        building: looseString,
        floor: looseString,
        door: looseString,
        postalcode: looseString,
        city: looseString,
        state: looseString,
        country: looseString,
      })
      .passthrough()
      .nullish(),
    black_list: z.boolean().optional(),
    /** Answers to every form except custom fields; Presence is one of them. */
    formdatas: z.array(QomonFormData).nullish(),
  })
  .passthrough();
export type QomonContact = z.infer<typeof QomonContact>;

export const QOMON_FORM_TYPES = [
  'consent',
  'level_of_support',
  'presence_status',
  'custom_fields',
  'survey',
  'tasks',
] as const;
export type QomonFormType = (typeof QOMON_FORM_TYPES)[number];

/** One accepted value of a form. A write names the value by `value`; a
 *  contact's formdata points at it by `id` (`form_ref_id`). */
export const QomonRefValue = z
  .object({
    id: z.number().int(),
    form_id: z.number().int().optional(),
    label: z.string().nullish(),
    value: z.string().nullish(),
  })
  .passthrough();
export type QomonRefValue = z.infer<typeof QomonRefValue>;

export const QomonForm = z
  .object({
    id: z.number().int(),
    label: z.string().nullish(),
    type: z.string().nullish(),
    refvalues: z.array(QomonRefValue).default([]),
  })
  .passthrough();
export type QomonForm = z.infer<typeof QomonForm>;

/** An answer to a form in an upsert, naming the form by id or label. */
export interface QomonFormAnswer {
  id?: number;
  label?: string;
  value: string;
  [k: string]: unknown;
}

/**
 * Body of `POST /contacts/upsert` (sent as `{kind: 'contact', data}`).
 * `id` is required here although Qomon does not require it: without one,
 * Qomon matches on email and name, or on name and address, and may update a
 * different contact or create a new one.
 */
export interface QomonContactUpsert {
  id: number;
  firstname?: string;
  surname?: string;
  mail?: string;
  address?: Record<string, string>;
  name_presences?: QomonFormAnswer[];
  status?: QomonFormAnswer[];
  consents?: QomonFormAnswer[];
  forms?: QomonFormAnswer[];
  custom_fields?: QomonFormAnswer[];
  actions?: QomonFormAnswer[];
  [k: string]: unknown;
}
