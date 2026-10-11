"""Record real Claude runs for every preset in fixtures/presets.json.

    uv run python scripts/record.py                # all presets, stops at a $2 budget
    uv run python scripts/record.py --budget 0.5 --only stress

Starts the API with RECORD_FIXTURES=1 and ALLOW_SERVER_KEY=1 so each endpoint calls
Claude with your key and writes its response into fixtures/<store>.json, replacing the
placeholder with the same key. The key is read from the environment or ../.env and is
never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_env() -> None:
    for candidate in (ROOT / ".env", ROOT.parent / ".env", ROOT.parent.parent / ".env"):
        if os.environ.get("ANTHROPIC_API_KEY") or not candidate.exists():
            continue
        for line in candidate.read_text().splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "ANTHROPIC_API_KEY" and value.strip():
                os.environ["ANTHROPIC_API_KEY"] = value.strip().strip("\"'")


def post(url: str, body: dict) -> tuple[bool, dict, str]:
    request = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers={"content-type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            text = response.read().decode()
            streamed = "text/event-stream" in response.headers.get("content-type", "")
    except urllib.error.HTTPError as error:
        text, streamed = error.read().decode(), False
    if streamed:
        frames = [json.loads(c[6:]) for c in text.split("\n\n") if c.startswith("data: ")]
        last = frames[-1] if frames else {}
        message = (last.get("error") or {}).get("message", "")
        return last.get("type") == "done", last.get("meta") or {}, message
    payload = json.loads(text)
    message = (payload.get("error") or {}).get("message", "")
    return bool(payload.get("ok")), payload.get("meta") or {}, message


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--budget", type=float, default=2.0)
    parser.add_argument("--port", type=int, default=8111)
    parser.add_argument("--only", default="")
    parser.add_argument("--app", default="app.main:app")
    args = parser.parse_args()

    load_env()
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY is not set. Add it to ~/portfolio/.env.", file=sys.stderr)
        return 1

    presets = [
        p
        for p in json.loads((ROOT / "fixtures" / "presets.json").read_text())
        if args.only in p["route"] or args.only in str(p["body"].get("demoId", ""))
    ]
    server = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", args.app, "--port", str(args.port)],
        cwd=ROOT,
        env={**os.environ, "RECORD_FIXTURES": "1", "ALLOW_SERVER_KEY": "1"},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    base = f"http://127.0.0.1:{args.port}"
    try:
        for _ in range(120):
            try:
                urllib.request.urlopen(f"{base}/health", timeout=1)
                break
            except OSError:
                time.sleep(0.25)
        spent, failed = 0.0, 0
        for preset in presets:
            name = f"{preset['route']} {preset['body'].get('demoId', '')}".strip()
            if spent >= args.budget:
                print(f"Budget of ${args.budget:.2f} reached. Stopping at: {name}", file=sys.stderr)
                failed += 1
                break
            ok, meta, message = post(base + preset["route"], preset["body"])
            spent += meta.get("costUsd", 0) or 0
            if ok and meta.get("mode") == "live":
                print(f"recorded  {name}  ${meta.get('costUsd', 0):.4f}  {meta.get('model')}")
            else:
                failed += 1
                print(f"FAILED    {name}  {message}", file=sys.stderr)
        print(f"\nTotal spent: ${spent:.4f} across {len(presets)} preset(s). Failures: {failed}.")
        return 1 if failed else 0
    finally:
        server.terminate()


if __name__ == "__main__":
    raise SystemExit(main())
