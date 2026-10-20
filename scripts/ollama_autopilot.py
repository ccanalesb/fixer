"""ollama_autopilot.py — external observer that keeps the Ollama Cloud plan busy
by TRIGGERING the existing pipeline jobs while leaving headroom.

DESIGN — thin trigger, not a second pipeline
---------------------------------------------
The pipeline (the visualizer's ``batch_describe`` / ``batch_score`` jobs) already
owns everything about the *work*: which images need describing/scoring, path
reachability preflight, skipping missing files, and idempotency (re-running a job
just skips already-done work). This script does NOT reimplement any of that — it
never reads ``library.db``, never selects images, never checks paths.

Its only job is the one thing the pipeline does NOT do: watch your Ollama plan
usage and fire the pipeline when there's headroom. The loop is:

    read usage%  ->  if under ceiling and no describe/score job already running
                     ->  POST the next pipeline job (batch_describe / batch_score)
    read each job's result only to pace retries (back off a job type that just
    failed or that the pipeline aborted, so we don't churn).

It reacts to already-synced images only (never runs catalog_sync). New images the
pipeline picks up on the next trigger, because the job selects its own work.

METERING — Ollama Cloud usage is opaque
---------------------------------------
No official usage API (ollama/ollama#12532). Two meters, in preference order:

1. REAL usage (optional) — supply your browser ``__Secure-session`` cookie
   (``--usage-cookie`` / ``--usage-cookie-file`` / ``$OLLAMA_SESSION_COOKIE``) and
   the autopilot scrapes the real "Session usage" and "Weekly usage" percentages
   from ollama.com/settings, holding at ``--max-session-pct`` / ``--max-weekly-pct``
   (e.g. 85 => 15% headroom). Unofficial + brittle (cookie expires, markup may
   change); degrades gracefully to meter #2 on any failure.
2. WALL-CLOCK self-meter (fallback) — sum job wall-clock as a GPU-time proxy over
   rolling 5h/7d windows, under a calibrated budget minus headroom.

A running job is cancelled (checkpoint preserved) if usage crosses the ceiling; a
job that fails with a rate-limit error triggers a cooldown.

SAFE BY DEFAULT: report-only unless ``--live`` is passed.

Run with the repo venv (or just ``python`` — this script has no library imports):

    python scripts/ollama_autopilot.py --dry-run
    python scripts/ollama_autopilot.py --live      # cookie + FLASK_PORT via .env
    python scripts/ollama_autopilot.py --live --once   # one cycle (cron/launchd)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

# Ollama's two documented reset windows (used by the wall-clock fallback meter).
WINDOW_5H_S = 5 * 60 * 60
WINDOW_7D_S = 7 * 24 * 60 * 60

# The pipeline jobs this observer triggers. The pipeline owns their selection,
# preflight, and idempotency — we just fire them.
JOB_TYPES = ("batch_describe", "batch_score")
KIMI_TYPES = ("batch_describe", "batch_score", "batch_analyze")
CULL_TYPE = "batch_cull_photos_before_scoring"
REDECIDE_TYPE = "batch_redecide_cull_verdicts_from_stored_answers"
# Counted as in flight — do not stack another job (processor runs one at a time).
ACTIVE_TYPES = KIMI_TYPES + (CULL_TYPE, REDECIDE_TYPE)

TERMINAL_STATUSES = {"completed", "failed", "cancelled"}
RATE_LIMIT_MARKERS = ("rate limit", "ratelimit", "quota", "429", "too many requests")

DEFAULT_LEDGER = REPO_ROOT / "scripts" / ".autopilot-ledger.json"
SETTINGS_URL = "https://ollama.com/settings"
_WIDTH_PCT_RE = re.compile(r"width:\s*([0-9]+(?:\.[0-9]+)?)%")


# --------------------------------------------------------------------------- #
# HTTP client for the visualizer job API (stdlib only).
# --------------------------------------------------------------------------- #
def _request(method: str, url: str, payload: dict | None = None, timeout: float = 30.0):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode()
    return json.loads(body) if body else None


class VisualizerApi:
    def __init__(self, base: str):
        self.base = base.rstrip("/")

    def health(self) -> dict:
        return _request("GET", f"{self.base}/api/jobs/health")

    def active_jobs(self) -> list[dict]:
        return _request("GET", f"{self.base}/api/jobs/active") or []

    def get_job(self, job_id: str) -> dict:
        return _request("GET", f"{self.base}/api/jobs/{job_id}")

    def create_job(self, job_type: str, metadata: dict) -> dict:
        return _request(
            "POST", f"{self.base}/api/jobs/", {"type": job_type, "metadata": metadata}
        )

    def cancel_job(self, job_id: str) -> None:
        _request("DELETE", f"{self.base}/api/jobs/{job_id}")


def resolve_api(base: str | None, fallback_ports=(5001, 5000)) -> VisualizerApi:
    """Return a reachable API client. If ``base`` is given, use it; else probe
    ``$FLASK_PORT`` (if set) then the fallback ports on localhost."""
    if base:
        candidates = [base]
    else:
        ports: list[str] = []
        env_port = os.environ.get("FLASK_PORT")
        if env_port:
            ports.append(env_port)
        ports += [str(p) for p in fallback_ports]
        seen: set[str] = set()
        candidates = [
            f"http://127.0.0.1:{p}" for p in ports if not (p in seen or seen.add(p))
        ]
    last_err: Exception | None = None
    for cand in candidates:
        try:
            api = VisualizerApi(cand)
            api.health()
            return api
        except Exception as e:  # noqa: BLE001 - probing; any failure -> try next
            last_err = e
    raise SystemExit(
        f"Could not reach the visualizer backend at {candidates!r}. "
        f"Start it (scripts/dev-up.sh) or pass --api-base. Last error: {last_err}"
    )


# --------------------------------------------------------------------------- #
# Real cloud usage (optional, unofficial) — scrape ollama.com/settings.
# Technique from ollama/ollama#12532. No supported API; any failure -> None and
# the wall-clock meter takes over.
# --------------------------------------------------------------------------- #
def _pct_after(html: str, marker: str) -> float | None:
    idx = html.find(marker)
    if idx == -1:
        return None
    m = _WIDTH_PCT_RE.search(html, idx, idx + 4000)
    return float(m.group(1)) if m else None


def fetch_cloud_usage(cookie: str, timeout: float = 20.0) -> dict | None:
    cookie = cookie.strip()
    header = cookie if "=" in cookie else f"__Secure-session={cookie}"
    req = urllib.request.Request(
        SETTINGS_URL,
        headers={"Cookie": header, "User-Agent": "ollama-autopilot", "Accept": "text/html"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            html = resp.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 - network/auth failure -> unknown
        return None
    session_pct = _pct_after(html, "Session usage")
    weekly_pct = _pct_after(html, "Weekly usage")
    if session_pct is None and weekly_pct is None:
        return None  # not logged in (redirected to signin) or markup changed
    return {"session_pct": session_pct, "weekly_pct": weekly_pct}


def resolve_usage_cookie(args) -> str | None:
    if args.usage_cookie:
        return args.usage_cookie
    if args.usage_cookie_file:
        try:
            return Path(args.usage_cookie_file).read_text(encoding="utf-8").strip()
        except OSError:
            return None
    return os.environ.get("OLLAMA_SESSION_COOKIE")


# --------------------------------------------------------------------------- #
# Ledger: rolling-window usage + per-job-type retry pacing.
# --------------------------------------------------------------------------- #
def _parse_ts(value: str | None) -> float | None:
    if not value:
        return None
    try:
        s = value.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except ValueError:
        return None


def load_ledger(path: Path) -> dict:
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            data.setdefault("jobs", {})
            data.setdefault("cooldown_until", 0.0)
            data.setdefault("backoff", {})  # job_type -> earliest-next-trigger ts
            data.setdefault("rr", 0)  # round-robin cursor over JOB_TYPES
            return data
        except (ValueError, OSError):
            pass
    return {"jobs": {}, "cooldown_until": 0.0, "backoff": {}, "rr": 0}


def save_ledger(path: Path, ledger: dict) -> None:
    path.write_text(json.dumps(ledger, indent=2, sort_keys=True), encoding="utf-8")


def rolling_seconds(ledger: dict, window_s: float, now: float) -> float:
    """Wall-clock meter: kimi work only (cull / re-decide add 0)."""
    window_start = now - window_s
    used = 0.0
    for job in ledger["jobs"].values():
        jtype = job.get("type")
        if jtype in (CULL_TYPE, REDECIDE_TYPE):
            continue
        completed = job.get("completed_ts")
        kimi_s = job.get("kimi_s")
        if jtype in KIMI_TYPES and completed is not None and kimi_s is not None and kimi_s > 0:
            start = completed - kimi_s
            end = completed
        else:
            start = job.get("started_ts") or job.get("created_ts")
            if start is None:
                continue
            end = completed or now
        overlap = min(end, now) - max(start, window_start)
        if overlap > 0:
            used += overlap
    return used


def is_rate_limited(job: dict) -> bool:
    if job.get("status") != "failed":
        return False
    err = (job.get("error") or "").lower()
    return any(m in err for m in RATE_LIMIT_MARKERS)


# --------------------------------------------------------------------------- #
# One autopilot cycle.
# --------------------------------------------------------------------------- #
def refresh_tracked_jobs(api: VisualizerApi, ledger: dict, args, now: float, log) -> bool:
    """Poll non-terminal tracked jobs and update the ledger. Set per-type retry
    backoff from each job's *result* (pipeline's own pass/fail). Returns True if a
    tracked job just failed rate-limited (caller applies the global cooldown)."""
    hit_rate_limit = False
    for job_id, entry in list(ledger["jobs"].items()):
        if entry.get("status") in TERMINAL_STATUSES:
            continue
        try:
            job = api.get_job(job_id)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                ledger["jobs"].pop(job_id, None)
            continue
        except Exception:  # noqa: BLE001 - transient; retry next cycle
            continue

        prev = entry.get("status")
        entry["status"] = job.get("status")
        entry["started_ts"] = _parse_ts(job.get("started_at")) or entry.get("started_ts")
        entry["completed_ts"] = _parse_ts(job.get("completed_at"))
        entry["error"] = job.get("error")

        if entry["status"] in TERMINAL_STATUSES and prev not in TERMINAL_STATUSES:
            jtype = entry["type"]
            if is_rate_limited(job):
                hit_rate_limit = True
                log(f"{jtype} {job_id[:8]} failed rate-limited: {job.get('error')}")
            elif entry["status"] in ("failed", "cancelled"):
                # Pipeline aborted this pass (e.g. unreachable paths, or nothing
                # workable). Back it off so we don't churn; still retried later.
                ledger["backoff"][jtype] = now + args.fail_backoff_min * 60
                log(
                    f"{jtype} {job_id[:8]} {entry['status']}: {(job.get('error') or '')[:80]}"
                    f" — backing off {args.fail_backoff_min:.0f}min"
                )
            else:  # completed
                if jtype == CULL_TYPE:
                    ledger["cull_done_for"] = entry.get("for")
                    ledger["backoff"].pop(jtype, None)
                elif jtype in KIMI_TYPES:
                    ledger["backoff"].pop(jtype, None)
                    result = job.get("result") or {}
                    if isinstance(result, dict):
                        durations = result.get("durations_s") or {}
                        if isinstance(durations, dict):
                            kimi_s = float(durations.get("describe") or 0) + float(
                                durations.get("score") or 0
                            )
                            if kimi_s > 0:
                                entry["kimi_s"] = kimi_s
                    ledger["cull_done_for"] = None
                else:
                    ledger["backoff"].pop(jtype, None)
                log(f"{jtype} {job_id[:8]} completed.")
    return hit_rate_limit


def active_pipeline_job(api: VisualizerApi) -> dict | None:
    for job in api.active_jobs():
        if job.get("type") in ACTIVE_TYPES:
            return job
    return None


def peek_job_type(ledger: dict, now: float) -> tuple[str | None, int | None]:
    """Next describe/score type in round-robin without advancing ``rr``."""
    n = len(JOB_TYPES)
    start = ledger.get("rr", 0) % n
    for i in range(n):
        idx = (start + i) % n
        jtype = JOB_TYPES[idx]
        if now >= ledger["backoff"].get(jtype, 0):
            return jtype, idx
    return None, None


def pick_job_type(ledger: dict, now: float) -> str | None:
    """Round-robin over JOB_TYPES, skipping types currently backed off (advances ``rr``)."""
    jtype, idx = peek_job_type(ledger, now)
    if jtype is not None and idx is not None:
        ledger["rr"] = (idx + 1) % len(JOB_TYPES)
    return jtype


def decide_launch(
    ledger: dict,
    now: float,
    over_budget: bool,
    running: dict | None,
) -> dict | None:
    """Pure decision for one cycle: what job to create, if any (tests + ``cycle``)."""
    if over_budget:
        if running and running.get("type") in KIMI_TYPES:
            return {"action": "cancel", "job_id": running["id"], "job_type": running["type"]}
        return {"action": "hold", "reason": "over_budget"}
    if running:
        return {"action": "hold", "reason": "in_flight"}
    if now < ledger.get("cooldown_until", 0):
        return {"action": "hold", "reason": "cooldown"}
    job_type, idx = peek_job_type(ledger, now)
    if job_type is None:
        return {"action": "hold", "reason": "all_backoff"}
    if now < ledger.get("backoff", {}).get(CULL_TYPE, 0):
        return {"action": "hold", "reason": "cull_backoff"}
    if ledger.get("cull_done_for") != job_type:
        return {
            "action": "create",
            "job_type": CULL_TYPE,
            "metadata": {"scope_job_type": job_type},
            "ledger_entry": {"type": CULL_TYPE, "for": job_type},
        }
    return {
        "action": "create",
        "job_type": job_type,
        "metadata": {},
        "advance_rr_from": idx,
        "clear_cull_done_for": True,
    }


def cycle(api: VisualizerApi, args, log) -> None:
    now = time.time()
    ledger = load_ledger(args.ledger)

    if refresh_tracked_jobs(api, ledger, args, now, log):
        ledger["cooldown_until"] = now + args.cooldown_min * 60
    save_ledger(args.ledger, ledger)

    # Meter #1: real usage from ollama.com/settings, if a session cookie is set.
    over_budget = False
    usage = fetch_cloud_usage(args._usage_cookie) if args._usage_cookie else None
    if usage is not None:
        s, w = usage["session_pct"], usage["weekly_pct"]
        s_txt = f"{s:.1f}%" if s is not None else "?"
        w_txt = f"{w:.1f}%" if w is not None else "?"
        log(f"usage (real): session={s_txt}/{args.max_session_pct:.0f}%  weekly={w_txt}/{args.max_weekly_pct:.0f}%")
        over_budget = (s is not None and s >= args.max_session_pct) or (
            w is not None and w >= args.max_weekly_pct
        )
    else:
        if args._usage_cookie:
            log("usage cookie set but scrape failed (expired/markup?) — falling back to wall-clock meter.")
        used_5h = rolling_seconds(ledger, WINDOW_5H_S, now) / 60.0
        used_7d = rolling_seconds(ledger, WINDOW_7D_S, now) / 60.0
        ceil_5h = args.budget_5h_min * (1.0 - args.headroom)
        ceil_7d = args.budget_7d_min * (1.0 - args.headroom)
        over_budget = used_5h >= ceil_5h or used_7d >= ceil_7d
        log(
            f"usage (wall-clock): 5h={used_5h:.0f}/{ceil_5h:.0f}min  7d={used_7d:.0f}/{ceil_7d:.0f}min"
            f"  (budget {args.budget_5h_min}/{args.budget_7d_min}, headroom {args.headroom:.0%})"
        )

    # Cooldown after a rate-limit.
    if now < ledger.get("cooldown_until", 0):
        mins = (ledger["cooldown_until"] - now) / 60.0
        log(f"cooldown active ({mins:.0f} min left after rate-limit) — holding.")
        return

    running = active_pipeline_job(api)
    decision = decide_launch(ledger, now, over_budget, running)

    if decision["action"] == "hold":
        reason = decision["reason"]
        if reason == "over_budget":
            if running and running.get("type") in KIMI_TYPES:
                if args.live:
                    log(
                        f"over budget — cancelling running {running['type']} "
                        f"{running['id'][:8]} (checkpoint preserved)."
                    )
                    try:
                        api.cancel_job(running["id"])
                    except Exception as e:  # noqa: BLE001
                        log(f"cancel failed (will retry): {e}")
                else:
                    log(
                        f"[dry-run] over budget — would cancel running "
                        f"{running['type']} {running['id'][:8]}."
                    )
            elif running:
                log(f"over budget — holding ({running['type']} in flight, not cancelled).")
            else:
                log("over budget — holding for headroom (no job running).")
        elif reason == "in_flight":
            log(
                f"in flight: {running['type']} {running['id'][:8]} "
                f"at {running.get('progress', 0)}% — waiting."
            )
        elif reason == "cull_backoff":
            log("cull backing off — holding describe/score")
        elif reason == "all_backoff":
            log("all job types backing off (recent failures/aborts) — idle. Retries automatically.")
        return

    if decision["action"] == "cancel":
        if args.live:
            try:
                api.cancel_job(decision["job_id"])
            except Exception as e:  # noqa: BLE001
                log(f"cancel failed (will retry): {e}")
        else:
            log(f"[dry-run] over budget — would cancel running {decision['job_type']}.")
        return

    job_type = decision["job_type"]
    metadata: dict = {"image_type": "catalog", "max_workers": args.max_workers, **decision.get("metadata", {})}
    if args.provider_id:
        metadata["provider_id"] = args.provider_id
    if args.provider_model:
        metadata["provider_model"] = args.provider_model
    if args.redo_unless_model:
        metadata["redo_unless_model"] = args.redo_unless_model

    if not args.live:
        log(f"[dry-run] would trigger {job_type} metadata={json.dumps(metadata)}")
        return

    job = api.create_job(job_type, metadata)
    entry = {
        "type": job_type,
        "status": job.get("status", "pending"),
        "created_ts": _parse_ts(job.get("created_at")) or now,
        "started_ts": _parse_ts(job.get("started_at")),
        "completed_ts": None,
        "error": None,
    }
    if decision.get("ledger_entry"):
        entry.update(decision["ledger_entry"])
    ledger["jobs"][job["id"]] = entry
    if decision.get("advance_rr_from") is not None:
        ledger["rr"] = (decision["advance_rr_from"] + 1) % len(JOB_TYPES)
    if decision.get("clear_cull_done_for"):
        ledger.pop("cull_done_for", None)
    save_ledger(args.ledger, ledger)
    log(f"triggered {job_type} {job['id'][:8]} metadata={json.dumps(metadata)}")


# --------------------------------------------------------------------------- #
# CLI.
# --------------------------------------------------------------------------- #
def load_dotenv_if_available() -> None:
    """Load REPO_ROOT/.env into os.environ (real exported vars win). No-op if
    python-dotenv isn't installed. Lets you set OLLAMA_SESSION_COOKIE / FLASK_PORT
    once in .env instead of exporting them each run."""
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv(REPO_ROOT / ".env", override=False)


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="External observer that triggers pipeline describe/score jobs, paced by Ollama plan usage.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--api-base", default=None, help="Visualizer base URL; default probes $FLASK_PORT then :5001/:5000.")
    p.add_argument("--ledger", type=Path, default=DEFAULT_LEDGER, help="Usage/pacing ledger file.")
    p.add_argument("--usage-cookie", default=None, help="ollama.com __Secure-session cookie value for REAL usage (unofficial).")
    p.add_argument("--usage-cookie-file", default=None, help="File holding the __Secure-session cookie value.")
    p.add_argument("--max-session-pct", type=float, default=85.0, help="Real meter: hold at this %% of the 5h session limit.")
    p.add_argument("--max-weekly-pct", type=float, default=85.0, help="Real meter: hold at this %% of the 7d weekly limit.")
    p.add_argument("--budget-5h-min", type=float, default=180.0, help="Wall-clock meter: job-minutes budget per rolling 5h window.")
    p.add_argument("--budget-7d-min", type=float, default=1800.0, help="Wall-clock meter: job-minutes budget per rolling 7d window.")
    p.add_argument("--headroom", type=float, default=0.15, help="Wall-clock meter: fraction of budget held back (0..1).")
    p.add_argument("--max-workers", type=int, default=4, help="max_workers passed to each triggered job.")
    p.add_argument("--provider-id", default=None, help="Provider id pinned in job metadata (e.g. 'ollama').")
    p.add_argument("--provider-model", default=None, help="Model pinned in job metadata (e.g. 'kimi-k2.6:cloud').")
    p.add_argument(
        "--redo-unless-model",
        default=None,
        help=(
            "Model-scoped re-do: regenerate every catalog image EXCEPT those whose "
            "current row was produced by this full model label (e.g. "
            "'ollama:kimi-k2.6:cloud'); preserves that model's finished work, "
            "force-replaces the rest. Should equal '<provider-id>:<provider-model>'."
        ),
    )
    p.add_argument("--fail-backoff-min", type=float, default=30.0, help="Minutes to skip a job type after it fails/aborts.")
    p.add_argument("--cooldown-min", type=float, default=60.0, help="Minutes to pause everything after a rate-limit.")
    p.add_argument("--poll-interval", type=float, default=300.0, help="Seconds between cycles (loop mode).")
    p.add_argument("--once", action="store_true", help="Run one cycle and exit (e.g. for cron).")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--live", action="store_true", help="Actually trigger/cancel jobs.")
    mode.add_argument("--dry-run", action="store_true", help="Report only (default).")
    args = p.parse_args(argv)
    if not (0.0 <= args.headroom < 1.0):
        p.error("--headroom must be in [0, 1).")
    # The stored model label is f"{provider_id}:{provider_model}"; the model-scoped
    # re-do filter matches on that exact string, so a mismatch silently redoes even
    # the target model's finished work.
    if args.redo_unless_model and args.provider_id and args.provider_model:
        expected = f"{args.provider_id}:{args.provider_model}"
        if args.redo_unless_model != expected:
            p.error(
                f"--redo-unless-model ({args.redo_unless_model!r}) must equal "
                f"'<provider-id>:<provider-model>' ({expected!r}) or the filter misfires."
            )
    return args


def main(argv: list[str]) -> int:
    load_dotenv_if_available()
    args = parse_args(argv)

    def log(msg: str) -> None:
        stamp = datetime.now().strftime("%H:%M:%S")
        print(f"[{stamp}] {msg}", flush=True)

    args._usage_cookie = resolve_usage_cookie(args)
    meter = "real (ollama.com/settings)" if args._usage_cookie else "wall-clock proxy"
    api = resolve_api(args.api_base)
    log(f"autopilot {'LIVE' if args.live else 'DRY-RUN'} — api={api.base} meter={meter} jobs={'+'.join(JOB_TYPES)}")

    if args.once:
        cycle(api, args, log)
        return 0

    while True:
        try:
            cycle(api, args, log)
        except KeyboardInterrupt:
            log("interrupted — exiting.")
            return 0
        except Exception as e:  # noqa: BLE001 - keep the observer alive across transient errors
            log(f"cycle error (continuing): {e}")
        time.sleep(args.poll_interval)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
