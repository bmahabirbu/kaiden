import json
import platform
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from agent_cases import AGENT_CASES, agent_case_id
from openshell_testkit import (
    SandboxCase,
    assert_success,
    fail_with_history,
    generate_configs,
    render_transcript,
    require_gateway_ready,
    require_openshell_preflight,
    run_command,
    write_generated_config,
)


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


@pytest.fixture(scope='session')
def openshell_preflight():
    return require_openshell_preflight()


@pytest.fixture(scope='module')
def gateway_ready(openshell_preflight):
    history = []
    return require_gateway_ready(history)


@pytest.fixture(scope='module', params=AGENT_CASES, ids=agent_case_id)
def agent_case(request):
    return request.param


@pytest.fixture(scope='module')
def sandbox_case(agent_case, gateway_ready, tmp_path_factory):
    agent = agent_case['agent']
    sandbox_name = f'kdn-e2e-test_sandbox_mcp-{agent}'
    temp_dir = tmp_path_factory.mktemp(f'kdn-e2e-{agent}')
    history = []
    sandbox_created = False

    run_command(
        ['openshell', 'sandbox', 'delete', sandbox_name],
        timeout=30,
    )

    try:
        generated = generate_configs(agent_case, history=history)
    except RuntimeError as exc:
        fail_with_history(
            f'failed to generate Kaiden config files for {agent}: {exc}',
            history,
        )

    policy_path, agent_config_path = write_generated_config(generated, temp_dir)
    uploads = [
        f'{agent_config_path}:{generated.agent_config_upload_path}',
        *[f'{upload["local"]}:{upload["remote"]}' for upload in generated.skill_uploads],
    ]
    upload_args = [arg for upload in uploads for arg in ['--upload', upload]]

    create_result = run_command(
        [
            'openshell',
            'sandbox',
            'create',
            '--name',
            sandbox_name,
            *upload_args,
            '--no-tty',
            '--policy',
            policy_path,
            '--',
            'true',
        ],
        timeout=180,
        label='creating sandbox',
        history=history,
    )
    assert_success(
        create_result,
        f'Sandbox creation failed (exit {create_result.returncode})',
        history,
    )

    list_result = run_command(
        ['openshell', 'sandbox', 'list'],
        timeout=30,
        label='listing sandboxes',
        history=history,
    )
    assert_success(list_result, 'openshell sandbox list failed', history)
    if sandbox_name not in list_result.stdout:
        fail_with_history(f'Sandbox {sandbox_name} not found after creation', history)

    sandbox_created = True

    yield SandboxCase(name=sandbox_name, config=agent_case, generated_config=generated, history=history)

    if sandbox_created:
        delete_result = run_command(
            ['openshell', 'sandbox', 'delete', sandbox_name],
            timeout=30,
            label=f'deleting sandbox {sandbox_name}',
        )
        if delete_result.returncode != 0:
            print(render_transcript(delete_result, label='sandbox delete'), flush=True)
