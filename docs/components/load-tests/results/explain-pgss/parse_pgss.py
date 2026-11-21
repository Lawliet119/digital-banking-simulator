import re,json,sys
t=open(sys.argv[1],encoding='utf8').read()
m=re.search(r'\t(\[\{.*\}\])\t?',t,re.S)
rows=json.loads(m.group(1).split('\tSQL>')[0])
print(rows[0]['at'], len(rows))
for r in rows:
    print(f"{r['role']:11} calls={int(r['calls']):>7} total={float(r['total_ms'])/1000:8.1f}s mean={float(r['mean_ms']):8.3f}ms rows/call={int(r['rows'])/max(1,int(r['calls'])):8.1f} hit/call={int(r['hit'])/max(1,int(r['calls'])):9.1f} | {' '.join(r['q'].split())[:90]}")
