#!/usr/bin/env python3
"""
E2E regression tests for OpenShell GitHub credential uploads.
"""

import os

import pytest

from openshell_testkit import (
    SandboxCase,
    assert_success,
    cleanup_sandbox,
    fail_with_result,
    render_transcript,
    run_command,
    shell_join,
)


GITHUB_TOKEN_ENV = 'KAIDEN_E2E_GITHUB_TOKEN'


@pytest.fixture(scope='module')
def github_token():
    token = os.environ.get(GITHUB_TOKEN_ENV)
    if not token:
        pytest.skip(f'{GITHUB_TOKEN_ENV} is not set')
    return token


@pytest.fixture(scope='module')
def github_credentials_sandbox(github_token, gateway_ready):
    provider_name = f'kdn-e2e-github-{os.getpid()}'
    sandbox_name = 'kdn-e2e-github-credentials'
    history = []
    provider_created = False
    sandbox_created = False

    run_command(['openshell', 'provider', 'delete', provider_name], timeout=30)
    run_command(['openshell', 'sandbox', 'delete', sandbox_name], timeout=30)

    try:
        provider_result = run_command(
            [
                'openshell',
                'provider',
                'create',
                '--name',
                provider_name,
                '--type',
                'github',
                '--from-existing',
            ],
            timeout=60,
            label=f'creating GitHub provider {provider_name}',
            history=history,
            env={'GITHUB_TOKEN': github_token},
        )
        assert_success(provider_result, 'GitHub provider creation failed', history)
        provider_created = True

        create_result = run_command(
            [
                'openshell',
                'sandbox',
                'create',
                '--name',
                sandbox_name,
                '--provider',
                provider_name,
                '--no-tty',
                '--',
                'true',
            ],
            timeout=180,
            label='creating GitHub credential sandbox',
            history=history,
        )
        assert_success(create_result, 'GitHub credential sandbox creation failed', history)
        sandbox_created = True

        yield SandboxCase(
            name=sandbox_name,
            config={'providerName': provider_name},
            generated_config=None,
            history=history,
        )
    finally:
        if sandbox_created:
            delete_result = cleanup_sandbox(sandbox_name, label=f'deleting sandbox {sandbox_name}')
            if delete_result and delete_result.returncode != 0:
                print(render_transcript(delete_result, label='sandbox delete'), flush=True)

        if provider_created:
            delete_provider_result = run_command(
                ['openshell', 'provider', 'delete', provider_name],
                timeout=30,
                label=f'deleting provider {provider_name}',
            )
            if delete_provider_result.returncode != 0:
                print(render_transcript(delete_provider_result, label='provider delete'), flush=True)


def test_github_token_env_is_uploaded(github_credentials_sandbox):
    command = ['sh', '-lc', 'test -n "$GITHUB_TOKEN"']
    result = github_credentials_sandbox.exec(command, label=f'running: {shell_join(command)}')
    assert_success(result, 'GITHUB_TOKEN was not available in the sandbox', github_credentials_sandbox.history)


def test_github_rest_api_uses_uploaded_token(github_credentials_sandbox):
    command = ['gh', 'api', '/user', '--jq', '.login']
    result = github_credentials_sandbox.exec(command, timeout=60, label=f'running: {shell_join(command)}')
    assert_success(result, 'gh api /user failed with the uploaded GitHub token', github_credentials_sandbox.history)

    if not result.stdout.strip():
        fail_with_result(
            'expected gh api /user to return the authenticated GitHub login',
            result,
            github_credentials_sandbox.history,
        )
