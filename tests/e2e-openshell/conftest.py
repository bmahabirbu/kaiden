import json
import platform
import re
import shutil
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
OPENSHELL_PKG = REPO_ROOT / "extensions" / "openshell" / "package.json"


def _read_pinned_version():
    try:
        with OPENSHELL_PKG.open() as f:
            pkg = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return "unknown"
    return pkg.get("openshellVersion", "unknown")


def _run(cmd, timeout=15):
    try:
        return subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            cwd=REPO_ROOT,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None


def _gateway_endpoint(output):
    if not output:
        return None
    output = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", output)
    match = re.search(r"Server:\s*(\S+)", output)
    return match.group(1) if match else None


def pytest_report_header(config):
    host = f"{platform.system()} {platform.machine()}"
    pinned = _read_pinned_version()
    openshell_path = shutil.which("openshell")

    if not openshell_path:
        return [
            f"openshell e2e host: {host}",
            f"openshell e2e openshell: missing from PATH (pinned {pinned})",
            "openshell e2e gateway: unavailable",
        ]

    version_result = _run(["openshell", "--version"])
    if version_result is None:
        openshell_line = f"openshell e2e openshell: {openshell_path} (version check failed, pinned {pinned})"
    else:
        installed = version_result.stdout.strip() or "unknown version"
        openshell_line = f"openshell e2e openshell: {installed} at {openshell_path} (pinned {pinned})"

    gateway_result = _run(["openshell", "status"])
    if gateway_result is None:
        gateway_line = "openshell e2e gateway: status check failed"
    else:
        endpoint = _gateway_endpoint((gateway_result.stdout or "") + "\n" + (gateway_result.stderr or ""))
        endpoint_suffix = f" ({endpoint})" if endpoint else ""
        status = "connected" if gateway_result.returncode == 0 else "unreachable"
        gateway_line = f"openshell e2e gateway: {status}{endpoint_suffix}"

    return [
        f"openshell e2e host: {host}",
        openshell_line,
        gateway_line,
    ]
