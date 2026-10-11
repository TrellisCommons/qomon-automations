import type { QomonContact, QomonForm } from '@trellis/qomon-client';
import { describe, expect, it } from 'vitest';
import { inMunicipality, normalizeCity, planHouseholdMatch } from './plan.js';
import { PresenceConfigError, resolvePresenceConfig } from './presence.js';

const FORM: QomonForm = {
  id: 1,
  label: 'Presence',
  type: 'radio',
  refvalues: [
    { id: 11, value: 'present', label: 'present' },
    { id: 12, value: 'absent', label: 'absent' },
    { id: 13, value: 'refus', label: 'refusal' },
    { id: 14, value: 'repasse', label: 'repasse' },
  ],
};
const MARKER: QomonForm = {
  id: 2,
  label: 'Presence source',
  type: 'radio',
  refvalues: [{ id: 21, value: 'household_match', label: 'Household match' }],
};
const CANVASSED = ['present', 'absent', 'refus', 'repasse'];
const SETTINGS = {
  canvassedValues: CANVASSED,
  householdValue: 'absent',
  markerField: 'Presence source',
  markerValue: 'household_match',
};
const config = resolvePresenceConfig([FORM], [MARKER], SETTINGS);

let nextId = 100;
function contact(
  address: Record<string, string>,
  presence?: { value: string; date?: string; marked?: boolean },
): QomonContact {
  const ref =
    presence && FORM.refvalues.find((r) => r.value === presence.value)!;
  return {
    id: (nextId += 1),
    address: { city: 'Exampleton', ...address },
    formdatas: ref
      ? [
          {
            form_id: FORM.id,
            form_ref_id: ref.id,
            data: ref.value,
            date: presence.date ?? '2026-10-01T15:00:00Z',
          },
        ]
      : [],
    custom_fields: presence?.marked
      ? [{ form_id: MARKER.id, form_ref_id: 21, data: 'household_match' }]
      : [],
  };
}

const written = (
  address: Record<string, string>,
  date = '2026-10-02T09:00:00Z',
) => contact(address, { value: 'absent', date, marked: true });

describe('planHouseholdMatch', () => {
  it('writes the household value to everyone without a Presence at a canvassed address', () => {
    const knocked = contact(
      { housenumber: '345', street: 'Example St' },
      { value: 'present' },
    );
    const a = contact({ housenumber: '345', street: 'Example Street' });
    const b = contact({ housenumber: '345', street: 'example st.' });
    const elsewhere = contact({ housenumber: '347', street: 'Example St' });
    const plan = planHouseholdMatch([knocked, a, b, elsewhere], config, null);
    expect(plan.writes).toEqual([
      {
        contactId: a.id,
        triggerContactId: knocked.id,
        triggerValue: 'present',
        triggerDate: '2026-10-01T15:00:00Z',
      },
      {
        contactId: b.id,
        triggerContactId: knocked.id,
        triggerValue: 'present',
        triggerDate: '2026-10-01T15:00:00Z',
      },
    ]);
    expect(plan.stats).toMatchObject({
      fetched: 4,
      households: 2,
      canvassedHouseholds: 1,
      planned: 2,
    });
  });

  it('rule 1: never touches a contact that has any Presence, written values included', () => {
    const knocked = contact(
      { housenumber: '9', street: 'Demo Ln' },
      { value: 'refus' },
    );
    const ours = written({ housenumber: '9', street: 'Demo Lane' });
    const canvassedToo = contact(
      { housenumber: '9', street: 'Demo Ln' },
      { value: 'repasse' },
    );
    const plan = planHouseholdMatch(
      [knocked, ours, canvassedToo],
      config,
      null,
    );
    expect(plan.writes).toEqual([]);
    expect(plan.stats.alreadyHavePresence).toBe(2);
  });

  it('a written household value never triggers further writes', () => {
    const ours = written({ housenumber: '9', street: 'Demo Ln' });
    const other = contact({ housenumber: '9', street: 'Demo Ln' });
    const own = new Map([[ours.id!, '2026-10-02T09:00:00Z']]);
    expect(planHouseholdMatch([ours, other], config, null, own).writes).toEqual(
      [],
    );
    // with no record of the write (a rebuilt database), the marker decides
    expect(planHouseholdMatch([ours, other], config, null).writes).toEqual([]);
  });

  it('an unmarked absent is a real knock', () => {
    const knocked = contact(
      { housenumber: '9', street: 'Demo Ln' },
      { value: 'absent' },
    );
    const other = contact({ housenumber: '9', street: 'Demo Ln' });
    expect(
      planHouseholdMatch([knocked, other], config, null).writes,
    ).toMatchObject([
      {
        contactId: other.id,
        triggerContactId: knocked.id,
        triggerValue: 'absent',
      },
    ]);
  });

  it('a marked absent recorded again by a canvasser is a real knock', () => {
    // the marker stays when Presence is recorded again, but its date moves
    const reknocked = written(
      { housenumber: '9', street: 'Demo Ln' },
      '2026-10-05T18:00:00Z',
    );
    const other = contact({ housenumber: '9', street: 'Demo Ln' });
    const own = new Map([[reknocked.id!, '2026-10-02T09:00:00Z']]);
    expect(
      planHouseholdMatch([reknocked, other], config, null, own).writes,
    ).toMatchObject([
      {
        contactId: other.id,
        triggerContactId: reknocked.id,
        triggerDate: '2026-10-05T18:00:00Z',
      },
    ]);
  });

  it('a marked contact with a different Presence value is a real knock', () => {
    const knocked = contact(
      { housenumber: '9', street: 'Demo Ln' },
      { value: 'repasse', marked: true },
    );
    const other = contact({ housenumber: '9', street: 'Demo Ln' });
    expect(
      planHouseholdMatch([knocked, other], config, null).writes.map(
        (w) => w.contactId,
      ),
    ).toEqual([other.id]);
  });

  it('compares recorded dates as instants', () => {
    const ours = written(
      { housenumber: '9', street: 'Demo Ln' },
      '2026-10-02T09:00:00.000000Z',
    );
    const other = contact({ housenumber: '9', street: 'Demo Ln' });
    const own = new Map([[ours.id!, '2026-10-02T09:00:00Z']]);
    expect(planHouseholdMatch([ours, other], config, null, own).writes).toEqual(
      [],
    );
  });

  it('only allowlisted values trigger', () => {
    const narrow = resolvePresenceConfig([FORM], [MARKER], {
      ...SETTINGS,
      canvassedValues: ['present'],
    });
    const knocked = contact(
      { housenumber: '9', street: 'Demo Ln' },
      { value: 'refus' },
    );
    const other = contact({ housenumber: '9', street: 'Demo Ln' });
    expect(planHouseholdMatch([knocked, other], narrow, null).writes).toEqual(
      [],
    );
  });

  it('takes the earliest canvassed Presence as the trigger', () => {
    const later = contact(
      { housenumber: '20', street: 'Sample Ave' },
      { value: 'present', date: '2026-10-05T10:00:00Z' },
    );
    const earlier = contact(
      { housenumber: '20', street: 'Sample Ave' },
      { value: 'absent', date: '2026-10-02T10:00:00Z' },
    );
    const target = contact({ housenumber: '20', street: 'Sample Ave' });
    const [write] = planHouseholdMatch(
      [later, earlier, target],
      config,
      null,
    ).writes;
    expect(write).toMatchObject({
      contactId: target.id,
      triggerContactId: earlier.id,
      triggerDate: '2026-10-02T10:00:00Z',
    });
  });

  it('a blank unit is a different address from a unit', () => {
    const knocked = contact(
      { housenumber: '345', street: 'Example St' },
      { value: 'present' },
    );
    const unit = contact({ housenumber: '12-345', street: 'Example St' });
    const line2Unit = contact({
      housenumber: '345',
      addition: 'Unit 12',
      street: 'Example St',
    });
    expect(
      planHouseholdMatch([knocked, unit, line2Unit], config, null).writes,
    ).toEqual([]);
  });

  it('matches units written different ways', () => {
    const knocked = contact(
      { housenumber: '12 - 345', street: 'Example St' },
      { value: 'present' },
    );
    const line2Unit = contact({
      housenumber: '345',
      addition: 'Unit 12',
      street: 'Example Street',
    });
    const door = contact({
      housenumber: '345',
      door: '12',
      street: 'EXAMPLE ST',
    });
    expect(
      planHouseholdMatch([knocked, line2Unit, door], config, null).writes.map(
        (w) => w.contactId,
      ),
    ).toEqual([line2Unit.id, door.id]);
  });

  it('leaves out contacts outside the municipality, and counts unkeyable ones', () => {
    const knocked = contact(
      { housenumber: '1', street: 'Mock Dr' },
      { value: 'present' },
    );
    const sameStreetOtherTown = contact({
      housenumber: '1',
      street: 'Mock Dr',
      city: 'Elsewhere',
    });
    const blankCity = contact({
      housenumber: '1',
      street: 'Mock Dr',
      city: '',
    });
    const noNumber = contact({ street: 'Mock Dr' });
    const plan = planHouseholdMatch(
      [knocked, sameStreetOtherTown, blankCity, noNumber],
      config,
      'exampleton',
    );
    expect(plan.writes.map((w) => w.contactId)).toEqual([blankCity.id]);
    expect(plan.stats).toMatchObject({ outsideMunicipality: 1, unkeyable: 1 });
  });
});

describe('municipality', () => {
  it('compares cities without case, accents, or extra spaces', () => {
    expect(normalizeCity('  Saint-Exémple  Ville ')).toBe(
      'saint-exemple ville',
    );
    expect(
      inMunicipality({ address: { city: 'EXAMPLETON' } }, 'Exampleton'),
    ).toBe(true);
    expect(inMunicipality({ address: {} }, 'Exampleton')).toBe(true);
    expect(
      inMunicipality({ address: { city: 'Exampletonville' } }, 'Exampleton'),
    ).toBe(false);
    expect(inMunicipality({ address: { city: 'Anywhere' } }, null)).toBe(true);
  });
});

describe('resolvePresenceConfig', () => {
  it('refuses a household value the form does not have', () => {
    expect(() =>
      resolvePresenceConfig([FORM], [MARKER], {
        ...SETTINGS,
        householdValue: 'Absent (household)',
      }),
    ).toThrow(/not on the Presence form/);
  });

  it('refuses canvassed values the form does not have, and an empty allowlist', () => {
    expect(() =>
      resolvePresenceConfig([FORM], [MARKER], {
        ...SETTINGS,
        canvassedValues: ['present', 'Accepted'],
      }),
    ).toThrow(/"Accepted"/);
    expect(() =>
      resolvePresenceConfig([FORM], [MARKER], {
        ...SETTINGS,
        canvassedValues: [],
      }),
    ).toThrow(PresenceConfigError);
  });

  it('allows the household value to be a canvassed value, since the marker tells them apart', () => {
    expect(
      resolvePresenceConfig([FORM], [MARKER], SETTINGS).household.value,
    ).toBe('absent');
  });

  it('needs the marker field, single choice, with the marker value', () => {
    expect(() => resolvePresenceConfig([FORM], [], SETTINGS)).toThrow(
      /found 0/,
    );
    expect(() =>
      resolvePresenceConfig(
        [FORM],
        [{ ...MARKER, type: 'checkbox' }],
        SETTINGS,
      ),
    ).toThrow(/single choice/);
    expect(() =>
      resolvePresenceConfig([FORM], [MARKER], {
        ...SETTINGS,
        markerValue: 'other',
      }),
    ).toThrow(/has no value "other"/);
  });

  it('needs exactly one Presence form', () => {
    expect(() => resolvePresenceConfig([], [MARKER], SETTINGS)).toThrow(
      /found 0/,
    );
    expect(() =>
      resolvePresenceConfig([FORM, FORM], [MARKER], SETTINGS),
    ).toThrow(/found 2/);
  });
});
