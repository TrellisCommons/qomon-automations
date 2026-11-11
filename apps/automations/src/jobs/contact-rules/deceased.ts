import type {
  QomonContact,
  QomonForm,
  QomonRefValue,
} from '@trellis/qomon-client';

/**
 * The deceased rule, as pure functions over a fetched space.
 *
 * A contact whose deceased field holds the deceased value, and no other
 * value, gets Qomon's "Do not contact" (`black_list`), which stops email,
 * calls, and door knocks. The rule acts once per marking: once it has turned
 * "Do not contact" on, or found it already on, it leaves the contact alone,
 * so a person who turns it off again wins. A run that sees the contact
 * without the mark forgets it, so marking it again acts again. Qomon's UI
 * only lets the deceased field be edited once "Do not contact" is off, which
 * keeps a correction in that order.
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
  const ref = field.refvalues.find((r) => r.value === settings.deceasedValue);
  if (!ref) {
    throw new DeceasedConfigError(
      `custom field ${label} has no value ${JSON.stringify(settings.deceasedValue)} (it has ${field.refvalues.map((r) => JSON.stringify(r.value ?? '')).join(', ')})`,
    );
  }
  return { field, value: { ...ref, value: settings.deceasedValue } };
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

export function isBlacklisted(contact: QomonContact): boolean {
  return contact.black_list === true;
}

export type Handled = ReadonlyMap<number, 'WRITTEN' | 'FOUND'>;

export interface DeceasedPlanStats {
  deceased: number;
  /** marked with the deceased value and another value; left alone */
  deceasedAmbiguous: number;
  /** holding only another value of the field, such as "no" */
  deceasedOtherValue: number;
  /** "Do not contact" turnings-on to write */
  deceasedPlanned: number;
  /** marks forgotten because the contact is no longer marked */
  deceasedRearmed: number;
  /** of those, contacts the job blacklisted that are still blacklisted */
  deceasedReview: number;
}

export interface DeceasedPlan {
  /** contacts to turn "Do not contact" on for */
  writes: number[];
  /** marked and already blacklisted: record as handled, write nothing */
  found: number[];
  /** handled before but no longer marked: forget */
  rearm: number[];
  /** rearmed contacts the job blacklisted that are still blacklisted: a
   *  person should decide whether to turn "Do not contact" off */
  review: number[];
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
    rearm: [],
    review: [],
    stats: {
      deceased: 0,
      deceasedAmbiguous: 0,
      deceasedOtherValue: 0,
      deceasedPlanned: 0,
      deceasedRearmed: 0,
      deceasedReview: 0,
    },
  };
  for (const contact of contacts) {
    const id = contact.id;
    if (id === undefined) continue;
    const state = deceasedStateOf(contact, config);
    const handling = handled.get(id);
    if (state === 'ambiguous') {
      plan.stats.deceasedAmbiguous += 1;
      continue;
    }
    if (state === 'deceased') {
      plan.stats.deceased += 1;
      if (handling) continue;
      if (isBlacklisted(contact)) plan.found.push(id);
      else plan.writes.push(id);
      continue;
    }
    if (state === 'other') plan.stats.deceasedOtherValue += 1;
    if (handling) {
      plan.rearm.push(id);
      if (handling === 'WRITTEN' && isBlacklisted(contact))
        plan.review.push(id);
    }
  }
  for (const list of [plan.writes, plan.found, plan.rearm, plan.review])
    list.sort((a, b) => a - b);
  plan.stats.deceasedPlanned = plan.writes.length;
  plan.stats.deceasedRearmed = plan.rearm.length;
  plan.stats.deceasedReview = plan.review.length;
  return plan;
}
