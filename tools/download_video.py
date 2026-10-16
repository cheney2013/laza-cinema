#!/usr/bin/env python3
"""
tools/download_video.py

Generic video downloader CLI tool (powered by yt-dlp).
Supports Bilibili, YouTube, and other platforms supported by yt-dlp.
Handles cookie injection for high-resolution formats (e.g., 4K/60FPS on Bilibili),
custom output directory, audio extraction, and safe filename formatting.
"""

import argparse
import os
import re
import subprocess
import sys


def sanitize_filename(name: str) -> str:
    """Sanitize filename to avoid invalid Windows characters and problematic symbols."""
    cleaned = re.sub(r'[\\/*?:"<>|]', "", name)
    cleaned = cleaned.strip()
    return cleaned if cleaned else "video"


def run_download(
    url: str,
    output_dir: str = ".",
    cookies_file: str | None = None,
    cookies_browser: str | None = None,
    audio_only: bool = False,
    quality: str = "best",
    format_id: str | None = None,
    custom_name: str | None = None,
) -> int:
    os.makedirs(output_dir, exist_ok=True)

    cmd = ["yt-dlp", "--no-mtime"]

    # Cookie configurations
    if cookies_file:
        if not os.path.exists(cookies_file):
            print(f"[!] Warning: Cookie file not found: {cookies_file}", file=sys.stderr)
        else:
            cmd.extend(["--cookies", cookies_file])
    elif cookies_browser:
        cmd.extend(["--cookies-from-browser", cookies_browser])

    # Audio or Video selection
    if audio_only:
        cmd.extend(["-x", "--audio-format", "mp3", "--audio-quality", "0"])
        out_tmpl = "%(title)s.%(ext)s" if not custom_name else f"{custom_name}.%(ext)s"
    else:
        if format_id:
            cmd.extend(["-f", format_id])
        elif quality == "best":
            cmd.extend(["-f", "bv*+ba/b"])
        elif quality == "1080p":
            cmd.extend(["-f", "bv*[height<=1080]+ba/b[height<=1080]"])
        elif quality == "720p":
            cmd.extend(["-f", "bv*[height<=720]+ba/b[height<=720]"])
        else:
            cmd.extend(["-f", quality])

        cmd.extend(["--merge-output-format", "mp4"])
        out_tmpl = "%(title)s.%(ext)s" if not custom_name else f"{custom_name}.%(ext)s"

    target_path = os.path.join(output_dir, out_tmpl)
    cmd.extend(["-o", target_path, url])

    print(f"[*] Executing command:\n    {' '.join(cmd)}\n")
    try:
        proc = subprocess.run(cmd)
        return proc.returncode
    except FileNotFoundError:
        print(
            "[!] Error: yt-dlp is not installed or not in system PATH.",
            file=sys.stderr,
        )
        return 1


def list_formats(url: str, cookies_file: str | None = None, cookies_browser: str | None = None) -> int:
    cmd = ["yt-dlp", "-F", url]
    if cookies_file:
        cmd.extend(["--cookies", cookies_file])
    elif cookies_browser:
        cmd.extend(["--cookies-from-browser", cookies_browser])

    proc = subprocess.run(cmd)
    return proc.returncode


def main():
    parser = argparse.ArgumentParser(
        description="Download videos from Bilibili, YouTube, etc. using yt-dlp.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("url", help="URL of the video (Bilibili, YouTube, etc.)")
    parser.add_argument("-o", "--output-dir", default=".", help="Output directory path")
    parser.add_argument("-n", "--name", default=None, help="Custom output filename (without extension)")
    parser.add_argument("-F", "--list-formats", action="store_true", help="List all available formats without downloading")
    parser.add_argument(
        "-q",
        "--quality",
        choices=["best", "1080p", "720p"],
        default="best",
        help="Target video quality preset",
    )
    parser.add_argument("-f", "--format", dest="format_id", default=None, help="Specific format ID or custom yt-dlp format selector")
    parser.add_argument("-a", "--audio-only", action="store_true", help="Extract audio only (MP3)")
    parser.add_argument("-c", "--cookies", default=None, help="Path to cookies.txt file (for VIP 4K/60FPS streams)")
    parser.add_argument(
        "--cookies-browser",
        default=None,
        choices=["chrome", "edge", "firefox", "brave", "safari"],
        help="Extract cookies directly from local browser",
    )

    args = parser.parse_args()

    if args.list_formats:
        sys.exit(list_formats(args.url, cookies_file=args.cookies, cookies_browser=args.cookies_browser))

    ret = run_download(
        url=args.url,
        output_dir=args.output_dir,
        cookies_file=args.cookies,
        cookies_browser=args.cookies_browser,
        audio_only=args.audio_only,
        quality=args.quality,
        format_id=args.format_id,
        custom_name=args.name,
    )
    sys.exit(ret)


if __name__ == "__main__":
    main()
