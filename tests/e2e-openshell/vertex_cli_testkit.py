import os
import shutil
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import pytest

from openshell_testkit import (
    SandboxCase,
    assert_success,
    fail_with_history,
    generate_configs,
    render_transcript,
    run_command,
    write_generated_config,
)


VERTEX_PROVIDER_TYPE = 'google-vertex-ai'
VERTEX_LLM_METADATA_NAME = 'vertexai'
DEFAULT_VERTEX_MODEL = 'claude-sonnet-4-6'
DEFAULT_ADC_PATH = Path.home() / '.config' / 'gcloud' / 'application_default_credentials.json'


@dataclass(frozen=True)
class VertexCliConfig:
    project_id: str
    region: str
    model: str
    credentials_env: dict[str, str]
    uses_default_adc: bool


def _first_env(names):
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return None


def _gcloud_config_project():
    if not shutil.which('gcloud'):
        return None
    result = run_command(['gcloud', 'config', 'get-value', 'project'], timeout=10, label='reading gcloud project')
    if result.returncode != 0:
        return None
    project = result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ''
    return project if project and project != '(unset)' else None


def load_vertex_cli_config():
    credentials_file = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')
    credentials_env = {}
    uses_default_adc = False

    if credentials_file:
        credentials_path = Path(credentials_file).expanduser()
        if not credentials_path.is_file():
            pytest.skip(f'GOOGLE_APPLICATION_CREDENTIALS does not point to a readable file: {credentials_path}')
        credentials_env['GOOGLE_APPLICATION_CREDENTIALS'] = str(credentials_path)
    elif DEFAULT_ADC_PATH.is_file():
        uses_default_adc = True
    else:
        pytest.skip(
            'Vertex AI ADC not found; set GOOGLE_APPLICATION_CREDENTIALS or run gcloud auth application-default login'
        )

    project_id = _first_env(
        [
            'VERTEX_AI_PROJECT_ID',
            'GOOGLE_CLOUD_PROJECT',
            'GOOGLE_PROJECT_ID',
            'GCP_PROJECT',
            'GCLOUD_PROJECT',
        ]
    ) or _gcloud_config_project()
    if not project_id:
        pytest.skip('Vertex AI project not found; set VERTEX_AI_PROJECT_ID or GOOGLE_CLOUD_PROJECT')

    region = _first_env(
        [
            'VERTEX_AI_REGION',
            'GOOGLE_CLOUD_LOCATION',
            'GOOGLE_VERTEX_LOCATION',
            'CLOUD_ML_REGION',
            'GOOGLE_CLOUD_REGION',
        ]
    )
    if not region:
        pytest.skip('Vertex AI region not found; set VERTEX_AI_REGION or GOOGLE_CLOUD_LOCATION')

    return VertexCliConfig(
        project_id=project_id,
        region=region,
        model=os.environ.get('KAIDEN_E2E_VERTEX_MODEL', DEFAULT_VERTEX_MODEL),
        credentials_env=credentials_env,
        uses_default_adc=uses_default_adc,
    )


@contextmanager
def vertex_agent_sandbox(
    *,
    vertex_cli_config,
    tmp_path_factory,
    agent,
    settings_path,
    model_endpoint,
    sandbox_name,
    description,
    config=None,
):
    provider_name = f'{sandbox_name}-{os.getpid()}'
    temp_dir = tmp_path_factory.mktemp(sandbox_name)
    history = []
    sandbox_created = False
    provider_created = False

    run_command(['openshell', 'sandbox', 'delete', sandbox_name], timeout=30)
    run_command(['openshell', 'provider', 'delete', provider_name], timeout=30)

    try:
        try:
            generated = generate_configs(
                {
                    'agent': agent,
                    'settingsPath': settings_path,
                    'modelLabel': vertex_cli_config.model,
                    'llmMetadataName': VERTEX_LLM_METADATA_NAME,
                    'modelEndpoint': model_endpoint,
                },
                history=history,
            )
        except RuntimeError as exc:
            fail_with_history(f'failed to generate {description} Vertex config: {exc}', history)

        if not generated.policy:
            fail_with_history('expected Kaiden to generate an OpenShell policy for inference.local', history)

        provider_create_cmd = [
            'openshell',
            'provider',
            'create',
            '--name',
            provider_name,
            '--type',
            VERTEX_PROVIDER_TYPE,
            '--config',
            f'VERTEX_AI_PROJECT_ID={vertex_cli_config.project_id}',
            '--config',
            f'VERTEX_AI_REGION={vertex_cli_config.region}',
        ]
        if vertex_cli_config.uses_default_adc:
            provider_create_cmd.append('--from-gcloud-adc')
        else:
            provider_create_cmd.extend(['--credential', 'GOOGLE_APPLICATION_CREDENTIALS', '--from-gcloud-adc'])

        create_provider_result = run_command(
            provider_create_cmd,
            timeout=120,
            env=vertex_cli_config.credentials_env,
            label='creating OpenShell Vertex provider',
            history=history,
        )
        assert_success(create_provider_result, 'OpenShell Vertex provider creation failed', history)
        provider_created = True

        set_inference_result = run_command(
            [
                'openshell',
                'inference',
                'set',
                '--provider',
                provider_name,
                '--model',
                vertex_cli_config.model,
                '--no-verify',
            ],
            timeout=60,
            label='setting OpenShell inference route',
            history=history,
        )
        assert_success(set_inference_result, 'OpenShell inference route setup failed', history)

        policy_path, agent_config_paths = write_generated_config(generated, temp_dir)
        upload_args = [
            arg
            for config_file in agent_config_paths
            for arg in ['--upload', f'{config_file["local"]}:{config_file["remote"]}']
        ]
        env_args = [
            arg
            for entry in generated.workspace_environment
            for arg in ['--env', f'{entry["name"]}={entry["value"]}']
        ]

        create_sandbox_result = run_command(
            [
                'openshell',
                'sandbox',
                'create',
                '--name',
                sandbox_name,
                '--provider',
                provider_name,
                *env_args,
                *upload_args,
                '--no-tty',
                '--policy',
                policy_path,
                '--',
                'true',
            ],
            timeout=180,
            label=f'creating {description} Vertex sandbox',
            history=history,
        )
        assert_success(create_sandbox_result, f'{description} Vertex sandbox creation failed', history)
        sandbox_created = True

        yield SandboxCase(
            name=sandbox_name,
            config={'vertexModel': vertex_cli_config.model, **(config or {})},
            generated_config=generated,
            history=history,
        )
    finally:
        if sandbox_created:
            delete_result = run_command(
                ['openshell', 'sandbox', 'delete', sandbox_name],
                timeout=30,
                label=f'deleting sandbox {sandbox_name}',
            )
            if delete_result.returncode != 0:
                print(render_transcript(delete_result, label='sandbox delete'), flush=True)

        if provider_created:
            delete_provider_result = run_command(
                ['openshell', 'provider', 'delete', provider_name],
                timeout=30,
                label=f'deleting provider {provider_name}',
            )
            if delete_provider_result.returncode != 0:
                print(render_transcript(delete_provider_result, label='provider delete'), flush=True)
