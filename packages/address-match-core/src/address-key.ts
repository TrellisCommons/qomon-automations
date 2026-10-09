/**
 * The household address key, ported from the Google Sheet prototype
 * ("Knocked addresses to voter list matcher"). Each exported function is one
 * step of the sheet so a reviewer can compare them row by row; the reference
 * is `reference/address_key.py`, and `src/parity-fixture.json` pins the port
 * to it.
 *
 * Two contacts are in the same household when their keys are equal. A blank
 * unit matches only a blank unit, so `345 example st` and
 * `unit 12, 345 example st` are different addresses.
 */

export interface AddressParts {
  /** Qomon `address.housenumber`. */
  house?: string | null;
  /** Qomon `address.door`. */
  door?: string | null;
  /** Qomon `address.addition` ("Address line 2"). */
  line2?: string | null;
  /** Qomon `address.street`. */
  street?: string | null;
}

/** The sheet's "Street words" tab, applied in order. */
export const STREET_WORDS: ReadonlyArray<readonly [string, string]> = [
  ['street', 'st'],
  ['avenue', 'ave'],
  ['drive', 'dr'],
  ['crescent', 'cres'],
  ['cresc', 'cres'],
  ['road', 'rd'],
  ['trail', 'trl'],
  ['court', 'ct'],
  ['crt', 'ct'],
  ['place', 'pl'],
  ['boulevard', 'blvd'],
  ['circle', 'cir'],
  ['gardens', 'gdns'],
  ['lane', 'ln'],
  ['crossing', 'xing'],
  ['terrace', 'terr'],
  ['north', 'n'],
  ['south', 's'],
  ['east', 'e'],
  ['west', 'w'],
  ['saint', 'st'],
];

// Python 3's `re` is Unicode-aware for str patterns: `\d` is any decimal
// digit and `\b` sits between a word character (letter, number, or `_` in
// any script) and anything else. JavaScript's are ASCII-only even with the
// `u` flag, so these spell out Python's meaning to keep the port exact.
const D = String.raw`\p{Nd}`;
const W = String.raw`[\p{L}\p{N}_]`;
const word = (w: string) => String.raw`(?<!${W})(?:${w})(?!${W})`;

const re = (source: string, flags = '') => new RegExp(source, `u${flags}`);

const KW = String.raw`(?:${word('apartment|apt|unit|suite|ste')}|#)`;
const UNIT = re(
  String.raw`^(?:(?:apartment|apt|unit|suite|ste)\.?\s*)?#?\s*([a-z]?${D}+[a-z]?|[a-z]|bsmt|basement|upper|lower|main)$`,
);
const KW_UNIT = re(KW + String.raw`[\s#-]*([a-z0-9]+)`);
const KW_BEFORE = re(String.raw`^(.*?)` + KW);
const KW_AFTER = re(KW + String.raw`[\s#-]*[a-z0-9]+(.*)$`);
const WORD_PATTERNS = STREET_WORDS.map(
  ([long, short]) => [re(word(long), 'g'), short] as const,
);

const STREET_NUMBER = re(String.raw`^(${D}+) `);
const LEADING_NUMBER = re(String.raw`^${D}+ `);
const UNIT_FIRST = [
  re(String.raw`^(.+)-${D}+[a-z]?$`),
  re(String.raw`^${D}+-([a-z]+)$`),
  re(String.raw`^(\S+) ${D}+$`),
  re(String.raw`^${D}+ ?([a-z])$`),
];
const NUMBER_AFTER_UNIT = [
  re(String.raw`^.+-(${D}+[a-z]?)$`),
  re(String.raw`^(${D}+)-[a-z]+$`),
  re(String.raw`^\S+ (${D}+)$`),
  re(String.raw`^(${D}+) ?[a-z]$`),
  re(String.raw`^(${D}+)`),
];
const STARTS_WITH_DIGIT = re(String.raw`^${D}`);

/** First capture group of the first match, or null: Python's `x(p, s)`. */
function group(pattern: RegExp, s: string): string | null {
  return pattern.exec(s)?.[1] ?? null;
}

/** Python's `x(a) or x(b) or ...`: the first non-empty group, else null. */
function firstGroup(patterns: RegExp[], s: string): string | null {
  for (const p of patterns) {
    const g = group(p, s);
    if (g) return g;
  }
  return null;
}

/** Python's `str.split()` then `' '.join(...)`. */
function collapseSpaces(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(' ');
}

/** Python's `str.strip(' -')`. */
function stripSpaceAndHyphen(s: string): string {
  return s.replace(/^[ -]+|[ -]+$/g, '');
}

/** Step 1a: lower case, drop `.` and `,`, collapse whitespace. */
export function tidyStreet(street: string): string {
  return collapseSpaces(street.toLowerCase().replace(/[.,]|\s+/g, ' '));
}

/** Step 1b: a leading number on the street ("41 Sample Rd E") is the
 *  street number; the rest is the street name. */
export function takeStreetNumber(tidyStreet: string): {
  streetNumber: string;
  name: string;
} {
  return {
    streetNumber: group(STREET_NUMBER, tidyStreet) ?? '',
    name: tidyStreet.replace(LEADING_NUMBER, ''),
  };
}

/** Step 1c: shorten street words with the sheet's table. */
export function shortenStreetWords(name: string): string {
  return WORD_PATTERNS.reduce(
    (n, [pattern, short]) => n.replace(pattern, short),
    name,
  );
}

/** Step 2a: lower case, drop `.,()&`, close up spaces around hyphens. */
export function tidyHouseNumber(house: string): string {
  const h = collapseSpaces(
    house
      .toLowerCase()
      .replace(/[.,()&]/g, ' ')
      .replace(/\s*-\s*/g, '-'),
  );
  return h.replace(/\s*-\s*/g, '-');
}

/** Step 2b: a unit after "apt", "unit", "suite", "ste", or "#", and what is
 *  left of the house number around it. */
export function takeKeywordUnit(tidyHouse: string): {
  keywordUnit: string;
  rest: string;
} {
  const keywordUnit = group(KW_UNIT, tidyHouse) ?? '';
  if (!keywordUnit) return { keywordUnit, rest: tidyHouse };
  const before = stripSpaceAndHyphen(group(KW_BEFORE, tidyHouse) ?? '');
  const after = stripSpaceAndHyphen(group(KW_AFTER, tidyHouse) ?? '');
  return { keywordUnit, rest: before || after };
}

/** Step 3: Qomon's unit-first formats (`179-295`, `3 61`, `a-39`) and letter
 *  suffixes (`34 a`, `12-b`). */
export function splitUnitFirst(rest: string): {
  houseUnit: string;
  houseNumber: string;
} {
  if (!rest) return { houseUnit: '', houseNumber: '' };
  const matched = firstGroup(UNIT_FIRST, rest);
  const houseUnit = matched ?? (STARTS_WITH_DIGIT.test(rest) ? '' : rest);
  const houseNumber = firstGroup(NUMBER_AFTER_UNIT, rest) ?? '';
  return { houseUnit, houseNumber };
}

/** Step 4a: the unit in Door. Anything that is not a recognised unit is
 *  kept with its spaces removed. */
export function unitFromDoor(door: string): string {
  const d = door.toLowerCase().trim();
  if (!d) return '';
  return group(UNIT, d) || d.replace(/\s/g, '');
}

/** Step 4b: the unit in Address line 2, only when the whole line is a unit
 *  ("Unit 12", "Apartment C"); anything else ("Corner Store") is ignored. */
export function unitFromLine2(line2: string): string {
  return group(UNIT, line2.toLowerCase().trim()) ?? '';
}

export interface UnitSources {
  doorUnit: string;
  keywordUnit: string;
  houseUnit: string;
  streetNumber: string;
  houseNumber: string;
  line2Unit: string;
}

/** Step 4c: Door, then the house number's keyword unit, then its unit-first
 *  part, then a house number that differs from the street's own number,
 *  then Address line 2. */
export function chooseUnit(s: UnitSources): string {
  let unit: string;
  if (s.doorUnit) unit = s.doorUnit;
  else if (s.keywordUnit) unit = s.keywordUnit;
  else if (s.houseUnit) unit = s.houseUnit;
  else if (
    s.streetNumber &&
    s.houseNumber &&
    s.houseNumber !== s.streetNumber
  ) {
    unit = s.houseNumber;
  } else unit = s.line2Unit;
  return unit === 'basement' ? 'bsmt' : unit;
}

/** Step 5: `unit <unit>, <number> <street>`, or null when there is no
 *  number or no street name. */
export function addressKey(parts: AddressParts): string | null {
  const { streetNumber, name: rawName } = takeStreetNumber(
    tidyStreet(parts.street ?? ''),
  );
  const name = shortenStreetWords(rawName);
  const { keywordUnit, rest } = takeKeywordUnit(
    tidyHouseNumber(parts.house ?? ''),
  );
  const { houseUnit, houseNumber } = splitUnitFirst(rest);
  const unit = chooseUnit({
    doorUnit: unitFromDoor(parts.door ?? ''),
    keywordUnit,
    houseUnit,
    streetNumber,
    houseNumber,
    line2Unit: unitFromLine2(parts.line2 ?? ''),
  });
  const number = streetNumber || houseNumber;
  if (!number || !name) return null;
  return (unit ? `unit ${unit}, ` : '') + number + ' ' + name;
}
