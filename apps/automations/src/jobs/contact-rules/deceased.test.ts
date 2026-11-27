import type { QomonContact, QomonForm } from '@trellis/qomon-client';
import { describe, expect, it } from 'vitest';
import type { DeceasedHandling } from '../../generated/prisma/index.js';
import {
  DeceasedConfigError,
  deceasedStateOf,
  planDeceased,
  resolveDeceasedConfig,
  type DeceasedPlan,
  type Handled,
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

  it('refuses a missing field, two fields with the label, a text field, or a missing value', () => {
    const settings = { deceasedField: 'Deceased', deceasedValue: 'yes' };
    expect(() => resolveDeceasedConfig([], settings)).toThrow(
      DeceasedConfigError,
    );
    expect(() =>
      resolveDeceasedConfig([FIELD, { ...FIELD, id: 8 }], settings),
    ).toThrow(/found 2/);
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

  it('ignores a deleted answer', () => {
    const deleted = contact(['yes']);
    deleted.custom_fields![0]!.deleted_at = '2026-10-01T15:00:00Z';
    expect(deceasedStateOf(deleted, config)).toBe('none');
    expect(planDeceased([deleted], config, new Map()).writes).toEqual([]);
  });
});

function handled(
  entries: Array<[QomonContact, DeceasedHandling, boolean?]>,
): Handled {
  return new Map(
    entries.map(([c, handling, notified = false]) => [
      c.id!,
      { handling, notified },
    ]),
  );
}

/** the one list of the plan a contact lands in, or none */
function listOf(plan: DeceasedPlan, c: QomonContact): string[] {
  return (['writes', 'found', 'written', 'review', 'forget'] as const).filter(
    (k) => plan[k].includes(c.id!),
  );
}

describe('planDeceased', () => {
  it.each<
    [string, Array<'yes' | 'no'>, boolean, DeceasedHandling | null, string[]]
  >([
    ['marked, not handled', ['yes'], false, null, ['writes']],
    [
      'marked, not handled, already blocklisted',
      ['yes'],
      true,
      null,
      ['found'],
    ],
    ['marked, sent, landed late', ['yes'], true, 'SENT', ['written']],
    ['marked, sent, never landed', ['yes'], false, 'SENT', ['writes']],
    ['marked, written, a person turned it off', ['yes'], false, 'WRITTEN', []],
    ['marked, found', ['yes'], true, 'FOUND', []],
    ['marked again while under review', ['yes'], true, 'REVIEW', ['written']],
    [
      'marked again after a person turned it off',
      ['yes'],
      false,
      'REVIEW',
      ['writes'],
    ],
    ['unmarked, found', [], true, 'FOUND', ['forget']],
    ['unmarked, written, still blocklisted', [], true, 'WRITTEN', ['review']],
    ['unmarked, sent, landed', ['no'], true, 'SENT', ['review']],
    [
      'unmarked, written, a person turned it off',
      [],
      false,
      'WRITTEN',
      ['forget'],
    ],
    [
      'unmarked, under review, a person turned it off',
      [],
      false,
      'REVIEW',
      ['forget'],
    ],
    ['unmarked, under review, undecided', [], true, 'REVIEW', []],
    ['both values, handled', ['yes', 'no'], true, 'WRITTEN', []],
    ['both values, not handled', ['yes', 'no'], false, null, []],
  ])('%s', (_, values, blocklisted, handling, lists) => {
    const c = contact(values, blocklisted);
    const plan = planDeceased(
      [c],
      config,
      handled(handling ? [[c, handling]] : []),
    );
    expect(listOf(plan, c)).toEqual(lists);
  });

  it('lists a contact under review in Slack until Slack has taken it', () => {
    const fresh = contact([], true);
    const pending = contact([], true);
    const listed = contact([], true);
    const plan = planDeceased(
      [fresh, pending, listed],
      config,
      handled([
        [fresh, 'WRITTEN'],
        [pending, 'REVIEW', false],
        [listed, 'REVIEW', true],
      ]),
    );
    expect(plan.notify).toEqual([fresh.id, pending.id]);
  });

  it('counts marked, ambiguous, and other-value contacts', () => {
    const plan = planDeceased(
      [contact(['yes']), contact(['yes', 'no']), contact(['no']), contact([])],
      config,
      new Map(),
    );
    expect(plan.stats).toEqual({
      deceased: 1,
      deceasedAmbiguous: 1,
      deceasedOtherValue: 1,
    });
  });
});
