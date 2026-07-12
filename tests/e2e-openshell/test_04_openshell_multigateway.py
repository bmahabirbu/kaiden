#!/usr/bin/env python3
"""
E2E regression tests for OpenShell multigateway sandbox operations.
"""

import json
import os
import shutil
import socket
import subprocess
import time
from urllib.parse import urlparse

import pytest

from openshell_testkit import (
    assert_success,
    env_flag,
    fail_with_result,
    render_transcript,
    run_command,
)


MULTIGATEWAY_NAME_ENV = 'KAIDEN_E2E_MULTIGATEWAY_NAME'
MULTIGATEWAY_ENDPOINT_ENV = 'KAIDEN_E2E_MULTIGATEWAY_ENDPOINT'
KEEP_GATEWAY_ENV = 'KAIDEN_E2E_KEEP_GATEWAY'
DEFAULT_MULTIGATEWAY_NAME = 'kaiden'
GATEWAY_READY_TIMEOUT_SECONDS = 30
SANDBOX_CREATE_ATTEMPTS = 3
SANDBOX_READY_TIMEOUT_SECONDS = 180


def _json_output(result, history):
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        fail_with_result('Expected OpenShell JSON output', result, history)


def _list_gateways(history):
    result = run_command(
        ['openshell', 'gateway', 'list', '-o', 'json'],
        timeout=30,
        label='listing gateways',
        history=history,
    )
    assert_success(result, 'openshell gateway list failed', history)
    gateways = _json_output(result, history)
    if not isinstance(gateways, list):
        fail_with_result('Expected openshell gateway list to return a JSON array', result, history)
    return gateways


def _gateway_by_name(gateways, name):
    return next((gateway for gateway in gateways if gateway.get('name') == name), None)


def _candidate_gateway_names(gateways, excluded_name):
    active_gateway = next(
        (gateway for gateway in gateways if gateway.get('active') and gateway.get('name') != excluded_name),
        None,
    )
    names = [gateway.get('name') for gateway in gateways if gateway.get('name') != excluded_name]
    if active_gateway:
        active_name = active_gateway.get('name')
        return [active_name, *[name for name in names if name != active_name]]
    return names


def _status_gateway(name, history):
    return run_command(
        ['openshell', 'status', '--gateway', name],
        timeout=15,
        label=f'checking gateway {name}',
        history=history,
    )


def _reachable_gateway_name(gateways, excluded_name, history):
    for name in _candidate_gateway_names(gateways, excluded_name):
        if not name:
            continue
        status_result = _status_gateway(name, history)
        if status_result.returncode == 0:
            return name
    return None


def _remove_gateway(name, history=None):
    return run_command(
        ['openshell', 'gateway', 'remove', name],
        timeout=30,
        label=f'removing gateway {name}',
        history=history,
    )


def _add_local_gateway(name, endpoint, history):
    return run_command(
        ['openshell', 'gateway', 'add', endpoint, '--name', name, '--local'],
        timeout=60,
        label=f'adding gateway {name}',
        history=history,
    )


def _allocate_gateway_endpoint():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(('127.0.0.1', 0))
        _, port = sock.getsockname()
    return f'https://127.0.0.1:{port}'


def _gateway_process_args(endpoint):
    url = urlparse(endpoint)
    if url.scheme != 'https' or url.hostname not in {'127.0.0.1', 'localhost'}:
        pytest.skip(
            f'OpenShell E2E can auto-start only local TLS gateways; configured endpoint is {endpoint}'
        )

    port = url.port
    if port is None:
        pytest.skip(f'OpenShell E2E gateway endpoint must include a port: {endpoint}')

    return [
        'openshell-gateway',
        '--port',
        str(port),
        '--bind-address',
        # Podman sandbox containers need to reach the gateway through the host network bridge.
        '0.0.0.0',
    ]


def _start_gateway_process(endpoint):
    if not shutil.which('openshell-gateway'):
        pytest.skip('openshell-gateway not found in PATH')

    args = _gateway_process_args(endpoint)
    return subprocess.Popen(args, cwd=os.getcwd(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def _wait_for_gateway(name, endpoint, process, history):
    deadline = time.monotonic() + GATEWAY_READY_TIMEOUT_SECONDS

    while time.monotonic() < deadline:
        if process.poll() is not None:
            stdout, stderr = process.communicate()
            pytest.fail(
                '\n'.join(
                    [
                        f'openshell-gateway exited before {name} became ready at {endpoint}',
                        'stdout:',
                        stdout or '<empty>',
                        'stderr:',
                        stderr or '<empty>',
                    ]
                ),
                pytrace=False,
            )

        status_result = _status_gateway(name, history)
        if status_result.returncode == 0:
            return
        time.sleep(1)

    process.terminate()
    try:
        stdout, stderr = process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        stdout, stderr = process.communicate(timeout=5)
    pytest.fail(
        '\n'.join(
            [
                f'openshell-gateway did not make {name} ready at {endpoint}',
                'stdout:',
                stdout or '<empty>',
                'stderr:',
                stderr or '<empty>',
            ]
        ),
        pytrace=False,
    )


def _stop_gateway_process(process):
    if process is None or process.poll() is not None:
        return

    process.terminate()
    try:
        process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.communicate(timeout=5)


def _select_gateway(name, history=None):
    return run_command(
        ['openshell', 'gateway', 'select', name],
        timeout=30,
        label=f'selecting gateway {name}',
        history=history,
    )


def _sandbox_names_for_gateways(base_gateway, secondary_gateway):
    return {
        base_gateway: 'kdn-e2e-multigateway-base',
        secondary_gateway: 'kdn-e2e-multigateway-secondary',
    }


def _delete_sandbox(gateway_name, sandbox_name, history=None):
    return run_command(
        ['openshell', 'sandbox', 'delete', '--gateway', gateway_name, sandbox_name],
        timeout=90,
        label=f'deleting sandbox {sandbox_name} on gateway {gateway_name}',
        history=history,
    )


def _create_sandbox(gateway_name, sandbox_name, history):
    for attempt in range(1, SANDBOX_CREATE_ATTEMPTS + 1):
        _delete_sandbox(gateway_name, sandbox_name)
        result = run_command(
            [
                'openshell',
                'sandbox',
                'create',
                '--gateway',
                gateway_name,
                '--name',
                sandbox_name,
                '--no-tty',
                '--',
                'true',
            ],
            timeout=180,
            label=f'creating sandbox {sandbox_name} on gateway {gateway_name} (attempt {attempt})',
            history=history,
        )
        if result.returncode == 0 and not result.timed_out:
            return

        combined = f'{result.stdout}\n{result.stderr}'
        if attempt < SANDBOX_CREATE_ATTEMPTS and 'sandbox is not ready' in combined:
            time.sleep(2)
            continue

        assert_success(result, f'Sandbox creation failed for {sandbox_name} on gateway {gateway_name}', history)


def _sandbox_list_for_gateway(gateway_name, history):
    result = run_command(
        ['openshell', 'sandbox', 'list', '--gateway', gateway_name, '-o', 'json'],
        timeout=30,
        label=f'listing sandboxes on gateway {gateway_name}',
        history=history,
    )
    assert_success(result, f'openshell sandbox list failed for gateway {gateway_name}', history)
    sandboxes = _json_output(result, history)
    if not isinstance(sandboxes, list):
        fail_with_result('Expected openshell sandbox list to return a JSON array', result, history)
    return sandboxes


def _assert_sandbox_listed(gateway_name, sandbox_name, history):
    sandboxes = _sandbox_list_for_gateway(gateway_name, history)
    if not _gateway_by_name(sandboxes, sandbox_name):
        pytest.fail(f'Sandbox {sandbox_name} was not listed on gateway {gateway_name}', pytrace=False)


def _wait_for_sandbox_ready(gateway_name, sandbox_name, history):
    deadline = time.monotonic() + SANDBOX_READY_TIMEOUT_SECONDS
    last_phase = None

    while time.monotonic() < deadline:
        sandboxes = _sandbox_list_for_gateway(gateway_name, history)
        sandbox = _gateway_by_name(sandboxes, sandbox_name)
        if not sandbox:
            last_phase = 'missing'
        else:
            last_phase = sandbox.get('phase')
            if last_phase == 'Ready':
                return
            if last_phase in {'Error', 'Deleting', 'Unknown'}:
                pytest.fail(
                    f'Sandbox {sandbox_name} on gateway {gateway_name} entered {last_phase} before becoming Ready',
                    pytrace=False,
                )
        time.sleep(2)

    pytest.fail(
        f'Sandbox {sandbox_name} on gateway {gateway_name} did not become Ready within '
        f'{SANDBOX_READY_TIMEOUT_SECONDS}s; last phase: {last_phase}',
        pytrace=False,
    )


def _assert_sandbox_exec(gateway_name, sandbox_name, expected, history):
    result = run_command(
        [
            'openshell',
            'sandbox',
            'exec',
            '--gateway',
            gateway_name,
            '--name',
            sandbox_name,
            '--timeout',
            '30',
            '--',
            'printf',
            '%s',
            expected,
        ],
        timeout=45,
        label=f'executing command in sandbox {sandbox_name} on gateway {gateway_name}',
        history=history,
    )
    assert_success(result, f'Sandbox exec failed for {sandbox_name} on gateway {gateway_name}', history)
    if result.stdout != expected:
        fail_with_result(f'Expected sandbox exec to print {expected!r}', result, history)


@pytest.fixture(scope='module')
def multigateway_ready(openshell_preflight):
    history = []
    gateway_name = os.environ.get(MULTIGATEWAY_NAME_ENV, DEFAULT_MULTIGATEWAY_NAME)
    configured_endpoint = os.environ.get(MULTIGATEWAY_ENDPOINT_ENV)
    endpoint = configured_endpoint
    gateways = _list_gateways(history)
    original_gateway = _reachable_gateway_name(gateways, gateway_name, history)
    if not original_gateway:
        pytest.skip('no reachable non-test OpenShell gateway is configured')

    gateway_added = False
    gateway_process = None

    try:
        gateway = _gateway_by_name(gateways, gateway_name)
        if gateway:
            if configured_endpoint and gateway.get('endpoint') != configured_endpoint:
                pytest.fail(
                    f'Gateway {gateway_name} endpoint was {gateway.get("endpoint")!r}, expected {configured_endpoint!r}',
                    pytrace=False,
                )
            endpoint = gateway.get('endpoint') or endpoint
            status_result = _status_gateway(gateway_name, history)
            if status_result.returncode != 0:
                endpoint = configured_endpoint or _allocate_gateway_endpoint()
                _remove_gateway(gateway_name, history)
                gateway = None

        if not gateway:
            endpoint = endpoint or _allocate_gateway_endpoint()
            gateway_process = _start_gateway_process(endpoint)
            add_result = _add_local_gateway(gateway_name, endpoint, history)
            assert_success(add_result, f'OpenShell gateway add failed for {gateway_name}', history)
            gateway_added = True
            _wait_for_gateway(gateway_name, endpoint, gateway_process, history)

            gateways = _list_gateways(history)
            gateway = _gateway_by_name(gateways, gateway_name)

        if not gateway:
            pytest.fail(f'Gateway {gateway_name} was not listed after add', pytrace=False)
        if configured_endpoint and gateway.get('endpoint') != endpoint:
            pytest.fail(
                f'Gateway {gateway_name} endpoint was {gateway.get("endpoint")!r}, expected {endpoint!r}',
                pytrace=False,
            )

        status_result = _status_gateway(gateway_name, history)
        if status_result.returncode != 0:
            pytest.skip(f'OpenShell gateway {gateway_name} is not reachable at {endpoint}')

        yield {
            'base_gateway': original_gateway,
            'secondary_gateway': gateway_name,
            'endpoint': endpoint,
            'history': history,
        }
    finally:
        if original_gateway:
            select_result = _select_gateway(original_gateway)
            if select_result.returncode != 0:
                print(render_transcript(select_result, label='gateway restore'), flush=True)

        if gateway_added:
            if env_flag(KEEP_GATEWAY_ENV):
                print(
                    f'Preserving OpenShell gateway {gateway_name}; unset {KEEP_GATEWAY_ENV} to restore cleanup.',
                    flush=True,
                )
            else:
                remove_result = _remove_gateway(gateway_name)
                if remove_result.returncode != 0:
                    print(render_transcript(remove_result, label='gateway remove'), flush=True)

        if not env_flag(KEEP_GATEWAY_ENV):
            _stop_gateway_process(gateway_process)


def test_multigateway_registration_can_connect(multigateway_ready):
    assert multigateway_ready['secondary_gateway']
    assert multigateway_ready['endpoint']


def test_multigateway_sandboxes_execute_on_selected_gateways(multigateway_ready):
    base_gateway = multigateway_ready['base_gateway']
    secondary_gateway = multigateway_ready['secondary_gateway']
    history = multigateway_ready['history']
    sandbox_names = _sandbox_names_for_gateways(base_gateway, secondary_gateway)
    created_sandboxes = []

    try:
        for gateway_name, sandbox_name in sandbox_names.items():
            _create_sandbox(gateway_name, sandbox_name, history)
            created_sandboxes.append((gateway_name, sandbox_name))
            _assert_sandbox_listed(gateway_name, sandbox_name, history)
            _wait_for_sandbox_ready(gateway_name, sandbox_name, history)

        _assert_sandbox_exec(
            base_gateway,
            sandbox_names[base_gateway],
            f'connected:{base_gateway}',
            history,
        )
        _assert_sandbox_exec(
            secondary_gateway,
            sandbox_names[secondary_gateway],
            f'connected:{secondary_gateway}',
            history,
        )
    finally:
        for gateway_name, sandbox_name in reversed(created_sandboxes):
            delete_result = _delete_sandbox(gateway_name, sandbox_name)
            if delete_result.returncode != 0:
                print(render_transcript(delete_result, label='sandbox delete'), flush=True)
