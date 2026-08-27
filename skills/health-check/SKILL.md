---
name: health-check
description: |
  System health check dispatched by the activity monitor via Control queue.
  Checks PM2 services, disk space, and memory usage.
  Use when receiving a control message containing "health-check".
user-invocable: false
allowed-tools: Bash, Read, Grep
---

# System Health Check

Periodic system health check delivered via the C4 Control queue.

## When to Use

- Receiving a control message with "health-check" in the content
- The activity monitor enqueues this automatically at regular intervals

## Steps

### 1. Check PM2 Services

```bash
pm2 jlist
```

Parse the JSON output. Every service should have `status: "online"`.
Record which services are stopped or errored.

**Crash-loop detection (use the right signal):** a service can read `online` while silently crash-looping. Judge crash-loops by:
- `pm2_env.unstable_restarts > 0`, **or**
- current uptime very short (seconds/minutes) **and** restart count rising across consecutive checks.

Do **NOT** alert on `pm2_env.restart_time` alone — it is the *cumulative lifetime* restart count (e.g. 3152), not a signal of an active crash-loop. A large `restart_time` with `unstable_restarts: 0` and a long uptime is a healthy, stable service. (Learned 2026-07-03: a peer bot false-alarmed a stable `zylos-vnc` by reading cumulative `restart_time` as active crashing.)

Also note: wrapper services launched via `bash -c` (e.g. `zylos-vnc`) report the thin parent shell's RSS (a few MB) — low RSS is expected there, not a crash signal; the real work runs in child processes.

### 2. Check Disk Space

```bash
df -h / /home 2>/dev/null || df -h /
```

Thresholds:
- OK: < 80% used
- Warning: 80-90% used
- Critical: > 90% used

### 3. Check Memory

```bash
free -m
```

Thresholds:
- OK: < 80% used
- Warning: 80-90% used
- Critical: > 90% used (or swap > 50% used)

### 4. Report Results

If all checks pass, log to `~/zylos/logs/health.log`:

```
[YYYY-MM-DD HH:MM:SS] Health Check: PM2 X/X online, Disk XX%, Memory XX% - ALL OK
```

If any issues found, notify whoever is most likely to help:
1. Check your memory files for a designated owner or ops person
2. If none designated, notify the person you normally work with most
3. Use `c4-send.js` with the appropriate channel and endpoint to send the alert

## Issue Resolution

| Issue | Action |
|-------|--------|
| PM2 service stopped | `pm2 restart <service>` and report |
| High disk usage | Check logs directories, report findings |
| High memory / swap | Report findings, check for runaway processes |
