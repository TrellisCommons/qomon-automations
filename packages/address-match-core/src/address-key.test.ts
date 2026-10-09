import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addressKey, type AddressParts } from './address-key.js';

/** The expected keys from the plan (issue #1): house, door, line 2, street. */
const TABLE: Array<[string, string, string, string, string | null]> = [
  ['12-345', '', '12', 'Example Street', 'unit 12, 345 example st'],
  ['345', '', 'Unit 12', 'Example St', 'unit 12, 345 example st'],
  ['12 - 345', '', '', 'Example St', 'unit 12, 345 example st'],
  ['345', '', '', 'Example St', '345 example st'],
  ['20 - unit 4', '', '', 'Sample avenue', 'unit 4, 20 sample ave'],
  ['907', '', '', '41 Sample Rd E', 'unit 907, 41 sample rd e'],
  ['6 52', '', '', 'Test Cres', 'unit 6, 52 test cres'],
  ['18 B', '', 'B', 'Test Crescent.', 'unit b, 18 test cres'],
  ['77', '', 'Apartment C', 'Mock Dr', 'unit c, 77 mock dr'],
  ['Apt 610 - 500', '', '', 'Mock Drive', 'unit 610, 500 mock dr'],
  ['88 apt 3', '', '', 'Demo Ln', 'unit 3, 88 demo ln'],
  ['9 Demo Lane', '', '', '9 Demo Lane', '9 demo ln'],
  ['BSMT - 14', '', '', 'Sample Pl', 'unit bsmt, 14 sample pl'],
  ['33', '', 'Corner Store', 'Example Blvd N', '33 example blvd n'],
  ['', '', '', 'Example St', null],
];

interface ParityCase extends Required<{ [K in keyof AddressParts]: string }> {
  key: string | null;
}

const fixture: ParityCase[] = JSON.parse(
  readFileSync(new URL('./parity-fixture.json', import.meta.url), 'utf8'),
);

describe('addressKey', () => {
  it.each(TABLE)(
    'house %j, door %j, line 2 %j, street %j → %j',
    (house, door, line2, street, key) => {
      expect(addressKey({ house, door, line2, street })).toBe(key);
    },
  );

  it('treats missing parts as blank', () => {
    expect(addressKey({ house: '345', street: 'Example St' })).toBe(
      '345 example st',
    );
    expect(
      addressKey({ house: null, door: null, line2: null, street: null }),
    ).toBeNull();
  });

  it('a blank unit matches only a blank unit', () => {
    expect(addressKey({ house: '345', street: 'Example St' })).not.toBe(
      addressKey({ house: '345', line2: 'Unit 12', street: 'Example St' }),
    );
  });

  it('takes the unit from Door before the house number and line 2', () => {
    expect(
      addressKey({
        house: '12-345',
        door: 'B',
        line2: 'Unit 7',
        street: 'Example St',
      }),
    ).toBe('unit b, 345 example st');
  });

  it('calls a basement "bsmt"', () => {
    expect(
      addressKey({ house: '14', door: 'Basement', street: 'Sample Pl' }),
    ).toBe('unit bsmt, 14 sample pl');
  });
});

describe('parity with the Python reference', () => {
  it(`gives the reference key for all ${fixture.length} synthetic inputs`, () => {
    const mismatches = fixture
      .map((c) => ({ ...c, actual: addressKey(c) }))
      .filter((c) => c.actual !== c.key);
    expect(mismatches).toEqual([]);
  });
});

/** Realistic, invented address parts. */
const parts = fc.record({
  house: fc.oneof(
    fc.nat(9999).map(String),
    fc.tuple(fc.nat(999), fc.nat(9999)).map(([u, n]) => `${u}-${n}`),
    fc
      .tuple(fc.nat(9999), fc.constantFrom('a', 'b'))
      .map(([n, l]) => `${n} ${l}`),
    fc
      .tuple(
        fc.constantFrom('Apt', 'Unit', '#', 'Suite'),
        fc.nat(999),
        fc.nat(9999),
      )
      .map(([w, u, n]) => `${w} ${u} - ${n}`),
    fc.constant(''),
  ),
  door: fc.oneof(
    fc.constant(''),
    fc.nat(99).map(String),
    fc.constantFrom('A', 'Bsmt', 'Unit 3'),
  ),
  line2: fc.oneof(
    fc.constant(''),
    fc.constantFrom('Unit 12', 'Apartment C', 'Corner Store'),
  ),
  street: fc
    .tuple(
      fc.constantFrom('Example', 'Sample', 'Test', 'Mock', 'Saint Demo'),
      fc.constantFrom('Street', 'St', 'Avenue', 'Crescent', 'Lane', ''),
      fc.constantFrom('', 'N', 'East'),
    )
    .map((p) => p.filter(Boolean).join(' ')),
});

const shout = (p: AddressParts): AddressParts => ({
  house: p.house?.toUpperCase(),
  door: p.door?.toUpperCase(),
  line2: p.line2?.toUpperCase(),
  street: p.street?.toUpperCase(),
});

const pad = (p: AddressParts): AddressParts => {
  const spread = (s?: string | null) =>
    s ? `  ${s.replace(/ /g, '   ')}\t ` : s;
  return {
    house: spread(p.house),
    door: spread(p.door),
    line2: spread(p.line2),
    street: spread(p.street),
  };
};

describe('addressKey properties', () => {
  it('is stable under case changes', () => {
    fc.assert(
      fc.property(parts, (p) => addressKey(shout(p)) === addressKey(p)),
    );
  });

  it('is stable under spacing changes', () => {
    fc.assert(fc.property(parts, (p) => addressKey(pad(p)) === addressKey(p)));
  });

  it('matching is symmetric', () => {
    fc.assert(
      fc.property(
        parts,
        parts,
        (a, b) =>
          (addressKey(a) === addressKey(b)) ===
          (addressKey(b) === addressKey(a)),
      ),
    );
  });

  it('is deterministic and never empty', () => {
    fc.assert(
      fc.property(parts, (p) => {
        const key = addressKey(p);
        return key === addressKey(structuredClone(p)) && key !== '';
      }),
    );
  });
});
