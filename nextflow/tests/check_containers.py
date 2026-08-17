"""Every container image the workflow runs must provide `ps`.

This is not a nicety. Nextflow's task wrapper runs `nxf_trace` *inside* the container
whenever tracing is enabled (`-with-trace`, `-with-report`, `-with-timeline` — which
most launchers turn on), and `nxf_trace_linux` opens with:

    command -v ps &>/dev/null || { >&2 echo "Command 'ps' required by nextflow to
    collect task metrics cannot be found"; exit 1; }

so an image without `ps` does not merely lose resource metrics, it fails every task.
`nxf_tree`/`nxf_kill` also walk the process table with `ps -e -o pid= -o ppid=` to stop
a task's children, so the exact invocation is checked too, not just the binary's
presence.

Checks every `*_container` param in nextflow.config, so an image swapped in through
`--multiqc_container` is covered by the same test. Skips cleanly when Docker is not
available, since it has to actually run each image.

Run from the repo root:  python nextflow/tests/check_containers.py
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CONFIG = REPO / "nextflow" / "nextflow.config"

# What the task wrapper actually does: `command -v ps` (the hard gate) and the process
# table walk that nxf_tree/nxf_kill rely on.
PROBE = (
    'command -v ps >/dev/null 2>&1 || { echo "no-ps"; exit 1; }; '
    'ps -e -o pid= -o ppid= >/dev/null 2>&1 || { echo "ps-broken"; exit 1; }; '
    'echo ok'
)


def container_images() -> dict[str, str]:
    """`*_container` params from the params block of nextflow.config."""
    block = CONFIG.read_text().split("params {", 1)[1].split("\n}", 1)[0]
    found = {}
    for line in block.splitlines():
        line = line.split("//", 1)[0].strip()
        if match := re.match(r"^(\w*container)\s*=\s*['\"](.+?)['\"]", line):
            found[match.group(1)] = match.group(2)
    return found


def docker_available() -> bool:
    try:
        return subprocess.run(["docker", "info"], capture_output=True,
                              timeout=60).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def main() -> int:
    images = container_images()
    if not images:
        print(f"no *_container params found in {CONFIG}", file=sys.stderr)
        return 1

    if not docker_available():
        print("[skip] Docker is not available; container images not checked")
        for param, image in sorted(images.items()):
            print(f"       would check {param} = {image}")
        return 0

    failures = []
    for param, image in sorted(images.items()):
        # --entrypoint sh so an image with its own entrypoint (the uv image runs uv)
        # still gives us a shell.
        proc = subprocess.run(
            ["docker", "run", "--rm", "--entrypoint", "sh", image, "-c", PROBE],
            capture_output=True, text=True)
        result = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else ""
        if proc.returncode != 0 or result != "ok":
            failures.append(
                f"{param} = {image}: {'`ps` is missing' if result == 'no-ps' else result or proc.stderr.strip()}")
        else:
            print(f"[ok] {param}: {image} provides ps")

    if failures:
        print("\nPROBLEM(S):", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        print("\nNextflow runs `nxf_trace` inside the container and exits 1 when `ps` is "
              "absent, so this image would fail every task under -with-trace/-with-report. "
              "Use an image that ships procps (Debian/Ubuntu: procps; conda: procps-ng).",
              file=sys.stderr)
        return 1

    print(f"\nCONTAINER CHECKS PASSED ({len(images)} image(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
