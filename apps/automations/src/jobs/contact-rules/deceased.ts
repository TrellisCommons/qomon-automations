import type {
  QomonContact,
  QomonForm,
  QomonRefValue,
} from '@trellis/qomon-client';
import type { DeceasedHandling } from '../../generated/prisma/index.js';

/**
 * The deceased rule, as pure functions over a fetched space.
 *
 * A contact whose deceased field holds the deceased value, and no other
 * value, gets Qomon's "Do not contact" (`black_list`), which stops email,
 * calls, and door knocks. The rule acts once per marking: once it has turned
 * "Do not contact" on, or found it already on, it leaves the contact alone,
 * so a person who turns it off again wins. A run that sees the contact
 * without the mark forgets it, so marking it again acts again, unless the
 * job turned "Do not contact" on and it is still on: then a person is asked
 * to decide. Qomon's UI only lets the deceased field be edited once
 * "Do not contact" is off, which keeps a correction in that order.
 *
 * "Do not contact" is only ever turned on: an upsert cannot turn it off, and
 * undoing a mark is a person's decision.
 */

export interface DeceasedSettings {
  deceasedField: string | null;
  deceasedValue: string;
}

export interface DeceasedConfig {
  field: QomonForm;
  value: QomonRefValue & { value: string };
}

export class DeceasedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeceasedConfigError';
  }
}

/** Null when the space has the rule off. Qomon drops an upsert naming an
 *  unknown field or value without an error, so a missing one stops the run. */
export function resolveDeceasedConfig(
  customFields: QomonForm[],
  settings: DeceasedSettings,
): DeceasedConfig | null {
  if (settings.deceasedField === null) return null;
  const label = JSON.stringify(settings.deceasedField);
  const fields = customFields.filter((f) => f.label === settings.deceasedField);
  if (fields.length !== 1) {
    throw new DeceasedConfigError(
      `expected one custom field labelled ${label}, found ${fields.length}`,
    );
  }
  const field = fields[0]!;
  if (field.type !== 'checkbox' && field.type !== 'radio') {
    throw new DeceasedConfigError(
      `custom field ${label} is ${JSON.stringify(field.type)}; it must be a checkbox or single choice`,
    );
  }
  const ref = field.refvalues.find(
    (r): r is DeceasedConfig['value'] => r.value === settings.deceasedValue,
  );
  if (!ref) {
    throw new DeceasedConfigError(
      `custom field ${label} has no value ${JSON.stringify(settings.deceasedValue)} (it has ${field.refvalues.map((r) => JSON.stringify(r.value ?? '')).join(', ')})`,
    );
  }
  return { field, value: ref };
}

export type DeceasedState =
  /** the deceased value and nothing else */
  | 'deceased'
  /** the deceased value alongside another value of a checkbox */
  | 'ambiguous'
  /** only other values, such as a "no" option */
  | 'other'
  | 'none';

export function deceasedStateOf(
  contact: QomonContact,
  config: DeceasedConfig,
): DeceasedState {
  const answers = (contact.custom_fields ?? []).filter(
    (f) => f.form_id === config.field.id && !f.deleted_at,
  );
  if (answers.length === 0) return 'none';
  const marked = answers.some((f) => f.form_ref_id === config.value.id);
  const other = answers.some((f) => f.form_ref_id !== config.value.id);
  if (marked) return other ? 'ambiguous' : 'deceased';
  return 'other';
}

/** What the rule has done about a contact, as `handled_deceased` records it. */
export interface HandledContact {
  handling: DeceasedHandling;
  /** for REVIEW: Slack has listed it */
  notified: boolean;
}

export type Handled = ReadonlyMap<number, HandledContact>;

export interface DeceasedPlanStats {
  deceased: number;
  /** marked with the deceased value and another value; left alone */
  deceasedAmbiguous: number;
  /** holding only another value of the field, such as "no" */
  deceasedOtherValue: number;
}

/** Each list holds contact ids, sorted. */
export interface DeceasedPlan {
  /** turn "Do not contact" on; recorded SENT as each upsert goes out */
  writes: number[];
  /** marked and already blocklisted by someone else: record FOUND */
  found: number[];
  /** marked and blocklisted by the job: record WRITTEN */
  written: number[];
  /** blocklisted by the job, no longer marked, still blocklisted: record
   *  REVIEW, for a person to decide whether to turn it off */
  review: number[];
  /** no longer marked, and nothing left to decide: forget, so marking the
   *  contact again acts again */
  forget: number[];
  /** REVIEW contacts Slack has not listed yet */
  notify: number[];
  stats: DeceasedPlanStats;
}

export function planDeceased(
  contacts: readonly QomonContact[],
  config: DeceasedConfig,
  handled: Handled,
): DeceasedPlan {
  const plan: DeceasedPlan = {
    writes: [],
    found: [],
    written: [],
    review: [],
    forget: [],
    notify: [],
    stats: { deceased: 0, deceasedAmbiguous: 0, deceasedOtherValue: 0 },
  };
  for (const contact of contacts) {
    const id = contact.id;
    if (id === undefined) continue;
    const state = deceasedStateOf(contact, config);
    if (state === 'ambiguous') {
      plan.stats.deceasedAmbiguous += 1;
      continue;
    }
    const prior = handled.get(id);
    const blocklisted = contact.black_list === true;
    if (state === 'deceased') {
      plan.stats.deceased += 1;
      planMarked(plan, id, prior, blocklisted);
      continue;
    }
    if (state === 'other') plan.stats.deceasedOtherValue += 1;
    if (prior) planUnmarked(plan, id, prior, blocklisted);
  }
  for (const list of [
    plan.writes,
    plan.found,
    plan.written,
    plan.review,
    plan.forget,
    plan.notify,
  ])
    list.sort((a, b) => a - b);
  return plan;
}

function planMarked(
  plan: DeceasedPlan,
  id: number,
  prior: HandledContact | undefined,
  blocklisted: boolean,
): void {
  switch (prior?.handling) {
    case undefined:
      (blocklisted ? plan.found : plan.writes).push(id);
      return;
    // A SENT write that shows up late is the job's. One that never showed
    // up is sent again.
    case 'SENT':
    case 'REVIEW':
      (blocklisted ? plan.written : plan.writes).push(id);
      return;
    case 'WRITTEN':
    case 'FOUND':
      return;
  }
}

function planUnmarked(
  plan: DeceasedPlan,
  id: number,
  prior: HandledContact,
  blocklisted: boolean,
): void {
  if (!blocklisted || prior.handling === 'FOUND') {
    plan.forget.push(id);
    return;
  }
  if (prior.handling === 'REVIEW') {
    if (!prior.notified) plan.notify.push(id);
    return;
  }
  plan.review.push(id);
  plan.notify.push(id);
}
