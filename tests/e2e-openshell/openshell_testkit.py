import json
import os
import shlex
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
GENERATE_SCRIPT = Path(__file__).with_name('generate-config.mts')
OPENSHELL_PKG = REPO_ROOT / 'extensions' / 'openshell' / 'package.json'
KEEP_SANDBOXES_ENV = 'KAIDEN_E2E_KEEP_SANDBOXES'


@dataclass
class CommandResult:
    cmd: list[str]
    returncode: int
    stdout: str
    stderr: str
    timed_out: bool = False


@dataclass
class CommandRecord:
    label: str | None
    result: CommandResult


@dataclass
class GeneratedConfig:
    policy: str
    agent_config_contents: str
    agent_config_upload_path: str
    agent_config_files: list[dict[str, str]]
    skill_uploads: list[dict[str, str]]
    workspace_environment: list[dict[str, str]]


@dataclass
class SandboxCase:
    name: str
    config: dict
    generated_config: GeneratedConfig
    history: list[CommandRecord] = field(default_factory=list)

    def exec(self, command, *, timeout=60, label=None):
        return sandbox_exec(self.name, command, timeout=timeout, label=label, history=self.history)


def get_pinned_openshell_version():
    with OPENSHELL_PKG.open() as f:
        pkg = json.load(f)
    version_str = pkg.get('openshellVersion', '')
    if not version_str:
        raise RuntimeError(f'missing "openshellVersion" in {OPENSHELL_PKG}')
    return tuple(int(x) for x in version_str.split('.'))


def shell_join(cmd):
    return ' '.join(shlex.quote(str(part)) for part in cmd)


def env_flag(name):
    return os.environ.get(name, '').strip().lower() in {'1', 'true', 'yes', 'on'}


def keep_sandboxes():
    return env_flag(KEEP_SANDBOXES_ENV)


def cleanup_sandbox(sandbox_name, *, timeout=30, label=None):
    if keep_sandboxes():
        print(
            f'Preserving OpenShell sandbox {sandbox_name}; unset {KEEP_SANDBOXES_ENV} to restore cleanup.',
            flush=True,
        )
        return None

    return run_command(
        ['openshell', 'sandbox', 'delete', sandbox_name],
        timeout=timeout,
        label=label or f'deleting sandbox {sandbox_name}',
    )


def normalize_output(value):
    if value is None:
        return ''
    if isinstance(value, bytes):
        return value.decode(errors='replace')
    return value


def indent_block(text, prefix='  '):
    if not text:
        return f'{prefix}<empty>'
    return '\n'.join(f'{prefix}{line}' for line in text.splitlines())


def render_transcript(result, *, label=None):
    lines = []
    if label:
        lines.append(f'[{label}]')
    lines.append(f'$ {shell_join(result.cmd)}')
    lines.append(f'exit_code: {result.returncode}')
    if result.timed_out:
        lines.append('timed_out: true')
    lines.append('stdout:')
    lines.append(indent_block(result.stdout))
    if result.stderr:
        lines.append('stderr:')
        lines.append(indent_block(result.stderr))
    return '\n'.join(lines)


def add_history(history, result, *, label=None):
    if history is not None:
        history.append(CommandRecord(label=label, result=result))


def render_history(history):
    if not history:
        return 'No command transcripts captured.'
    return 'Command transcripts:\n\n' + '\n\n'.join(
        render_transcript(record.result, label=record.label) for record in history
    )


def fail_with_history(message, history=None):
    details = f'{message}\n\n{render_history(history)}' if history is not None else message
    pytest.fail(details, pytrace=False)


def fail_with_result(message, result, history=None):
    sections = [message]

    sections.extend(
        [
            '',
            'Failing command:',
            render_transcript(result, label=history[-1].label if history else None),
        ]
    )
    pytest.fail('\n'.join(sections), pytrace=False)


def run_command(cmd, *, timeout=120, input_data=None, label=None, history=None, env=None):
    process_env = None
    if env is not None:
        process_env = {**os.environ, **env}

    try:
        completed = subprocess.run(
            [str(part) for part in cmd],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            input=input_data,
            cwd=REPO_ROOT,
            env=process_env,
        )
        result = CommandResult(
            cmd=[str(part) for part in cmd],
            returncode=completed.returncode,
            stdout=normalize_output(completed.stdout),
            stderr=normalize_output(completed.stderr),
        )
    except subprocess.TimeoutExpired as exc:
        result = CommandResult(
            cmd=[str(part) for part in cmd],
            returncode=124,
            stdout=normalize_output(exc.stdout),
            stderr=normalize_output(exc.stderr),
            timed_out=True,
        )

    add_history(history, result, label=label)
    return result


def sandbox_exec(name, command, *, timeout=60, label=None, history=None):
    cmd = ['openshell', 'sandbox', 'exec', '-n', name, '--timeout', str(timeout), '--'] + command
    return run_command(cmd, timeout=timeout + 15, label=label, history=history)


def parse_version(version_str):
    parts = version_str.strip().split()[-1]
    return tuple(int(x) for x in parts.split('.'))


def require_openshell_preflight():
    history = []
    openshell_path = shutil.which('openshell')
    if not openshell_path:
        pytest.skip('openshell not found in PATH')

    result = run_command(
        ['openshell', '--version'],
        label='checking openshell version',
        history=history,
    )
    if result.timed_out or result.returncode != 0:
        fail_with_history('openshell --version failed', history)

    version = parse_version(result.stdout)
    min_version = get_pinned_openshell_version()
    installed = result.stdout.strip()
    pinned = '.'.join(map(str, min_version))

    if version < min_version:
        fail_with_history(f'{installed} < pinned {pinned}', history)

    return {
        'openshell_path': openshell_path,
        'installed': installed,
        'pinned': pinned,
    }


def require_gateway_ready(history=None):
    result = run_command(
        ['openshell', 'status'],
        timeout=15,
        label='checking gateway',
        history=history,
    )
    if result.returncode != 0:
        pytest.skip('openshell gateway not reachable')
    return result


def generate_configs(input_config, *, history=None):
    result = run_command(
        ['node', '--import', 'tsx', GENERATE_SCRIPT],
        input_data=json.dumps(input_config),
        timeout=30,
        label='generating configs from buildPolicyObject()',
        history=history,
    )
    if result.timed_out or result.returncode != 0:
        raise RuntimeError(
            'generate-config.mts failed:\n\n'
            + render_transcript(result, label='generate-config')
        )

    lines = result.stdout.strip().split('\n')
    for line in reversed(lines):
        line = line.strip()
        if line.startswith('{'):
            output = json.loads(line)
            return GeneratedConfig(
                policy=output['policy'],
                agent_config_contents=output['agentConfig']['contents'],
                agent_config_upload_path=output['agentConfig']['uploadPath'],
                agent_config_files=output.get('agentConfigs', [output['agentConfig']]),
                skill_uploads=output['skillUploads'],
                workspace_environment=output.get('workspaceEnvironment', []),
            )

    raise RuntimeError(
        'generate-config.mts produced no JSON output:\n\n'
        + render_transcript(result, label='generate-config')
    )


def write_generated_config(generated, directory):
    policy_path = None
    if generated.policy:
        policy_path = directory / 'policy.yaml'
        policy_path.write_text(generated.policy)

    agent_config_paths = []
    for index, config_file in enumerate(generated.agent_config_files):
        agent_config_path = directory / f'agent-config-{index}.json'
        agent_config_path.write_text(config_file['contents'])
        agent_config_paths.append(
            {
                'local': agent_config_path,
                'remote': config_file['uploadPath'],
            }
        )
    return policy_path, agent_config_paths


def assert_success(result, message, history=None):
    if result.returncode != 0 or result.timed_out:
        fail_with_result(message, result, history)
