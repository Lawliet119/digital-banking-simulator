import json, sys, gzip, math

d = sys.argv[1].rstrip('/') + '/'
plateau = sys.argv[2] if len(sys.argv) > 2 else '120'
a = json.load(open(d + 'aggregate.json'))
pm = json.load(open(d + 'per-minute.json'))
ex = json.load(open(d + 'exit.json'))
print(f"{ex['scenario']} {ex['startedAt']}..{ex['finishedAt']} runExit={ex['runExit']} invariantExit={ex['invariantExit']}")
for k, p in sorted(a['plateaus'].items(), key=lambda x: int(x[0])):
    print(f"plateau {k}: req={p['requests']} sysErr={p['systemErrors']} rate={p['errorRate']*100:.4f}% dropped={p['droppedIterations']} rps={p['achievedRps']} meetsDoD3={p['meetsDoD3']}")
for sc, names in a['byScenario'].items():
    if not sc.endswith('_' + plateau) and sc != 'hot':
        continue
    for n, m in names.items():
        print(f"  {sc:10} {n:34} n={m['count']:>6} err={m['systemErrors']:>4} p50={m['p50']:.1f} p95={m['p95']:.1f} p99={m['p99']:.1f} max={m['max']:.0f}")
sc = 'write_' + plateau if ('write_' + plateau) in a['byScenario'] else 'hot'
rows = [r for r in pm if r['scenario'] == sc]
full = [r for r in rows if r['count'] >= 500] if sc != 'hot' else [r for r in rows if r['count'] >= 800]
over = [r for r in full if r['p95'] > 300]
print(f"per-minute {sc}: {len(rows)} khung, {len(full)} khung đủ mẫu, p95>300ms: {len(over)}; p95 theo phút (ms): " + ' '.join(f"{r['p95']:.0f}" for r in rows))
print(f"  khung đủ mẫu: max p95={max((r['p95'] for r in full), default=0):.0f} ms, p99 max={max((r['p99'] for r in full), default=0):.0f} ms, lỗi theo phút: " + ' '.join(str(r['systemErrors']) for r in rows))
