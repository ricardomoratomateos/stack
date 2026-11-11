#!/usr/bin/env python3
"""Sample RSS / CPU time of the benchmark's processes every INTERVAL s for DURATION s.

usage: sample.py OUT.csv PHASE DURATION INTERVAL APP_PID STACKD_PID TMUX_SOCKET BASELINE_FILE
Appends rows: phase,t,group,pid,rss_kb,cpu_s   (cpu_s = cumulative CPU seconds, summarize.py derives %).
Groups: app, webcontent, gpu, networking, stackd, tmux-server, tmux-clients.
"""
import subprocess, sys, time

out, phase, dur, step, app, stackd, sock, base = sys.argv[1:9]
dur, step, app, stackd = float(dur), float(sys.argv[4]), int(app), int(stackd)
baseline = set(open(base).read().split())

def cpu(s):  # [dd-]hh:mm:ss.ss or mm:ss.ss
    d = 0
    if '-' in s: d, s = s.split('-'); d = int(d)
    parts = [float(x) for x in s.split(':')]
    while len(parts) < 3: parts.insert(0, 0)
    return d * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]

def tmux_pid():
    r = subprocess.run(['tmux', '-L', sock, 'display', '-p', '#{pid}'], capture_output=True, text=True)
    return int(r.stdout.strip()) if r.stdout.strip().isdigit() else None

def snapshot():
    ps = subprocess.run(['ps', '-axo', 'pid=,ppid=,rss=,time=,command='], capture_output=True, text=True).stdout
    rows = {}
    for line in ps.splitlines():
        p = line.split(None, 4)
        if len(p) < 5: continue
        rows[int(p[0])] = (int(p[1]), int(p[2]), cpu(p[3]), p[4])
    return rows

def group(pid, rows, tm):
    ppid, _, _, cmd = rows[pid]
    if pid == app: return 'app'
    if pid == stackd: return 'stackd'
    if pid == tm: return 'tmux-server'
    if ppid == app and 'tmux' in cmd.split()[0]: return 'tmux-clients'
    if 'com.apple.WebKit' in cmd and str(pid) not in baseline:
        if 'WebContent' in cmd: return 'webcontent'
        if 'GPU' in cmd: return 'gpu'
        if 'Networking' in cmd: return 'networking'
    return None

end = time.time() + dur
t0 = time.time()
with open(out, 'a') as f:
    while time.time() < end:
        rows, tm = snapshot(), tmux_pid()
        for pid in rows:
            g = group(pid, rows, tm)
            if g: f.write(f'{phase},{time.time()-t0:.1f},{g},{pid},{rows[pid][1]},{rows[pid][2]:.2f}\n')
        f.flush()
        time.sleep(step)
