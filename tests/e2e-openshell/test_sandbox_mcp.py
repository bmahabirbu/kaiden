#!/usr/bin/env python3
"""
E2E regression tests for Kaiden sandbox MCP configurations.

Requires:
  - openshell CLI in PATH (>= 0.0.77)
  - A configured openshell gateway
  - npx/tsx available for config generation

Run:
  python3 tests/e2e-openshell/test_sandbox_mcp.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
GENERATE_SCRIPT = os.path.join(os.path.dirname(__file__), 'generate-config.mts')
OPENSHELL_PKG = os.path.join(REPO_ROOT, 'extensions', 'openshell', 'package.json')


def get_pinned_openshell_version():
    """Read the pinned openshellVersion from extensions/openshell/package.json."""
    with open(OPENSHELL_PKG) as f:
        pkg = json.load(f)
    version_str = pkg.get('openshellVersion', '')
    if not version_str:
        raise RuntimeError(f'missing "openshellVersion" in {OPENSHELL_PKG}')
    return tuple(int(x) for x in version_str.split('.'))


def run(cmd, *, timeout=120, check=True, input_data=None, capture=True):
    """Run a command and return the result."""
    result = subprocess.run(
        cmd,
        capture_output=capture,
        text=True,
        timeout=timeout,
        check=check,
        input=input_data,
        cwd=REPO_ROOT,
    )
    return result


def sandbox_exec(name, command, *, timeout=60):
    """Execute a command inside a sandbox."""
    return run(
        ['openshell', 'sandbox', 'exec', '-n', name, '--timeout', str(timeout), '--'] + command,
        timeout=timeout + 15,
        check=False,
    )


def parse_version(version_str):
    """Parse 'openshell X.Y.Z' into a tuple."""
    parts = version_str.strip().split()[-1]
    return tuple(int(x) for x in parts.split('.'))


class PreflightMixin:
    """Shared preflight checks."""

    @classmethod
    def check_openshell(cls):
        if not shutil.which('openshell'):
            raise unittest.SkipTest('openshell not found in PATH')
        result = run(['openshell', '--version'], check=False)
        if result.returncode != 0:
            raise unittest.SkipTest(f'openshell --version failed: {result.stderr}')
        version = parse_version(result.stdout)
        min_version = get_pinned_openshell_version()
        if version < min_version:
            raise unittest.SkipTest(
                f'openshell {result.stdout.strip()} < pinned {".".join(map(str, min_version))}'
            )
        return result.stdout.strip()


def generate_configs(input_config):
    """Call generate-config.mts to produce policy YAML and opencode config."""
    result = run(
        ['npx', 'tsx', GENERATE_SCRIPT],
        input_data=json.dumps(input_config),
        timeout=30,
    )
    stdout = result.stdout
    # Strip npm warnings that go to stdout
    lines = stdout.strip().split('\n')
    json_line = lines[-1]
    return json.loads(json_line)


class TestNpmScopedMcp(unittest.TestCase, PreflightMixin):
    """Test that npm scoped MCP packages install and run in sandboxes."""

    SANDBOX_NAME = None
    TEMP_DIR = None

    INPUT_CONFIG = {
        'network': {'mode': 'deny', 'hosts': ['registry.npmjs.org']},
        'mcpCommands': [
            {
                'name': 'ai.openkaiden.registry/playwright',
                'command': 'npx',
                'args': ['@playwright/mcp@0.0.73'],
            }
        ],
    }

    @classmethod
    def setUpClass(cls):
        cls.check_openshell()

        cls.SANDBOX_NAME = f'kdn-e2e-{int(time.time())}'
        cls.TEMP_DIR = tempfile.mkdtemp(prefix='kdn-e2e-')

        # Generate configs from Kaiden source
        configs = generate_configs(cls.INPUT_CONFIG)

        cls.policy_path = os.path.join(cls.TEMP_DIR, 'policy.yaml')
        cls.opencode_config_path = os.path.join(cls.TEMP_DIR, 'opencode.json')

        with open(cls.policy_path, 'w') as f:
            f.write(configs['policy'])
        with open(cls.opencode_config_path, 'w') as f:
            f.write(configs['opencodeConfig'])

        # Create sandbox
        result = run(
            [
                'openshell', 'sandbox', 'create',
                '--name', cls.SANDBOX_NAME,
                '--upload', f'{cls.opencode_config_path}:.config/opencode/opencode.json',
                '--no-tty',
                '--policy', cls.policy_path,
                '--', 'true',
            ],
            timeout=180,
            check=False,
        )
        if result.returncode != 0:
            raise unittest.SkipTest(f'Sandbox creation failed: {result.stderr}')

    @classmethod
    def tearDownClass(cls):
        if cls.SANDBOX_NAME:
            run(
                ['openshell', 'sandbox', 'delete', cls.SANDBOX_NAME],
                timeout=30,
                check=False,
            )
        if cls.TEMP_DIR and os.path.exists(cls.TEMP_DIR):
            shutil.rmtree(cls.TEMP_DIR, ignore_errors=True)

    def test_01_sandbox_is_ready(self):
        """Sandbox should be in Ready phase."""
        result = run(
            ['openshell', 'sandbox', 'list'],
            check=False,
        )
        self.assertEqual(result.returncode, 0, f'Failed to list sandboxes: {result.stderr}')
        self.assertIn(self.SANDBOX_NAME, result.stdout, 'Sandbox not found in list')
        self.assertIn('Ready', result.stdout, 'Sandbox not in Ready phase')

    def test_02_node_available(self):
        """Node.js should be available in the sandbox."""
        result = sandbox_exec(self.SANDBOX_NAME, ['node', '--version'])
        self.assertEqual(result.returncode, 0, f'node not available: {result.stderr}')
        self.assertIn('v', result.stdout)

    def test_03_npx_available(self):
        """npx should be available in the sandbox."""
        result = sandbox_exec(self.SANDBOX_NAME, ['which', 'npx'])
        self.assertEqual(result.returncode, 0, f'npx not found: {result.stderr}')

    def test_04_npm_scoped_package_installs(self):
        """npm should successfully install a scoped package (@playwright/mcp)."""
        result = sandbox_exec(
            self.SANDBOX_NAME,
            ['npm', 'install', '--no-save', '--loglevel', 'verbose', '@playwright/mcp@0.0.73'],
            timeout=90,
        )
        combined = (result.stdout or '') + (result.stderr or '')
        self.assertNotIn('ECONNRESET', combined, 'npm got ECONNRESET — encoded slash likely blocked by proxy')
        self.assertNotIn('Operation timed out', combined, 'npm timed out — proxy may be blocking requests')
        self.assertEqual(result.returncode, 0, f'npm install failed:\n{combined}')

    def test_05_playwright_mcp_runs(self):
        """The Playwright MCP server should start and respond to --help."""
        result = sandbox_exec(
            self.SANDBOX_NAME,
            ['npx', '@playwright/mcp@0.0.73', '--help'],
            timeout=90,
        )
        combined = (result.stdout or '') + (result.stderr or '')
        self.assertEqual(result.returncode, 0, f'playwright MCP failed to run:\n{combined}')
        self.assertIn('Playwright MCP', result.stdout, 'Expected Playwright MCP help output')

    def test_06_policy_has_encoded_slash(self):
        """The effective policy should include allow_encoded_slash for npm registry."""
        result = run(
            ['openshell', 'policy', 'get', self.SANDBOX_NAME, '--full', '-o', 'json'],
            check=False,
        )
        self.assertEqual(result.returncode, 0, f'Failed to get policy: {result.stderr}')
        policy = json.loads(result.stdout)
        network_policies = policy.get('policy', {}).get('network_policies', {})

        found = False
        for rule_name, rule in network_policies.items():
            for ep in rule.get('endpoints', []):
                if ep.get('host') == 'registry.npmjs.org' and ep.get('allow_encoded_slash') is True:
                    found = True
                    break
            if found:
                break

        self.assertTrue(found, f'No endpoint with allow_encoded_slash=true for registry.npmjs.org.\nPolicies: {json.dumps(network_policies, indent=2)}')


if __name__ == '__main__':
    unittest.main(verbosity=2)
