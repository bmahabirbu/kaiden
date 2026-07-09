#!/usr/bin/env python3
"""
E2E regression tests for OpenShell source directory uploads.
"""

from openshell_testkit import (
    SandboxCase,
    assert_success,
    cleanup_sandbox,
    fail_with_result,
    render_transcript,
    run_command,
    shell_join,
)


def _write_root_project(source_dir):
    (source_dir / 'README.md').write_text('# OpenShell upload fixture\n')
    (source_dir / 'package.json').write_text('{"name":"openshell-upload-fixture"}\n')


def _write_src_project(source_dir):
    (source_dir / 'src').mkdir()
    (source_dir / 'src' / 'main.ts').write_text("export const message = 'uploaded source';\n")
    (source_dir / 'src' / 'worker.ts').write_text("export const worker = 'custom mount';\n")


def _create_sandbox(sandbox_name, upload_args, history):
    run_command(['openshell', 'sandbox', 'delete', sandbox_name], timeout=30)
    result = run_command(
        [
            'openshell',
            'sandbox',
            'create',
            '--name',
            sandbox_name,
            *upload_args,
            '--no-tty',
            '--',
            'true',
        ],
        timeout=180,
        label=f'creating sandbox {sandbox_name}',
        history=history,
    )
    assert_success(result, f'Sandbox creation failed for {sandbox_name}', history)


def _delete_sandbox(sandbox_name):
    result = cleanup_sandbox(sandbox_name, label=f'deleting sandbox {sandbox_name}')
    if result and result.returncode != 0:
        print(render_transcript(result, label='sandbox delete'), flush=True)


def _assert_exec_contains(sandbox, command, expected, label):
    result = sandbox.exec(command, label=f'running: {shell_join(command)}')
    assert_success(result, label, sandbox.history)
    combined = '\n'.join(part for part in [result.stdout, result.stderr] if part)
    if expected not in combined:
        fail_with_result(f'Expected "{expected}" in command output', result, sandbox.history)


def test_source_uploads_are_accessible_from_sandbox(gateway_ready, tmp_path_factory):
    source_dir = tmp_path_factory.mktemp('openshell-source-upload')
    src_mount_dir = tmp_path_factory.mktemp('openshell-source-subdir-upload')
    _write_root_project(source_dir)
    _write_src_project(src_mount_dir)

    sandbox_name = 'kdn-e2e-source-upload'
    history = []
    _create_sandbox(
        sandbox_name,
        ['--upload', f'{source_dir}:.', '--upload', f'{src_mount_dir / "src"}:.'],
        history,
    )
    sandbox = SandboxCase(name=sandbox_name, config={}, generated_config=None, history=history)

    try:
        _assert_exec_contains(
            sandbox,
            ['ls', '-la'],
            source_dir.name,
            'uploaded source directory was not visible from the sandbox working directory',
        )
        _assert_exec_contains(
            sandbox,
            ['cat', f'{source_dir.name}/package.json'],
            'openshell-upload-fixture',
            'uploaded package.json was not readable from the sandbox working directory',
        )
        _assert_exec_contains(
            sandbox,
            ['cat', f'{source_dir.name}/README.md'],
            'OpenShell upload fixture',
            'uploaded README.md was not readable from the sandbox working directory',
        )
        _assert_exec_contains(
            sandbox,
            ['ls', 'src'],
            'worker.ts',
            'uploaded $SOURCES/src custom mount was not visible at src/',
        )
        _assert_exec_contains(
            sandbox,
            ['cat', 'src/main.ts'],
            'uploaded source',
            'uploaded $SOURCES/src file was not readable at src/main.ts',
        )
    finally:
        _delete_sandbox(sandbox_name)
