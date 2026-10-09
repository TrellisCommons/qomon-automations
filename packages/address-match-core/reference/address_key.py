# The household key from the Google Sheet prototype, as Python. This is the
# reference the TypeScript port in src/ must match; scripts/generate-parity.py
# runs it over synthetic inputs to produce src/parity-fixture.json.
import re
WORDS = [("street","st"),("avenue","ave"),("drive","dr"),("crescent","cres"),("cresc","cres"),
         ("road","rd"),("trail","trl"),("court","ct"),("crt","ct"),("place","pl"),("boulevard","blvd"),
         ("circle","cir"),("gardens","gdns"),("lane","ln"),("crossing","xing"),("terrace","terr"),
         ("north","n"),("south","s"),("east","e"),("west","w"),("saint","st")]
KW = r'(?:\b(?:apartment|apt|unit|suite|ste)\b|#)'
UNIT = r'^(?:(?:apartment|apt|unit|suite|ste)\.?\s*)?#?\s*([a-z]?\d+[a-z]?|[a-z]|bsmt|basement|upper|lower|main)$'

def x(p, s):
    m = re.search(p, s)
    return m.group(1) if m else None

def address_key(house, door, line2, street):
    house, door, line2, street = house or '', door or '', line2 or '', street or ''
    # street: tidy, leading number, word table
    st = ' '.join(re.sub(r'[.,]|\s+', ' ', street.lower()).split())
    street_num = x(r'^(\d+) ', st) or ''
    name = re.sub(r'^\d+ ', '', st)
    for a, b in WORDS:
        name = re.sub(r'\b' + a + r'\b', b, name)
    # house number: tidy, unit keyword
    h = ' '.join(re.sub(r'\s*-\s*', '-', re.sub(r'[.,()&]', ' ', house.lower())).split())
    h = re.sub(r'\s*-\s*', '-', h)
    kw_unit = x(KW + r'[\s#-]*([a-z0-9]+)', h) or ''
    if kw_unit:
        before = (x(r'^(.*?)' + KW, h) or '').strip(' -')
        after = (x(KW + r'[\s#-]*[a-z0-9]+(.*)$', h) or '').strip(' -')
        rest = before or after
    else:
        rest = h
    # unit-first formats and letter suffixes
    if not rest:
        h_unit = h_num = ''
    else:
        h_unit = (x(r'^(.+)-\d+[a-z]?$', rest) or x(r'^\d+-([a-z]+)$', rest)
                  or x(r'^(\S+) \d+$', rest) or x(r'^\d+ ?([a-z])$', rest))
        if h_unit is None:
            h_unit = '' if re.match(r'^\d', rest) else rest
        h_num = (x(r'^.+-(\d+[a-z]?)$', rest) or x(r'^(\d+)-[a-z]+$', rest)
                 or x(r'^\S+ (\d+)$', rest) or x(r'^(\d+) ?[a-z]$', rest) or x(r'^(\d+)', rest) or '')
    d = door.lower().strip()
    door_unit = '' if not d else (x(UNIT, d) or re.sub(r'\s', '', d))
    line2_unit = x(UNIT, line2.lower().strip()) or ''
    # unit precedence
    if door_unit:
        unit = door_unit
    elif kw_unit:
        unit = kw_unit
    elif h_unit:
        unit = h_unit
    elif street_num and h_num and h_num != street_num:
        unit = h_num
    else:
        unit = line2_unit
    if unit == 'basement':
        unit = 'bsmt'
    number = street_num or h_num
    if not number or not name:
        return None
    return (f'unit {unit}, ' if unit else '') + number + ' ' + name
