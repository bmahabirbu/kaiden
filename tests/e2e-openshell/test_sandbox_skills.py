#!/usr/bin/env python3
"""
E2E regression tests for agent skill discovery inside OpenShell sandboxes.
"""

import pytest

from agent_cases import AGENT_SKILL_CASES, agent_case_id
from openshell_testkit import (
    SandboxCase,
    assert_success,
    cleanup_sandbox,
    fail_with_history,
    fail_with_result,
    generate_configs,
    render_transcript,
    run_command,
    shell_join,
    write_generated_config,
)


def _skill_read_command(generated, case):
    skill_path = case['skills'][0]
    upload = next(upload for upload in generated.skill_uploads if upload['local'] == skill_path)
    remote = upload['remote'].rstrip('/')
    skill_file = f'{remote}/{case["skillName"]}/SKILL.md' if remote else f'{case["skillName"]}/SKILL.md'
    return ['sh', '-lc', f'cat "$HOME/{skill_file}"']


if AGENT_SKILL_CASES:

    @pytest.fixture(scope='module', params=AGENT_SKILL_CASES, ids=agent_case_id)
    def agent_skill_case(request):
        return request.param

    @pytest.fixture(scope='module')
    def skill_sandbox_case(agent_skill_case, gateway_ready, tmp_path_factory):
        agent = agent_skill_case['agent']
        sandbox_name = f'kdn-e2e-test_sandbox_skills-{agent}'
        temp_dir = tmp_path_factory.mktemp(f'kdn-e2e-skills-{agent}')
        history = []
        sandbox_created = False

        run_command(['openshell', 'sandbox', 'delete', sandbox_name], timeout=30)

        try:
            generated = generate_configs(agent_skill_case, history=history)
        except RuntimeError as exc:
            fail_with_history(f'failed to generate Kaiden skill config for {agent}: {exc}', history)

        policy_path, agent_config_paths = write_generated_config(generated, temp_dir)
        uploads = [
            *[f'{config["local"]}:{config["remote"]}' for config in agent_config_paths],
            *[f'{upload["local"]}:{upload["remote"]}' for upload in generated.skill_uploads],
        ]
        upload_args = [arg for upload in uploads for arg in ['--upload', upload]]
        policy_args = ['--policy', policy_path] if policy_path else []

        create_result = run_command(
            [
                'openshell',
                'sandbox',
                'create',
                '--name',
                sandbox_name,
                *upload_args,
                '--no-tty',
                *policy_args,
                '--',
                'true',
            ],
            timeout=180,
            label='creating skill sandbox',
            history=history,
        )
        assert_success(create_result, f'{agent} skill sandbox creation failed', history)
        sandbox_created = True

        yield SandboxCase(name=sandbox_name, config=agent_skill_case, generated_config=generated, history=history)

        if sandbox_created:
            delete_result = cleanup_sandbox(sandbox_name, label=f'deleting sandbox {sandbox_name}')
            if delete_result and delete_result.returncode != 0:
                print(render_transcript(delete_result, label='sandbox delete'), flush=True)

    class TestSkillDiscovery:
        def test_agent_skill_file_uploaded(self, skill_sandbox_case):
            read_cmd = _skill_read_command(skill_sandbox_case.generated_config, skill_sandbox_case.config)
            result = skill_sandbox_case.exec(read_cmd, label=f'running: {shell_join(read_cmd)}')
            assert_success(
                result,
                f'{skill_sandbox_case.config["agent"]} skill file was not readable',
                skill_sandbox_case.history,
            )

            if f'name: {skill_sandbox_case.config["skillName"]}' not in result.stdout:
                fail_with_result(
                    f'Expected "{skill_sandbox_case.config["skillName"]}" in uploaded skill file',
                    result,
                    skill_sandbox_case.history,
                )

        def test_agent_skill_list_sees_uploaded_skill(self, skill_sandbox_case):
            list_cmd = skill_sandbox_case.config['skillListCommand']
            result = skill_sandbox_case.exec(list_cmd, timeout=60, label=f'running: {shell_join(list_cmd)}')
            assert_success(
                result,
                f'{skill_sandbox_case.config["agent"]} skill list command failed',
                skill_sandbox_case.history,
            )

            combined = '\n'.join(part for part in [result.stdout, result.stderr] if part)
            if skill_sandbox_case.config['skillListOutput'] not in combined:
                fail_with_result(
                    f'Expected "{skill_sandbox_case.config["skillListOutput"]}" in skill list output',
                    result,
                    skill_sandbox_case.history,
                )
