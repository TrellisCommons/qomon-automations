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

export interface PresenceConfig {
  form: QomonForm;
  /** stored values that count as a canvass */
  canvassed: ReadonlySet<string>;
  /** the refvalue written to the rest of the household */
  household: QomonRefValue & { value: string };
}

export class PresenceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresenceConfigError';
  }
}

/**
 * Check the space's configured values against its Presence form. Qomon drops
 * an upsert naming an unknown value without an error, so a missing value is
 * a configuration error that stops the run before it plans anything.
 */
export function resolvePresenceConfig(
  forms: QomonForm[],
  canvassedValues: readonly string[],
  householdValue: string,
): PresenceConfig {
  if (forms.length !== 1) {
    throw new PresenceConfigError(
      `expected one Presence form, found ${forms.length}`,
    );
  }
  const form = forms[0]!;
  const values = new Set(
    form.refvalues.map((r) => r.value).filter((v): v is string => !!v),
  );
  const known = [...values].map((v) => JSON.stringify(v)).join(', ');
  if (canvassedValues.length === 0) {
    throw new PresenceConfigError(
      'the space has no canvassed Presence values configured',
    );
  }
  const missing = canvassedValues.filter((v) => !values.has(v));
  if (missing.length > 0) {
    throw new PresenceConfigError(
      `canvassed values not on the Presence form: ${missing.map((v) => JSON.stringify(v)).join(', ')} (the form has ${known})`,
    );
  }
  const household = form.refvalues.find((r) => r.value === householdValue);
  if (!household) {
    throw new PresenceConfigError(
      `household value ${JSON.stringify(householdValue)} is not on the Presence form (the form has ${known}); add it in the space's Presence settings in Qomon`,
    );
  }
  if (canvassedValues.includes(householdValue)) {
    throw new PresenceConfigError(
      `household value ${JSON.stringify(householdValue)} is also a canvassed value, so written values would trigger further writes`,
    );
  }
  return {
    form,
    canvassed: new Set(canvassedValues),
    household: { ...household, value: householdValue },
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
