import type {
  QomonContact,
  QomonForm,
  QomonRefValue,
} from '@trellis/qomon-client';

/** A contact's Presence answer. Qomon keeps one per contact (sandbox,
 *  2026-10): a new write replaces it. */
export interface Presence {
  value: string;
  refId: number | null;
  /** when Qomon recorded it (ISO); for an API write, the write time */
  date: string | null;
}

type Choice = QomonRefValue & { value: string };

export interface PresenceConfig {
  form: QomonForm;
  /** stored values that count as a canvass */
  canvassed: ReadonlySet<string>;
  /** the Presence value written to the rest of the household */
  household: Choice;
  /** the custom field, and its value, written with every household value;
   *  `recanvassed` replaces `value` once a person records Presence again */
  marker: { form: QomonForm; value: Choice; recanvassed: Choice };
}

export interface PresenceSettings {
  canvassedValues: readonly string[];
  householdValue: string;
  markerField: string;
  markerValue: string;
  recanvassedValue: string;
}

export class PresenceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresenceConfigError';
  }
}

const quoted = (values: Iterable<string>) =>
  [...values].map((v) => JSON.stringify(v)).join(', ');

function choiceOf(form: QomonForm, value: string): Choice | null {
  const ref = form.refvalues.find((r) => r.value === value);
  return ref ? { ...ref, value } : null;
}

/**
 * Check the space's settings against its Presence form and custom fields.
 * Qomon drops an upsert naming an unknown form or value without an error,
 * so anything missing is a configuration error that stops the run before it
 * plans anything.
 */
export function resolvePresenceConfig(
  presenceForms: QomonForm[],
  customFields: QomonForm[],
  settings: PresenceSettings,
): PresenceConfig {
  if (presenceForms.length !== 1) {
    throw new PresenceConfigError(
      `expected one Presence form, found ${presenceForms.length}`,
    );
  }
  const form = presenceForms[0]!;
  const values = form.refvalues
    .map((r) => r.value)
    .filter((v): v is string => !!v);
  if (settings.canvassedValues.length === 0) {
    throw new PresenceConfigError(
      'the space has no canvassed Presence values configured',
    );
  }
  const missing = settings.canvassedValues.filter((v) => !values.includes(v));
  if (missing.length > 0) {
    throw new PresenceConfigError(
      `canvassed values not on the Presence form: ${quoted(missing)} (the form has ${quoted(values)})`,
    );
  }
  const household = choiceOf(form, settings.householdValue);
  if (!household) {
    throw new PresenceConfigError(
      `household value ${JSON.stringify(settings.householdValue)} is not on the Presence form (the form has ${quoted(values)})`,
    );
  }

  const fields = customFields.filter((f) => f.label === settings.markerField);
  if (fields.length !== 1) {
    throw new PresenceConfigError(
      `expected one custom field labelled ${JSON.stringify(settings.markerField)}, found ${fields.length}; create it in Qomon as a single choice`,
    );
  }
  const markerForm = fields[0]!;
  if (markerForm.type !== 'radio') {
    throw new PresenceConfigError(
      `custom field ${JSON.stringify(settings.markerField)} is ${JSON.stringify(markerForm.type)}; make it single choice (radio)`,
    );
  }
  const markerValue = choiceOf(markerForm, settings.markerValue);
  if (!markerValue) {
    throw new PresenceConfigError(
      `custom field ${JSON.stringify(settings.markerField)} has no value ${JSON.stringify(settings.markerValue)} (it has ${quoted(markerForm.refvalues.map((r) => r.value ?? ''))})`,
    );
  }

  const recanvassed = choiceOf(markerForm, settings.recanvassedValue);
  if (!recanvassed) {
    throw new PresenceConfigError(
      `custom field ${JSON.stringify(settings.markerField)} has no value ${JSON.stringify(settings.recanvassedValue)} (it has ${quoted(markerForm.refvalues.map((r) => r.value ?? ''))})`,
    );
  }

  return {
    form,
    canvassed: new Set(settings.canvassedValues),
    household,
    marker: { form: markerForm, value: markerValue, recanvassed },
  };
}

export function presenceOf(
  contact: QomonContact,
  form: QomonForm,
): Presence | null {
  const answer = contact.formdatas?.find(
    (f) => f.form_id === form.id && !f.deleted_at,
  );
  if (!answer) return null;
  const ref = form.refvalues.find((r) => r.id === answer.form_ref_id);
  return {
    value: ref?.value ?? answer.data ?? '',
    refId: answer.form_ref_id ?? null,
    date: answer.date ?? null,
  };
}

function markerOf(
  contact: QomonContact,
  config: PresenceConfig,
): number | null {
  return (
    contact.custom_fields?.find((f) => f.form_id === config.marker.form.id)
      ?.form_ref_id ?? null
  );
}

/** Marked as the job's household value (not since re-marked). */
export function isMarked(
  contact: QomonContact,
  config: PresenceConfig,
): boolean {
  return markerOf(contact, config) === config.marker.value.id;
}

export function isRemarked(
  contact: QomonContact,
  config: PresenceConfig,
): boolean {
  return markerOf(contact, config) === config.marker.recanvassed.id;
}

/** For each contact the job wrote and verified, the Presence date Qomon gave
 *  that write (null when it was not recorded). */
export type OwnWrites = ReadonlyMap<number, string | null>;

export type PresenceKind =
  /** no Presence: a target when the household was canvassed */
  | 'none'
  /** the job's own household value */
  | 'written'
  /** a canvass: triggers the household */
  | 'canvassed'
  /** any other Presence: left alone, triggers nothing */
  | 'other';

/** A contact still marked as the job's whose Presence is no longer the job's
 *  write: a person recorded Presence since, so the marker should say so. */
export function needsRemark(
  contact: QomonContact,
  kind: PresenceKind,
  config: PresenceConfig,
): boolean {
  return (
    isMarked(contact, config) && (kind === 'canvassed' || kind === 'other')
  );
}

function sameInstant(a: string, b: string): boolean {
  return a === b || Date.parse(a) === Date.parse(b);
}

/**
 * What a contact's Presence means to the job. The household value is the
 * job's own only when the marker is on it and, where the job recorded the
 * write, Qomon's Presence date is still the one that write got. A marker
 * does not go away when a canvasser records Presence again (test space,
 * 2026-10-11), but the Presence date moves, so a moved date means a person
 * re-recorded it and it counts like any other visit. A marked household
 * value the job has no record of (a rebuilt database) is treated as the
 * job's: missing a household is better than triggering off its own writes.
 */
export function classifyPresence(
  contact: QomonContact,
  config: PresenceConfig,
  ownWrites: OwnWrites,
): { kind: PresenceKind; presence: Presence | null } {
  const presence = presenceOf(contact, config.form);
  if (!presence) return { kind: 'none', presence };
  if (presence.refId === config.household.id && isMarked(contact, config)) {
    const recorded =
      contact.id === undefined ? undefined : ownWrites.get(contact.id);
    if (
      recorded === undefined ||
      recorded === null ||
      presence.date === null ||
      sameInstant(recorded, presence.date)
    ) {
      return { kind: 'written', presence };
    }
  }
  return {
    kind: config.canvassed.has(presence.value) ? 'canvassed' : 'other',
    presence,
  };
}
