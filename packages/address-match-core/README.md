# @trellis/address-match-core

Pure address parsing for the household match: `addressKey` turns a Qomon contact's house number, door, address line 2, and street into a key, and two contacts are in the same household when their keys are equal. No I/O.

It is a port of the Google Sheet prototype ("Knocked addresses to voter list matcher"), one exported function per step of the sheet:

| Step | Function |
|---|---|
| 1. Tidy the street, take a leading number off it, shorten street words | `tidyStreet`, `takeStreetNumber`, `shortenStreetWords` (`STREET_WORDS`) |
| 2. Tidy the house number; pull a unit after "apt", "unit", "suite", "ste", or "#" | `tidyHouseNumber`, `takeKeywordUnit` |
| 3. Split unit-first formats (`179 - 295`, `3 61`, `A - 39`) and letter suffixes (`34 A`) | `splitUnitFirst` |
| 4. Take the unit from Door, then the house number, then Address line 2 | `unitFromDoor`, `unitFromLine2`, `chooseUnit` |
| 5. Build the key; a blank unit matches only a blank unit | `addressKey` |

## Parity with the sheet

`reference/address_key.py` is the sheet's logic as Python. `reference/generate_parity.py` runs it over 3,000 invented addresses (fixed seed) and writes `src/parity-fixture.json`; the tests require the TypeScript to give the same key for every one, plus the expected keys listed in issue #1. Fast-check property tests check that a key is stable under case and spacing changes.

Python's `re` is Unicode-aware (`\d` is any decimal digit, `\b` treats accented letters as word characters) and JavaScript's is not, so the port spells those out with Unicode property escapes. The fixture includes accented street names and a non-ASCII digit to hold that.

After changing either side:

```bash
pnpm --filter @trellis/address-match-core parity:generate
pnpm --filter @trellis/address-match-core test
```
