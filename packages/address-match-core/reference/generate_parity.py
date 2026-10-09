# Writes src/parity-fixture.json: synthetic address inputs and the key the
# Python reference gives each. Every street name and number is invented.
# Deterministic (fixed seed), so a regenerated fixture only changes when this
# script or the reference changes.
#
#   python3 -I reference/generate_parity.py > src/parity-fixture.json
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from address_key import address_key  # noqa: E402

rng = random.Random(20261009)

NAMES = ['Example', 'Sample', 'Test', 'Mock', 'Demo', 'Placeholder', 'Fictional',
         'Saint Example', 'North Sample', 'Rue de l’Exemple', 'Côte-Test', 'Maïs', 'West', 'Élane', 'Examplé Street']
TYPES = ['Street', 'St', 'St.', 'Avenue', 'Ave', 'avenue', 'Drive', 'Dr', 'Crescent', 'Cresc', 'Cres',
         'Road', 'Rd', 'Trail', 'Court', 'Crt', 'Ct', 'Place', 'Pl', 'Boulevard', 'Blvd', 'Circle',
         'Gardens', 'Lane', 'Ln', 'Crossing', 'Terrace', '']
DIRS = ['', '', '', 'N', 'S', 'E', 'W', 'North', 'South', 'East', 'West', 'E.']
UNIT_WORDS = ['Apt', 'apt', 'Apartment', 'Unit', 'unit', 'Suite', 'Ste', '#', 'APT.', 'Unit #']


def num():
    return str(rng.choice([rng.randint(1, 99), rng.randint(100, 999), rng.randint(1000, 99999)]))


def unit():
    return rng.choice([num(), rng.choice('ABCDabcd'), num() + rng.choice('ab'),
                       'Bsmt', 'BSMT', 'Basement', 'Upper', 'Lower', 'Main', 'rear', 'PH 2'])


def street():
    parts = [rng.choice(NAMES), rng.choice(TYPES), rng.choice(DIRS)]
    s = ' '.join(p for p in parts if p)
    if rng.random() < 0.2:
        s = num() + ' ' + s
    return messy(s)


def house():
    n, u, w = num(), unit(), rng.choice(UNIT_WORDS)
    return messy(rng.choice([
        n, n, f'{u}-{n}', f'{u} - {n}', f'{u} {n}', f'{n} {rng.choice("ABab")}', f'{n}{rng.choice("ab")}',
        f'{n}-{rng.choice(["a", "b", "rear"])}', f'{w} {u} - {n}', f'{n} {w} {u}', f'{n} ({w} {u})',
        f'{n} & {num()}', f'{w}{u}', '', f'{n}, {w} {u}', f'{u} {w} {n}', f'{n} ٣',
    ]))


def door():
    return messy(rng.choice(['', '', '', '', unit(), f'{rng.choice(UNIT_WORDS)} {unit()}', 'Side door', 'B 2']))


def line2():
    return messy(rng.choice(['', '', '', f'{rng.choice(UNIT_WORDS)} {unit()}', unit(), 'Corner Store', 'c/o Example',
                             'Rear entrance', 'PO Box 12']))


def messy(s):
    if rng.random() < 0.15:
        s = s.upper()
    if rng.random() < 0.15:
        s = '  ' + s.replace(' ', '  ') + ' '
    if rng.random() < 0.05:
        s = s.replace(' ', '\t')
    return s


cases = []
for _ in range(3000):
    h, d, l2, st = house(), door(), line2(), street()
    if rng.random() < 0.03:
        h = d = l2 = ''
    if rng.random() < 0.02:
        st = ''
    cases.append({'house': h, 'door': d, 'line2': l2, 'street': st, 'key': address_key(h, d, l2, st)})

sys.stdout.write('[\n' + ',\n'.join(json.dumps(c, ensure_ascii=False) for c in cases) + '\n]\n')
