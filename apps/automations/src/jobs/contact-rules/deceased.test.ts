import type { QomonContact, QomonForm } from '@trellis/qomon-client';
import { describe, expect, it } from 'vitest';
import {
  DeceasedConfigError,
  deceasedStateOf,
  planDeceased,
  resolveDeceasedConfig,
} from './deceased.js';

const FIELD: QomonForm = {
  id: 7,
  label: 'Deceased',
  type: 'checkbox',
  refvalues: [
    { id: 71, value: 'yes', label: 'DECEASED' },
    { id: 72, value: 'no', label: 'NOT deceased' },
  ],
};
const config = resolveDeceasedConfig([FIELD], {
  deceasedField: 'Deceased',
  deceasedValue: 'yes',
})!;

let nextId = 100;
function contact(
  values: Array<'yes' | 'no'>,
  black_list?: boolean,
): QomonContact {
  return {
    id: nextId++,
    black_list,
    custom_fields: values.map((v) => ({
      form_id: FIELD.id,
      form_ref_id: v === 'yes' ? 71 : 72,
      data: v,
    })),
  };
}

describe('resolveDeceasedConfig', () => {
  it('is off without a field', () => {
    expect(
      resolveDeceasedConfig([FIELD], {
        deceasedField: null,
        deceasedValue: 'yes',
      }),
    ).toBeNull();
  });

  it('refuses a missing field, a text field, or a missing value', () => {
    const settings = { deceasedField: 'Deceased', deceasedValue: 'yes' };
    expect(() => resolveDeceasedConfig([], settings)).toThrow(
      DeceasedConfigError,
    );
    expect(() =>
      resolveDeceasedConfig([{ ...FIELD, type: 'text' }], settings),
    ).toThrow(/checkbox or single choice/);
    expect(() =>
      resolveDeceasedConfig([FIELD], { ...settings, deceasedValue: 'true' }),
    ).toThrow(/no value "true"/);
  });
});

describe('deceasedStateOf', () => {
  it('reads the field', () => {
    expect(deceasedStateOf(contact(['yes']), config)).toBe('deceased');
    expect(deceasedStateOf(contact(['yes', 'no']), config)).toBe('ambiguous');
    expect(deceasedStateOf(contact(['no']), config)).toBe('other');
    expect(deceasedStateOf(contact([]), config)).toBe('none');
  });
});

describe('planDeceased', () => {
  it('turns "Do not contact" on for a marked contact the rule has not handled', () => {
    const marked = contact(['yes']);
    const plan = planDeceased([marked, contact([])], config, new Map());
    expect(plan.writes).toEqual([marked.id]);
    expect(plan.stats).toMatchObject({ deceased: 1, deceasedPlanned: 1 });
  });

  it('records a marked contact already blacklisted as handled, writing nothing', () => {
    const marked = contact(['yes'], true);
    const plan = planDeceased([marked], config, new Map());
    expect(plan.writes).toEqual([]);
    expect(plan.found).toEqual([marked.id]);
  });

  it('leaves a handled contact alone, even once a person turns "Do not contact" off', () => {
    const overridden = contact(['yes'], false);
    const plan = planDeceased(
      [overridden],
      config,
      new Map([[overridden.id!, 'WRITTEN']]),
    );
    expect(plan.writes).toEqual([]);
    expect(plan.rearm).toEqual([]);
  });

  it('forgets a handled contact no longer marked, so marking it again acts again', () => {
    const unmarked = contact([]);
    const plan = planDeceased(
      [unmarked],
      config,
      new Map([[unmarked.id!, 'FOUND']]),
    );
    expect(plan.rearm).toEqual([unmarked.id]);
    expect(plan.review).toEqual([]);
  });

  it('asks for review when a contact the job blacklisted is no longer marked but still blacklisted', () => {
    const written = contact(['no'], true);
    const found = contact([], true);
    const plan = planDeceased(
      [written, found],
      config,
      new Map([
        [written.id!, 'WRITTEN'],
        [found.id!, 'FOUND'],
      ]),
    );
    expect(plan.rearm).toEqual([written.id, found.id]);
    expect(plan.review).toEqual([written.id]);
    expect(plan.stats).toMatchObject({
      deceasedOtherValue: 1,
      deceasedRearmed: 2,
      deceasedReview: 1,
    });
  });

  it('skips a contact with both the deceased value and another, handled or not', () => {
    const both = contact(['yes', 'no']);
    const handledBoth = contact(['yes', 'no'], true);
    const plan = planDeceased(
      [both, handledBoth],
      config,
      new Map([[handledBoth.id!, 'WRITTEN']]),
    );
    expect(plan.writes).toEqual([]);
    expect(plan.rearm).toEqual([]);
    expect(plan.stats.deceasedAmbiguous).toBe(2);
  });
});
