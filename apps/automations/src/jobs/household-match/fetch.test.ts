import { describe, expect, it } from 'vitest';
import { streetQueries, streetStem } from './fetch.js';

describe('streetStem', () => {
  it.each([
    ['Example St', 'Example'],
    ['345 Example Street', 'Example'],
    ['12A Example St', 'Example'],
    ['12-14 Example St', 'Example'],
    ['  example st.', 'example'],
    ['1st Ave', '1st'],
    ['12 1st Ave', '1st'],
    ["O'Example Cres", "O'Example"],
    ['', null],
    ['345', null],
  ])('%j -> %j', (street, stem) => {
    expect(streetStem(street)).toBe(stem);
  });
});

describe('streetQueries', () => {
  it('ORs each stem in three cases, with and without the number', () => {
    const [query, ...rest] = streetQueries(
      new Map([['example', new Set(['345'])]]),
    );
    expect(rest).toEqual([]);
    const values = (
      query as {
        $all: { $at_least_one: { $condition: { value: string } }[] }[];
      }
    ).$all[0]!.$at_least_one.map((c) => c.$condition.value);
    expect(values.sort()).toEqual(
      ['Example', '345 Example', 'example', '345 example'].sort(),
    );
  });

  it('splits many streets across requests', () => {
    const streets = new Map(
      Array.from({ length: 30 }, (_, i) => [`Street${i}`, new Set(['1'])]),
    );
    // "Street0" is already capitalized, so 30 stems x 2 cases x 2 (with and
    // without the number) = 120 conditions, 50 to a request
    expect(streetQueries(streets)).toHaveLength(3);
  });
});
