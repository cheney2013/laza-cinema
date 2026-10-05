"""Which queued job runs next, and when each is expected to start.

The worker used to take jobs strictly first-in first-out, so a one-minute Qwen
plate fix waited behind a seven-chunk H3 chain, and alternating H3 / Qwen / Viggle
jobs paid a model unload + reload on every switch. This module orders the queue
instead. It is pure: it takes job dicts and returns an order, so it is tested
without a backend (test_job_scheduler.py).

Ordering, highest first:
  1. pinned jobs, in the order they were pinned (pin is a hard override);
  2. everything else by response ratio (HRRN):
         (waited + service) / service,   service = estimate + switch cost
     A short job's ratio climbs fast, so it overtakes a long one after a short
     wait; a long job's ratio still climbs, so it is never starved. The switch
     cost is 0 when the job uses the model family already resident, so jobs of
     one family naturally group into a batch.
The plan is simulated forward (each pick advances the clock by its service
time and changes the resident family), which is what gives every queued job its
expected start time.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Optional

# Families that load no GPU model of their own (ffmpeg work). They neither pay a
# switch nor change what is resident.
NO_MODEL = "none"

# Seconds to unload the resident family and load this one. First-order numbers
# from the 32 GB workstation (H3 transformer + text encoder ~35 GB from disk,
# Viggle another ~20 GB); the durations the planner learns from history include
# a load as well, so these only have to rank switches, not time them exactly.
SWITCH_COST = {
    "h3": 90.0,
    "viggle": 120.0,
    "qwen": 45.0,
    "flux2": 45.0,
    "audio": 20.0,
    "gaussian": 20.0,
    "rife": 10.0,
    "flashworld": 70.0,
}
DEFAULT_SWITCH = 30.0

# Fallback seconds per job when history has nothing for the type yet.
DEFAULT_SECONDS = {
    "h3": 480.0, "viggle": 900.0, "qwen": 90.0, "flux2": 90.0,
    "audio": 90.0, "gaussian": 120.0, "rife": 60.0, NO_MODEL: 20.0,
    "flashworld": 330.0,
}

# Families whose weights are big enough to evict each other. Only these unload,
# pay a switch or change what is resident: an ESRGAN / RIFE / audio pass runs
# beside a loaded H3 without pushing it out. Qwen and Viggle next to H3 are the
# measured cases (36 s/step; 7 min at step 0).
HEAVY = {"h3", "viggle", "qwen", "flux2", "flashworld"}

H3_TYPES = {"video", "video_edit", "video_edit_window", "video_cleanup", "video_continue_tail",
            "wardrobe_swap_h3", "character_sheet", "video_reshot", "av_bridge", "reangle", "audio_refine"}


def base_family(family: str) -> str:
    return family.split(":", 1)[0]


def describe(job_type: str, request: Optional[dict]) -> dict:
    """Family and work units of a job, from its type and request fields.

    Units scale the learned seconds-per-unit: frames x pixels x steps for H3
    video (per 1e9), 1 for everything else. `stages` is how many ComfyUI
    prompts a chained render will submit.
    """
    r = request or {}
    stages = 1
    if job_type == "charswap" and r.get("engine") == "h3":
        # The H3-native swap is an H3 edit render: its family, and the size and steps it is asked for
        # (TaoMate is 3 steps, the standard LoRA 8; "small" is 864 on the long edge).
        small = r.get("h3_size") == "small"
        r = {"motion_preset": "ref2va", "length": 124,
             "width": 864 if small else 1376, "height": 480 if small else 768,
             "steps": 3 if r.get("h3_accel") == "taomate3" else 8}
        job_type = "video_edit"
    if job_type in H3_TYPES:
        variant = r.get("unet_name") or r.get("motion_preset") or "default"
        family = f"h3:{variant}"
    elif job_type == "speech" and r.get("mode") == "speak":
        family = "h3:default"
    elif job_type == "qwen_image":
        family = "qwen"
    elif job_type == "inpaint":
        family = "flux2"
    elif job_type == "charswap":
        family = "viggle"
    elif job_type == "upscale":
        method = r.get("method") or "h3_latent"
        family = "h3:default" if method in ("h3_latent", "lms") else "esrgan"
    elif job_type in ("music", "ambience", "speech"):
        family = "audio"
    elif job_type in ("gaussian", "gaussian_model"):
        family = "gaussian"
    elif job_type in ("world_gaussian", "route_gaussian"):
        family = "flashworld"
    elif job_type == "interpolate":
        family = "rife"
    else:
        family = NO_MODEL

    units = 1.0
    if base_family(family) == "h3" and job_type != "speech":
        frames = int(r.get("length") or 124)
        px = int(r.get("width") or 1376) * int(r.get("height") or 768)
        steps = int(r.get("steps") or 8)
        units = max(0.1, frames * px * steps / 1e9)
        chunk = int(r.get("chunk_frames") or 0)
        if chunk and frames > chunk:
            keep = max(1, chunk - int(r.get("motion_context_length") or 22))
            stages = 1 + -(-(frames - chunk) // keep)
    return {"family": family, "units": units, "stages": stages}


def _ts(value) -> Optional[float]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value).timestamp()
    except (TypeError, ValueError):
        return None


# ── Durations learned from finished jobs ──────────────────────────────────────
#
# A render of a given configuration takes nearly the same time every run, so the
# best predictor is the median of recent runs of exactly that configuration
# (measured 2026-09-23 on 77 H3 renders: 3% median error, vs 4% / p90 35% for
# the old seconds-per-unit rate). Seconds per unit is not constant across sizes:
# attention grows with the square of the token count, so 1376x768x243 costs 2x
# per unit what 768x1376x146 does. A new size is interpolated from per-step
# sampler times fitted as a*N + b*N^2. Runs that hit memory paging (one step or
# the whole run several times slower than its peers) are kept out of both.

BUCKET_RUNS = 8        # recent runs of one configuration that are pooled
PAGED_STEP_RATIO = 2.5  # a step this many times the job's median step = paging
OUTLIER_RATIO = 2.0     # a run this many times its bucket's median = paging


def config_key(job_type: str, request: Optional[dict]) -> str:
    """Everything in a request that changes how long it takes, as one string."""
    r = request or {}
    d = describe(job_type, r)
    if base_family(d["family"]) == "h3" and job_type != "speech":
        parts = [job_type, d["family"], r.get("width") or 1376, r.get("height") or 768,
                 r.get("length") or 124, r.get("steps") or 8, r.get("chunk_frames") or 0]
    elif job_type == "qwen_image":
        parts = [job_type, r.get("width"), r.get("height"), r.get("steps") or 25,
                 len(r.get("images") or r.get("image_urls") or [])]
    else:
        parts = [job_type, d["family"]]
    return "|".join(str(p) for p in parts)


def tokens(job_type: str, request: Optional[dict]) -> float:
    """Video tokens in millions of frame-pixels (0 for non-H3 work)."""
    r = request or {}
    if base_family(describe(job_type, r)["family"]) != "h3" or job_type == "speech":
        return 0.0
    frames = int(r.get("chunk_frames") or 0) or int(r.get("length") or 124)
    return frames * int(r.get("width") or 1376) * int(r.get("height") or 768) / 1e6


def _median(xs: list[float]) -> float:
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])


def timing_record(job: dict, prompts: Optional[list[dict]] = None) -> Optional[dict]:
    """One finished job as a learning record, or None if it cannot teach anything.

    `prompts` are ComfyUIClient.take_timings() entries: per-node seconds and raw
    per-step sampler seconds. Without them (older history) only the wall time is
    known, which still fills the configuration bucket.
    """
    if job.get("status") != "done":
        return None
    s, e = _ts(job.get("started_at")), _ts(job.get("completed_at"))
    if s is None or e is None or e <= s:
        return None
    span = (e - s) - float(job.get("sched_suspended") or 0.0)
    if span <= 0:
        return None
    jt, req = job.get("type", ""), job.get("request")
    d = describe(jt, req)
    rec = {"type": jt, "key": config_key(jt, req), "family": d["family"],
           "units": d["units"], "stages": d["stages"], "tokens": tokens(jt, req),
           "steps": int((req or {}).get("steps") or 8), "span": round(span, 2),
           "at": job.get("completed_at"), "paged": False}
    steps: list[float] = []
    pre = post = 0.0
    # Time a prompt sat in ComfyUI's own queue behind someone else's work.
    waited = sum(max(0.0, p["started"] - p["queued"]) for p in prompts or []
                 if p.get("started") and p.get("queued"))
    if 0 < waited < span:
        rec["span"] = round(span - waited, 2)
        rec["comfy_wait"] = round(waited, 2)
    for p in prompts or []:
        nodes = p.get("nodes") or []
        samp = [i for i, (ct, _) in enumerate(nodes) if "sampler" in (ct or "").lower()]
        if samp:
            pre += sum(sec for _, sec in nodes[:samp[0]])
            post += sum(sec for _, sec in nodes[samp[-1] + 1:])
        steps.extend(p.get("steps") or [])
    if steps:
        med = _median(steps)
        # The first step carries warm-up (compile, first allocation); not paging.
        rec.update(step_med=round(med, 3), step_max=round(max(steps), 3),
                   n_steps=len(steps), pre=round(pre, 2), post=round(post, 2),
                   paged=len(steps) > 1 and max(steps[1:]) > PAGED_STEP_RATIO * med)
    return rec


class Estimator:
    """Expected seconds for a job, learned from finished jobs.

    Lookup: median of the last BUCKET_RUNS clean runs of the same configuration;
    else for H3, steps x fitted per-step time + typical overhead; else the old
    seconds-per-unit rate by job type; else DEFAULT_SECONDS.
    """

    def __init__(self, history: Iterable[dict], records: Optional[list[dict]] = None):
        history = list(history)
        if records is None:
            records = [r for r in (timing_record(j) for j in history) if r]
        self._bucket: dict[str, list[float]] = {}
        for rec in records:  # oldest first
            if not rec.get("paged"):
                self._bucket.setdefault(rec["key"], []).append(rec["span"])
        for key, spans in self._bucket.items():
            spans = spans[-BUCKET_RUNS * 2:]
            med = _median(spans)
            # A whole run that paged has uniformly slow steps; its span gives it away.
            clean = [x for x in spans if x <= OUTLIER_RATIO * med] or spans
            self._bucket[key] = clean[-BUCKET_RUNS:]
        self._fit = self._fit_steps(records)
        self._init_rates(history)

    @staticmethod
    def _fit_steps(records: list[dict]) -> dict[str, tuple]:
        """Per H3 family: (a, b, overhead_med, post_per_token) for step = a*N + b*N^2."""
        by_fam: dict[str, list[dict]] = {}
        for rec in records:
            if rec.get("step_med") and rec.get("tokens") and not rec.get("paged"):
                by_fam.setdefault(rec["family"], []).append(rec)
        fits = {}
        for fam, recs in by_fam.items():
            recs = recs[-60:]
            # Least squares without intercept on two non-negative terms.
            sxx = sum(r["tokens"] ** 2 for r in recs)
            sxz = sum(r["tokens"] ** 3 for r in recs)
            szz = sum(r["tokens"] ** 4 for r in recs)
            sxy = sum(r["tokens"] * r["step_med"] for r in recs)
            szy = sum(r["tokens"] ** 2 * r["step_med"] for r in recs)
            det = sxx * szz - sxz * sxz
            a = b = None
            if len({round(r["tokens"]) for r in recs}) >= 2 and det > 1e-9:
                a = (sxy * szz - szy * sxz) / det
                b = (szy * sxx - sxy * sxz) / det
            if a is None or a < 0 or b is None or b < 0:
                # One size only, or a negative term: fall back to the one that fits alone.
                b = szy / szz if szz else 0.0
                a = 0.0
            pre = _median([r.get("pre", 0.0) for r in recs])
            post_tok = _median([r.get("post", 0.0) / r["tokens"] for r in recs])
            fits[fam] = (a, b, pre, post_tok)
        return fits

    def step_seconds(self, job: dict) -> Optional[float]:
        """Predicted seconds per sampler step for an H3 job, if a fit exists."""
        sched = job.get("sched") or describe(job.get("type", ""), job.get("request"))
        fit = self._fit.get(sched.get("family", ""))
        n = tokens(job.get("type", ""), job.get("request"))
        if not fit or not n:
            return None
        return fit[0] * n + fit[1] * n * n

    def post_seconds(self, job: dict) -> float:
        """Predicted seconds after the last sampler step (decode, mux, save)."""
        sched = job.get("sched") or describe(job.get("type", ""), job.get("request"))
        fit = self._fit.get(sched.get("family", ""))
        return fit[3] * tokens(job.get("type", ""), job.get("request")) if fit else 0.0

    def interval(self, job: dict) -> Optional[tuple[float, float]]:
        """(low, high) seconds seen for this configuration, when it has >= 3 runs."""
        spans = self._bucket.get(config_key(job.get("type", ""), job.get("request")))
        if not spans or len(spans) < 3:
            return None
        return min(spans), max(spans)

    def source(self, job: dict) -> str:
        """Which rule produced seconds(job): bucket / fit / rate / default."""
        spans = self._bucket.get(config_key(job.get("type", ""), job.get("request")))
        if spans and len(spans) >= 2:
            return "bucket"
        if self.step_seconds(job) is not None:
            return "fit"
        return "rate" if job.get("type", "") in self.rate else "default"

    def seconds(self, job: dict) -> float:
        spans = self._bucket.get(config_key(job.get("type", ""), job.get("request")))
        if spans and len(spans) >= 2:
            return _median(spans)
        step = self.step_seconds(job)
        if step is not None:
            sched = job.get("sched") or describe(job.get("type", ""), job.get("request"))
            fit = self._fit[sched["family"]]
            steps = int((job.get("request") or {}).get("steps") or 8)
            stages = sched.get("stages", 1)
            return stages * (fit[2] + steps * step + self.post_seconds(job))
        return self._rate_seconds(job)

    def _init_rates(self, history: list[dict]):
        self.rate: dict[str, float] = {}
        for job in history:  # oldest first; EMA leans on the recent ones
            if job.get("status") != "done":
                continue
            s, e = _ts(job.get("started_at")), _ts(job.get("completed_at"))
            sched = job.get("sched") or describe(job.get("type", ""), job.get("request"))
            if s is None or e is None or e <= s:
                continue
            # Time a chain spent stepped aside for cut-in jobs is not its own.
            span = (e - s) - float(job.get("sched_suspended") or 0.0)
            if span <= 0:
                continue
            per_unit = span / max(sched.get("units", 1.0), 1e-6)
            key = job.get("type", "")
            old = self.rate.get(key)
            self.rate[key] = per_unit if old is None else 0.7 * old + 0.3 * per_unit

    def _rate_seconds(self, job: dict) -> float:
        sched = job.get("sched") or {}
        rate = self.rate.get(job.get("type", ""))
        if rate is None:
            fam = base_family(sched.get("family", NO_MODEL))
            base = DEFAULT_SECONDS.get(fam, 120.0)
            # The H3 default is for one 124-frame 1376x768 8-step chunk.
            if fam == "h3" and job.get("type") != "speech":
                base *= sched.get("units", 1.0) / (124 * 1376 * 768 * 8 / 1e9)
            return base
        return rate * sched.get("units", 1.0)


def is_heavy(family: Optional[str]) -> bool:
    return bool(family) and base_family(family) in HEAVY


def switch_cost(resident: Optional[str], family: str) -> float:
    if not is_heavy(family) or resident == family:
        return 0.0
    if resident and base_family(resident) == base_family(family) == "h3":
        return 15.0  # another H3 unet; the text encoder and VAE stay loaded
    return SWITCH_COST.get(base_family(family), DEFAULT_SWITCH)


def needs_free(resident: Optional[str], family: str) -> bool:
    """Unload before this job: a different model family is known to be resident."""
    return is_heavy(resident) and is_heavy(family) and \
        base_family(resident) != base_family(family)


# What a heavy family's weights take while it runs, as (VRAM, system RAM) in GiB. From the numbers
# measured on the 32 GB / 64 GB workstation (H3 ~20 GB staged + text encoder ~15 GB, peak 31.7 GB of VRAM;
# Qwen-Image 2.1 UNet 13.5 GB + encoder 9 GB). Estimates, not measurements of each model: they only
# have to say "this fits beside what is loaded" or "this does not".
FOOTPRINT_GIB = {
    "h3": (32.0, 36.0),
    "viggle": (20.0, 30.0),
    "qwen": (16.0, 24.0),
    "flux2": (16.0, 24.0),
    "flashworld": (12.0, 16.0),
    # Qwen3-VL text encoder alone: describing a picture, translating subtitles.
    "qwen_text": (9.0, 9.0),
}
HEADROOM_GIB = 1.5
_GIB = 1024 ** 3

# VRAM actually taken per family, learned from the aicinema_vram route (what ComfyUI reports loaded)
# before and after a job; it replaces the estimate above once a family has run. GiB, by base family.
LEARNED_VRAM_GIB: dict = {}


def load_learned(path) -> None:
    """Read the learned footprints back (missing or unreadable file: keep the estimates)."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        LEARNED_VRAM_GIB.update({str(k): float(v) for k, v in data.items() if float(v) > 0})
    except (OSError, ValueError, TypeError, AttributeError):
        pass


def save_learned(path) -> None:
    try:
        Path(path).write_text(json.dumps(LEARNED_VRAM_GIB, indent=1, sort_keys=True), encoding="utf-8")
    except OSError:
        pass


def note_loaded(family: str, before_bytes: int, after_bytes: int) -> Optional[float]:
    """A job of `family` took VRAM from `before` to `after` bytes (as ComfyUI reports it loaded). Returns
    the footprint now learned for the family in GiB, or None when the job added too little to tell
    (its weights were already resident). The largest recent growth wins and decays 10% per sample, so a
    run that found part of the weights already loaded does not shrink the figure."""
    grown = (after_bytes - before_bytes) / _GIB
    if grown < 1.0:
        return None
    key = base_family(family)
    old = LEARNED_VRAM_GIB.get(key)
    LEARNED_VRAM_GIB[key] = grown if old is None else max(grown, 0.9 * old)
    return LEARNED_VRAM_GIB[key]


def lacks_room(stats: dict, family: str) -> Optional[bool]:
    """Would this family's weights fit in the VRAM and RAM ComfyUI reports free right now?

    True: they would not, so what is loaded has to go first. False: they fit and nothing needs to
    unload. None: ComfyUI's numbers could not be read (or the family has no estimate).
    `stats` is ComfyUI's /system_stats.
    """
    need = FOOTPRINT_GIB.get(family) or FOOTPRINT_GIB.get(base_family(family))
    try:
        device = stats["devices"][0]
        vram_free, vram_total = float(device["vram_free"]), float(device["vram_total"])
        ram_free = float(stats["system"]["ram_free"])
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    if not need:
        return None
    learned = LEARNED_VRAM_GIB.get(family) or LEARNED_VRAM_GIB.get(base_family(family))
    # A card smaller than the footprint can only take the family on an empty card.
    vram_need = min((learned or need[0]) * _GIB, 0.92 * vram_total)
    return vram_free < vram_need + HEADROOM_GIB * _GIB or ram_free < need[1] * _GIB


def family_of_graph(graph) -> Optional[str]:
    """The heavy family whose weights a ComfyUI prompt graph loads, read from its loader nodes; None for a
    graph that loads none (ffmpeg, ESRGAN, RIFE...). A text-only Qwen3-VL run counts as qwen: its encoder
    stays loaded, which is what the next Qwen job reuses."""
    if not isinstance(graph, dict):
        return None
    found = None
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs") or {}
        name = str(inputs.get("unet_name") or inputs.get("clip_name") or "").lower()
        cls = str(node.get("class_type") or "")
        if "viggle" in name:
            return "viggle"
        if "qwen_image" in name or "qwen3vl" in name or "qwen_2.5_vl" in name:
            found = found or "qwen"
        elif "flux" in name:
            found = found or "flux2"
        elif "minimax_h3" in name or cls.startswith(("MiniMaxH3", "MMH3")):
            found = found or "h3"
    return found


def should_free(resident: Optional[str], family: str, stats: Optional[dict] = None) -> bool:
    """Unload before this job. A family already resident never does (`resident` should be what ComfyUI
    last ran, see family_of_graph, when this process has no record: a model already in VRAM is not
    "missing room" for itself). Otherwise it is the free VRAM and
    RAM that decide, whoever holds them (a family this process lost track of, another program); only
    when ComfyUI's numbers are unreadable does it fall back to "a different heavy family is resident"."""
    if not is_heavy(family) or (resident and base_family(resident) == base_family(family)):
        return False
    verdict = lacks_room(stats, family) if stats else None
    return needs_free(resident, family) if verdict is None else verdict


def plan(queued: list[dict], resident: Optional[str], now: float, start_in: float,
         est: Estimator) -> list[dict]:
    """Order queued jobs; returns [{job, eta, service, reason}] in run order.

    `start_in` is how long until the worker is free (remaining time of the
    running job). Ties keep submission order.
    """
    pinned = sorted((j for j in queued if j.get("pinned")), key=lambda j: j["pinned"])
    rest = [j for j in queued if not j.get("pinned")]
    t = now + start_in
    out = []
    for job in pinned:
        fam = (job.get("sched") or {}).get("family", NO_MODEL)
        service = est.seconds(job) + switch_cost(resident, fam)
        out.append({"job": job, "eta": t - now, "service": service, "reason": "置顶"})
        t += service
        if is_heavy(fam):
            resident = fam
    fifo_first = rest[0]["id"] if rest else None
    while rest:
        best, best_score, best_service = None, -1.0, 0.0
        for job in rest:
            fam = (job.get("sched") or {}).get("family", NO_MODEL)
            service = max(1.0, est.seconds(job) + switch_cost(resident, fam))
            waited = max(0.0, t - (_ts(job.get("created_at")) or now))
            score = (waited + service) / service
            if score > best_score + 1e-9:
                best, best_score, best_service = job, score, service
        rest.remove(best)
        fam = (best.get("sched") or {}).get("family", NO_MODEL)
        if best["id"] == fifo_first:
            reason = ""
        elif resident and fam == resident:
            reason = "与显存里的模型相同，一起跑"
        else:
            reason = "短任务提前"
        fifo_first = rest[0]["id"] if rest else None
        out.append({"job": best, "eta": t - now, "service": best_service, "reason": reason})
        t += best_service
        if is_heavy(fam):
            resident = fam
    return out


# ── Interleaving at a chunk boundary of a long chain ──────────────────────────

# A job cuts in between two chunks only if it is short. One 124-frame H3 clip
# (~8 min) may go in beside a chain of the same model; another model's job
# must be much shorter, since it also costs the unload and the reload.
CUT_IN_MAX_SAME = 600.0
CUT_IN_MAX_OTHER = 300.0
# A different family costs two switches (out and back), so it must have waited.
CROSS_FAMILY_MIN_WAIT = 600.0


def cut_in(queued: list[dict], parent_family: str, now: float, est: Estimator) -> Optional[dict]:
    """The queued job to run between two chunks of a chain, or None."""
    best, best_key = None, None
    for job in queued:
        fam = (job.get("sched") or {}).get("family", NO_MODEL)
        secs = est.seconds(job)
        waited = now - (_ts(job.get("created_at")) or now)
        same = not is_heavy(fam) or fam == parent_family
        ok = job.get("pinned") or (secs <= CUT_IN_MAX_SAME if same else
                                   secs <= CUT_IN_MAX_OTHER and waited >= CROSS_FAMILY_MIN_WAIT)
        if not ok:
            continue
        key = (0 if job.get("pinned") else 1, job.get("pinned") or 0, 0 if same else 1, secs)
        if best_key is None or key < best_key:
            best, best_key = job, key
    return best


def now_ts() -> float:
    return datetime.now(timezone.utc).timestamp()
