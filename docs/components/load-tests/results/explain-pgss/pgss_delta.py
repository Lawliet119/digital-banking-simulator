import re, json, sys


def load(p):
    t = open(p, encoding='utf8').read()
    m = re.search(r'\t(\[\{.*\}\])\t?', t, re.S)
    rows = json.loads(m.group(1).split('\tSQL>')[0])
    return {r['queryid']: r for r in rows}


a = load(sys.argv[1])
b = load(sys.argv[2])
tot = 0
print(f"{'role':11} {'calls':>7} {'delta_s':>8} {'mean_ms':>8} {'buf/call':>9}  query")
for qid, rb in b.items():
    ra = a.get(qid)
    dc = int(rb['calls']) - (int(ra['calls']) if ra else 0)
    dt = float(rb['total_ms']) - (float(ra['total_ms']) if ra else 0.0)
    dh = int(rb['hit']) - (int(ra['hit']) if ra else 0)
    if dc <= 0:
        continue
    q = ' '.join(rb['q'].split())[:70]
    print(f"{rb['role']:11} {dc:>7} {dt/1000:>8.1f} {dt/dc:>8.2f} {dh/dc:>9.1f}  {q}")
