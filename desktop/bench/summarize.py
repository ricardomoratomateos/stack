#!/usr/bin/env python3
"""summarize.py samples.csv -> markdown table: RSS MB and CPU % (min/avg/max) per phase and process group."""
import csv, sys, collections
rss = collections.defaultdict(lambda: collections.defaultdict(float))   # (phase,group) -> t -> sum rss
cpu = collections.defaultdict(dict)                                       # (phase,group,pid) -> t -> cpu_s
for phase, t, g, pid, r, c in csv.reader(open(sys.argv[1])):
    t = float(t); rss[(phase, g)][t] += int(r) / 1024
    cpu[(phase, g, pid)][t] = float(c)
pcpu = collections.defaultdict(lambda: collections.defaultdict(float))   # (phase,group) -> t -> sum %
for (phase, g, pid), s in cpu.items():
    ts = sorted(s)
    for a, b in zip(ts, ts[1:]):
        pcpu[(phase, g)][b] += 100 * (s[b] - s[a]) / (b - a)
def mma(d):
    v = list(d.values())
    return f'{min(v):.0f}/{sum(v)/len(v):.0f}/{max(v):.0f}' if v else '-'
phases = list(dict.fromkeys(k[0] for k in rss))
groups = ['app', 'webcontent', 'gpu', 'networking', 'stackd', 'tmux-server', 'tmux-clients']
print('| scenario | process | RSS MB min/avg/max | CPU % min/avg/max |')
print('|---|---|---|---|')
for p in phases:
    for g in groups:
        if (p, g) in rss: print(f'| {p} | {g} | {mma(rss[(p, g)])} | {mma(pcpu[(p, g)])} |')
