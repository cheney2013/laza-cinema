#!/usr/bin/env python
"""Review a finished film with an OpenAI-compatible Qwen vision model.

The reviewer samples ordered frames, sends them with the production brief, and
writes both machine-readable JSON and a compact Markdown report.  Audio presence is
checked locally; sampled stills cannot judge dialogue, mix, or motion fidelity.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from fractions import Fraction
from pathlib import Path
from typing import Any

import httpx

DEFAULT_API = "http://100.67.86.13:1234/v1"
DEFAULT_MODEL = "qwen2.5-vl-3b-instruct"
BLOCKING_CATEGORIES = {
    "generation_artifact", "identity_continuity", "environment_continuity",
    "spatial_position", "brief_mismatch", "legibility",
}
SPATIAL_RELATION_POLICY = (
    "Universal veto rule: compare every visible subject, character, prop, vehicle, "
    "and environment element with the expected spatial relationships in the brief. "
    "A wrong seat, side, lane, room, vehicle compartment, foreground/midground/background "
    "layer, inside/outside state, relative order, or attachment/holding relationship is a "
    "spatial_position blocking issue. Any confirmed spatial relationship error must force "
    "rejection regardless of the overall score. If the expected relationship cannot be "
    "verified from the supplied frames, do not pass the shot; report it for review."
)
CATEGORY_ALIASES = {
    "畸形/融化/重复肢体": "generation_artifact",
    "畸形/融化": "generation_artifact",
    "生成瑕疵": "generation_artifact",
    "角色身份断裂": "identity_continuity",
    "身份连续性": "identity_continuity",
    "环境连续性": "environment_continuity",
    "空间位置错误": "spatial_position",
    "人物位置错误": "spatial_position",
    "座位错误": "spatial_position",
    "严重偏离简报": "brief_mismatch",
    "简报不符": "brief_mismatch",
    "文字不可读": "legibility",
}
NON_STATIC_TERMS = (
    "动作流畅", "动作节拍", "动作时间", "动作与预期", "运动流畅",
    "发生时间", "时间点", "转场", "对白", "音效", "配乐", "混音",
    "motion smooth", "timing", "transition", "dialogue", "sound effect", "audio mix",
)


def normalize_category(category: Any) -> str:
    """Normalize model wording, including generic spatial-relation failures."""
    value = str(category or "").strip().lower()
    value = CATEGORY_ALIASES.get(value, value)
    spatial_markers = (
        "spatial", "position", "placement", "location", "seat", "compartment",
        "空间", "位置", "座位", "车厢", "前后", "左右", "内外", "层级",
    )
    if any(marker in value for marker in spatial_markers):
        return "spatial_position"
    return value


def probe_video(video: Path) -> dict[str, Any]:
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "format=duration,size:stream=codec_type,codec_name,width,height,avg_frame_rate,nb_frames",
         "-of", "json", str(video)], capture_output=True, text=True, check=True,
    )
    data = json.loads(proc.stdout)
    streams = data.get("streams", [])
    visual = next((s for s in streams if s.get("codec_type") == "video"), {})
    rate = visual.get("avg_frame_rate", "0/1")
    fps = float(Fraction(rate)) if rate and rate != "0/0" else 0.0
    frame_count = int(visual.get("nb_frames") or round(
        float(data["format"]["duration"]) * fps))
    return {
        "duration_s": round(float(data["format"]["duration"]), 3),
        "size_bytes": int(data["format"].get("size", 0)),
        "width": visual.get("width"), "height": visual.get("height"),
        "video_codec": visual.get("codec_name"),
        "fps": round(fps, 4), "frame_count": frame_count,
        "audio_present": any(s.get("codec_type") == "audio" for s in streams),
    }


def sample_times(duration: float, count: int) -> list[float]:
    count = max(3, count)
    # Avoid fades and decoder edge cases while retaining opening/closing evidence.
    start, end = min(0.25, duration * .02), max(0.0, duration - min(0.25, duration * .02))
    if end <= start:
        return [duration / 2]
    return [start + (end - start) * i / (count - 1) for i in range(count)]


def detect_scene_cuts(video: Path, threshold: float = 0.35) -> list[float]:
    """Return timestamps of the first frame after visually abrupt cuts."""
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(video), "-filter:v",
         f"select='gt(scene,{threshold})',showinfo", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    )
    return [float(value) for value in re.findall(r"pts_time:([0-9.]+)", proc.stderr)]


def smart_sample_times(video: Path, duration: float, sample_fps: float = 2.0,
                       scene_threshold: float = 0.35) -> tuple[list[float], list[float]]:
    if sample_fps <= 0:
        raise ValueError("sample_fps must be positive")
    interval = 1.0 / sample_fps
    regular = [i * interval for i in range(max(1, math.ceil(duration * sample_fps)))
               if i * interval < duration]
    cuts = detect_scene_cuts(video, scene_threshold)
    # Millisecond rounding deduplicates a cut that already lands on the regular grid.
    times = sorted({round(t, 3) for t in regular + cuts if 0 <= t < duration})
    return times, cuts


def extract_frames(video: Path, folder: Path, times: list[float], width: int) -> list[Path]:
    frames: list[Path] = []
    for index, at in enumerate(times, 1):
        dest = folder / f"frame_{index:02d}_{at:07.2f}s.jpg"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-ss", f"{at:.3f}", "-i", str(video),
             "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "4", str(dest)],
            check=True,
        )
        frames.append(dest)
    return frames


def extract_all_frames(video: Path, folder: Path, width: int) -> list[Path]:
    pattern = folder / "frame_%06d.jpg"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(video), "-vsync", "0",
         "-vf", f"scale={width}:-2", "-q:v", "5", str(pattern)], check=True)
    return sorted(folder.glob("frame_*.jpg"))


def load_brief(path: Path | None) -> dict[str, Any]:
    if not path or not path.exists():
        return {}
    spec = json.loads(path.read_text(encoding="utf-8"))
    def compact(value: Any, limit: int) -> Any:
        if not isinstance(value, str) or len(value) <= limit:
            return value
        return value[:limit].rsplit(" ", 1)[0] + "…"

    return {
        "title": spec.get("title"), "logline": spec.get("logline"),
        "character": compact(spec.get("character") or spec.get("subject_noun"), 500),
        "style": compact(spec.get("style"), 500),
        "shots": [
            {"id": s.get("id"), "slug": s.get("slug"),
             "expected_visual": compact(s.get("keyframe"), 360),
             "expected_action": compact(s.get("motion"), 240)}
            for s in spec.get("shots", [])
        ],
    }


def parse_json_response(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        left, right = stripped.find("{"), stripped.rfind("}")
        if left >= 0 and right > left:
            return json.loads(stripped[left:right + 1])
        raise


def apply_gate_policy(result: dict[str, Any]) -> dict[str, Any]:
    """Keep a small vision model from blocking work on evidence stills cannot prove."""
    accepted, downgraded = [], []
    for issue in result.get("blocking_issues", []):
        category = normalize_category(issue.get("category", ""))
        if category in BLOCKING_CATEGORIES:
            issue["category"] = category
            accepted.append(issue)
        else:
            downgraded.append(issue)
    if downgraded:
        result.setdefault("warnings", []).extend(downgraded)
        result.setdefault("uncertainties", []).append(
            "Some proposed blockers were downgraded because their categories cannot be "
            "reliably established from sparse still frames.")
    result["blocking_issues"] = accepted
    raw_verdict = result.get("verdict", "unknown")
    try:
        overall = float(result.get("scores", {}).get("overall", 0))
    except (TypeError, ValueError):
        overall = 0.0
    result["model_verdict"] = raw_verdict
    result["verdict"] = "pass" if overall >= 7.0 and not accepted else (
        "fail" if overall < 5.0 or len(accepted) >= 3 else "revise")
    result["gate_policy"] = {"pass_score": 7.0,
                             "blocking_categories": sorted(BLOCKING_CATEGORIES)}
    return result


def sanitize_static_review(result: dict[str, Any]) -> dict[str, Any]:
    """Remove claims that sampled stills cannot support and normalize frame labels."""
    for key in ("blocking_issues", "warnings"):
        cleaned = []
        for issue in result.get(key, []):
            evidence = str(issue.get("evidence", ""))
            category = normalize_category(issue.get("category", ""))
            # Keep directly visible artifacts even if the model describes a moving mouth.
            if category not in BLOCKING_CATEGORIES and any(
                    term.lower() in evidence.lower() for term in NON_STATIC_TERMS):
                continue
            match = re.search(r"第\s*(\d+)\s*帧", evidence)
            if match:
                issue["frame_number"] = int(match.group(1))
            cleaned.append(issue)
        result[key] = cleaned
    result["uncertainties"] = [
        item for item in result.get("uncertainties", [])
        if not any(term.lower() in str(item).lower() for term in NON_STATIC_TERMS)
    ]
    return result


def review(video: Path, api_base: str, model: str, frame_count: int,
           frame_width: int, brief_path: Path | None, timeout: float,
           explicit_times: list[float] | None = None,
           sampling_meta: dict[str, Any] | None = None) -> dict[str, Any]:
    media = probe_video(video)
    times = explicit_times or sample_times(media["duration_s"], frame_count)
    brief = load_brief(brief_path)
    schema = {
        "summary": "string", "observed_story": "string",
        "scores": {"technical_visual": "0-10", "character_continuity": "0-10",
                   "environment_continuity": "0-10", "composition": "0-10",
                   "brief_visual_alignment": "0-10", "overall": "0-10"},
        "blocking_issues": [{"frame_number": 1, "category": "string",
                             "evidence": "string", "fix": "string"}],
        "warnings": [{"frame_number": 1, "evidence": "string", "fix": "string"}],
        "strengths": ["string"], "uncertainties": ["string"],
        "verdict": "pass|revise|fail",
    }
    prompt = (
        SPATIAL_RELATION_POLICY + "\n"
        "你是AI生成电影的严格静态画面质量审核员。以下图片是同一影片按播放顺序抽取的帧。"
        "用第1帧、第2帧这样的帧序号定位问题，不要输出时间点。\n"
        "检查主体身份与外观连续性、场景和道具连续性、畸形/融化/重复肢体/穿模/乱码等生成瑕疵、"
        "曝光与构图，以及画面内容是否符合制作简报。只报告图片中有直接可见证据的问题。"
        "人物出现在错误座位、错误车厢区域、错误房间或错误前中后景层级时，必须使用"
        "spatial_position列入blocking_issues，不能被总体分数抵消。"
        "不要审查或评论动作流畅度、动作节拍或发生时间、镜头转场质量、对白、音效、配乐或混音；"
        "也不要把这些内容放入 uncertainties。blocking_issues 只放"
        "必须返工的问题。overall>=7.0且无blocking_issues才可pass。只输出合法JSON，不要Markdown。\n"
        f"媒体信息：{json.dumps(media, ensure_ascii=False)}\n"
        f"制作简报：{json.dumps(brief, ensure_ascii=False)}\n"
        f"JSON结构：{json.dumps(schema, ensure_ascii=False)}"
    )
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    with tempfile.TemporaryDirectory(prefix="qwen-film-review-") as tmp:
        frames = extract_frames(video, Path(tmp), times, frame_width)
        for frame in frames:
            encoded = base64.b64encode(frame.read_bytes()).decode("ascii")
            content.append({"type": "image_url", "image_url": {
                "url": f"data:image/jpeg;base64,{encoded}"}})
        parsed, body = _post_chat(api_base, model, content, timeout, 1800, attempts=3)
    result = apply_gate_policy(sanitize_static_review(parsed))
    result["review_meta"] = {"video": str(video.resolve()), "model": model,
                             "api_base": api_base, "sample_times_s": times,
                             "media": media, "usage": body.get("usage", {}),
                             "sampling": sampling_meta or {"mode": "uniform_count",
                                                             "frame_count": frame_count}}
    return result


def _post_chat(api_base: str, model: str, content: Any, timeout: float,
               max_tokens: int = 1800, attempts: int = 2) -> tuple[dict[str, Any], dict[str, Any]]:
    payload = {"model": model, "messages": [{"role": "user", "content": content}],
               "temperature": 0.1, "max_tokens": max_tokens}
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        response = httpx.post(f"{api_base.rstrip('/')}/chat/completions", json=payload,
                              timeout=timeout)
        response.raise_for_status()
        body = response.json()
        try:
            return parse_json_response(body["choices"][0]["message"]["content"]), body
        except (json.JSONDecodeError, KeyError, IndexError) as exc:
            last_error = exc
            print(f"[qwen] invalid JSON response; retry {attempt}/{attempts}", flush=True)
    raise ValueError(f"Qwen did not return valid JSON after {attempts} attempts: {last_error}")


def review_all_frames(video: Path, api_base: str, model: str, batch_size: int,
                      frame_width: int, brief_path: Path | None,
                      timeout: float, checkpoint_path: Path | None = None) -> dict[str, Any]:
    """Inspect every decoded frame in bounded batches, then synthesize one verdict."""
    media = probe_video(video)
    brief = load_brief(brief_path)
    fps = float(media.get("fps") or 0)
    if fps <= 0:
        raise ValueError("Cannot determine video frame rate")
    batch_results: list[dict[str, Any]] = []
    if checkpoint_path and checkpoint_path.exists():
        saved = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        if (saved.get("video") == str(video.resolve()) and
                saved.get("batch_size") == batch_size and
                saved.get("frame_width") == frame_width):
            batch_results = saved.get("batch_results", [])
            print(f"[all-frames] resuming after {len(batch_results)} completed batch(es)",
                  flush=True)
    total_usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    with tempfile.TemporaryDirectory(prefix="qwen-film-all-frames-") as tmp:
        frames = extract_all_frames(video, Path(tmp), frame_width)
        total_batches = (len(frames) + batch_size - 1) // batch_size
        for batch_index, start in enumerate(range(0, len(frames), batch_size), 1):
            if batch_index <= len(batch_results):
                continue
            batch = frames[start:start + batch_size]
            timestamps = [round((start + i) / fps, 4) for i in range(len(batch))]
            prompt = (
                SPATIAL_RELATION_POLICY + "\n"
                f"你在逐帧审核一个短视频。这是第{batch_index}/{total_batches}批，"
                f"包含全片第{start + 1}至{start + len(batch)}帧，相邻图片是连续帧。"
                "只依据可见证据检查：畸形、融化、重复或消失肢体、身份闪变、物体突变、穿模、"
                "严重模糊或画面破损。正常运动造成的姿态变化和运动模糊不是缺陷。"
                "人物位于错误座位、错误车厢区域或错误空间层级属于spatial_position阻断项。"
                "不要审查动作流畅度、动作时间、转场、对白、音效、配乐或混音。"
                "每个问题必须给出frame_number、category、evidence、severity(blocking|warning)，不要输出时间点。"
                "若没有明确问题，issues必须为空。只输出合法JSON："
                '{"issues":[],"batch_quality":"good|mixed|bad","observations":["..."]}。'
                f"制作简报：{json.dumps(brief, ensure_ascii=False)}")
            content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
            for frame in batch:
                encoded = base64.b64encode(frame.read_bytes()).decode("ascii")
                content.append({"type": "image_url", "image_url": {
                    "url": f"data:image/jpeg;base64,{encoded}"}})
            parsed, body = _post_chat(api_base, model, content, timeout, 2400)
            parsed["batch"] = batch_index
            parsed["frame_range"] = [start + 1, start + len(batch)]
            parsed["time_range_s"] = [timestamps[0], timestamps[-1]]
            batch_results.append(parsed)
            usage = body.get("usage", {})
            for key in total_usage:
                total_usage[key] += int(usage.get(key, 0) or 0)
            print(f"[all-frames] batch {batch_index}/{total_batches} reviewed "
                  f"({start + 1}-{start + len(batch)}/{len(frames)})", flush=True)
            if checkpoint_path:
                checkpoint_path.write_text(json.dumps({
                    "video": str(video.resolve()), "batch_size": batch_size,
                    "frame_width": frame_width, "batch_results": batch_results,
                }, ensure_ascii=False, indent=2), encoding="utf-8")

    synthesis_schema = {
        "summary": "string", "observed_story": "string",
        "scores": {"technical_visual": "0-10", "character_continuity": "0-10",
                   "environment_continuity": "0-10", "composition": "0-10",
                   "brief_visual_alignment": "0-10", "overall": "0-10"},
        "blocking_issues": [{"frame_number": 1, "category": "generation_artifact|identity_continuity|environment_continuity|spatial_position|brief_mismatch|legibility",
                             "evidence": "string", "fix": "string"}],
        "warnings": [{"frame_number": 1, "evidence": "string", "fix": "string"}],
        "strengths": ["string"], "uncertainties": ["string"],
        "verdict": "pass|revise|fail",
    }
    synthesis_prompt = (
        SPATIAL_RELATION_POLICY + "\n"
        "你是短片质量总审。下面是覆盖每一帧的分批审核结果。合并重复问题。"
        "使用帧序号定位，不要输出时间点。不要把单帧正常姿态变化升级为缺陷；只有跨连续帧可见且"
        "有具体证据的严重生成瑕疵才阻断。不要审查动作流畅度、动作时间、转场、对白、音效、配乐"
        "或混音，也不要将它们列为不确定项。overall>=7且无阻断项才pass。只输出合法JSON。"
        f"媒体：{json.dumps(media, ensure_ascii=False)}\n"
        f"简报：{json.dumps(brief, ensure_ascii=False)}\n"
        f"分批结果：{json.dumps(batch_results, ensure_ascii=False)}\n"
        f"结构：{json.dumps(synthesis_schema, ensure_ascii=False)}")
    result, body = _post_chat(api_base, model, synthesis_prompt, timeout, 2000)
    result = apply_gate_policy(sanitize_static_review(result))
    usage = body.get("usage", {})
    for key in total_usage:
        total_usage[key] += int(usage.get(key, 0) or 0)
    result["review_meta"] = {
        "video": str(video.resolve()), "model": model, "api_base": api_base,
        "mode": "all_frames_batched", "frames_reviewed": len(frames),
        "batch_size": batch_size, "batches": len(batch_results), "media": media,
        "usage": total_usage, "batch_results": batch_results,
    }
    return result


def markdown_report(result: dict[str, Any]) -> str:
    scores = result.get("scores", {})
    lines = [f"# Qwen film review: {result.get('verdict', 'unknown').upper()}", "",
             result.get("summary", ""), "", "## Scores", ""]
    lines += [f"- {key}: {value}/10" for key, value in scores.items()]
    for title, key in (("Blocking issues", "blocking_issues"), ("Warnings", "warnings"),
                       ("Strengths", "strengths"), ("Uncertainties", "uncertainties")):
        lines += ["", f"## {title}", ""]
        items = result.get(key, [])
        if not items:
            lines.append("- None")
        for item in items:
            if isinstance(item, dict):
                frame = item.get("frame_number", "?")
                lines.append(f"- `frame {frame}` {item.get('category', '')}: {item.get('evidence', '')}"
                             + (f" Fix: {item['fix']}" if item.get("fix") else ""))
            else:
                lines.append(f"- {item}")
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("video", type=Path)
    ap.add_argument("--brief", type=Path, help="shots.json used as expected-content brief")
    ap.add_argument("--output-dir", type=Path)
    ap.add_argument("--api-base", default=os.getenv("QWEN_API_BASE", DEFAULT_API))
    ap.add_argument("--model", default=os.getenv("QWEN_MODEL", DEFAULT_MODEL))
    ap.add_argument("--frames", type=int, default=12)
    ap.add_argument("--smart-sample", action="store_true",
                    help="sample at a fixed rate and always include detected hard cuts")
    ap.add_argument("--sample-fps", type=float, default=2.0,
                    help="base sampling rate for --smart-sample (default: 2)")
    ap.add_argument("--scene-threshold", type=float, default=0.35,
                    help="FFmpeg scene-change threshold (default: 0.35)")
    ap.add_argument("--all-frames", action="store_true",
                    help="review every decoded frame in batches")
    ap.add_argument("--batch-size", type=int, default=16,
                    help="images per request with --all-frames (default: 16)")
    ap.add_argument("--frame-width", type=int, default=768)
    ap.add_argument("--timeout", type=float, default=240)
    ap.add_argument("--no-gate", action="store_true", help="always exit 0 after writing reports")
    args = ap.parse_args()
    if not args.video.exists():
        ap.error(f"video not found: {args.video}")
    out_dir = args.output_dir or args.video.parent / "review"
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        if args.all_frames:
            if args.batch_size < 2 or args.batch_size > 32:
                ap.error("--batch-size must be between 2 and 32")
            result = review_all_frames(args.video, args.api_base, args.model,
                                       args.batch_size, args.frame_width,
                                       args.brief, args.timeout,
                                       out_dir / "qwen_batches_checkpoint.json")
        else:
            times = None
            sampling = None
            if args.smart_sample:
                media = probe_video(args.video)
                times, cuts = smart_sample_times(
                    args.video, media["duration_s"], args.sample_fps,
                    args.scene_threshold)
                sampling = {"mode": "fixed_fps_plus_hard_cuts",
                            "sample_fps": args.sample_fps,
                            "scene_threshold": args.scene_threshold,
                            "hard_cut_times_s": cuts,
                            "frames_sent": len(times)}
                print(f"[smart-sample] {len(times)} frame(s), "
                      f"{len(cuts)} forced hard-cut frame(s): {cuts}", flush=True)
            result = review(args.video, args.api_base, args.model, args.frames,
                            args.frame_width, args.brief, args.timeout,
                            times, sampling)
    except Exception as exc:
        print(f"Qwen review failed: {exc}", file=sys.stderr)
        return 2
    (out_dir / "qwen_review.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / "qwen_review.md").write_text(markdown_report(result), encoding="utf-8")
    print(markdown_report(result))
    print(f"Reports: {out_dir / 'qwen_review.json'}  {out_dir / 'qwen_review.md'}")
    blocked = bool(result.get("blocking_issues")) or result.get("verdict") != "pass"
    return 1 if blocked and not args.no_gate else 0


if __name__ == "__main__":
    sys.exit(main())
