---
name: investigate-job
description: Investigate a Fixer job — look up status, progress, logs, latency stats, and ETA. Use when the user asks why a job is slow, stuck, failed, or wants to inspect a job by ID. Triggers on job UUIDs, "why is this job", "job status", "job taking too long", "inspect job", "check job".
---

# Investigate Job

## Quick start

Run the script with a job ID:

```bash
python .cursor/skills/investigate-job/scripts/inspect_job.py <job-id>
```

List recent jobs (no ID needed):

```bash
python .cursor/skills/investigate-job/scripts/inspect_job.py --recent [N]
```

The script uses `apps/visualizer/visualizer.db` (falls back to `apps/visualizer/backend/visualizer.db`).

## What the script shows

- **Job fields**: type, status, progress, current_step, timestamps, error
- **Metadata**: provider, weights, max_workers, method — minus the bulky checkpoint key list
- **Checkpoint summary**: version + count of processed keys
- **Last 5 log entries**
- **API latency stats** (vision_match jobs): avg/min/max, % calls >10s / >20s
- **ETA estimate** when progress < 100%

## Workflow

1. Run the script — read the output directly, no manual SQL needed.
2. If the job is slow, check:
   - **avg latency** — high avg (>5s) means provider is the bottleneck
   - **% >10s calls** — spikes indicate rate limiting or model overload
   - **calls/image** — high number means cascade isn't pruning candidates
3. Report findings to the user using the output, then suggest fixes.

## Common findings

| Symptom | Likely cause |
|---------|-------------|
| avg latency >10s, many >20s spikes | Provider rate limiting / slow model |
| 100+ calls per image | `date_window_days` too large or weak pre-filters |
| status=running, no recent log activity | Job may be stuck / worker died |
| ETA > a few hours | Reduce `max_workers`, switch provider, or tighten filters |
