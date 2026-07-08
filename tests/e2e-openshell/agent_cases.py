PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp@0.0.73'
PLAYWRIGHT_MCP_NAME = 'ai.openkaiden.registry/playwright'
SVELTE_SKILL_PATH = '.agents/skills/svelte-code-writer'
SVELTE_SKILL_NAME = 'svelte-code-writer'


AGENT_CASES = [
    {
        'agent': 'opencode',
        'description': 'npm scoped MCP package (@playwright/mcp) via OpenCode',
        'settingsPath': '.config/opencode/opencode.json',
        'mcpName': PLAYWRIGHT_MCP_NAME,
        'mcpSettingsKey': 'mcp',
        'mcpEntryType': 'local',
        'mcpCommandStyle': 'array',
        'skills': [SVELTE_SKILL_PATH],
        'skillName': SVELTE_SKILL_NAME,
        'skillDestination': '.opencode/skills',
        'skillReadCommand': ['sh', '-lc', f'cat "$HOME/.opencode/skills/{SVELTE_SKILL_NAME}/SKILL.md"'],
        'skillReadOutput': f'name: {SVELTE_SKILL_NAME}',
        'network': {'mode': 'deny', 'hosts': ['registry.npmjs.org']},
        'mcpCommands': [
            {
                'name': PLAYWRIGHT_MCP_NAME,
                'command': 'npx',
                'args': [PLAYWRIGHT_MCP_PACKAGE],
            },
        ],
        'spawnCommand': ['npx', PLAYWRIGHT_MCP_PACKAGE, '--help'],
        'spawnOutput': 'Playwright MCP',
        'registryProbeCommand': ['curl', '-fsS', 'https://registry.npmjs.org/@playwright%2fmcp'],
        'registryProbeOutput': '"name":"@playwright/mcp"',
        'agentMcpListCommand': ['opencode', 'mcp', 'list'],
        'agentMcpListNameOutput': 'playwright',
        'agentMcpListSpawnedOutput': 'connected',
    },
    {
        'agent': 'claude',
        'description': 'npm scoped MCP package (@playwright/mcp) via Claude Code',
        'settingsPath': '.claude.json',
        'mcpName': PLAYWRIGHT_MCP_NAME,
        'mcpSettingsKey': 'mcpServers',
        'mcpEntryType': 'stdio',
        'mcpCommandStyle': 'fields',
        'skills': [SVELTE_SKILL_PATH],
        'skillName': SVELTE_SKILL_NAME,
        'skillDestination': '.claude/skills',
        'skillReadCommand': ['sh', '-lc', f'cat "$HOME/.claude/skills/{SVELTE_SKILL_NAME}/SKILL.md"'],
        'skillReadOutput': f'name: {SVELTE_SKILL_NAME}',
        'network': {'mode': 'deny', 'hosts': ['registry.npmjs.org']},
        'mcpCommands': [
            {
                'name': PLAYWRIGHT_MCP_NAME,
                'command': 'npx',
                'args': [PLAYWRIGHT_MCP_PACKAGE],
            },
        ],
        'spawnCommand': ['npx', PLAYWRIGHT_MCP_PACKAGE, '--help'],
        'spawnOutput': 'Playwright MCP',
        'registryProbeCommand': ['curl', '-fsS', 'https://registry.npmjs.org/@playwright%2fmcp'],
        'registryProbeOutput': '"name":"@playwright/mcp"',
        'agentMcpListCommand': ['claude', 'mcp', 'list'],
        'agentMcpListNameOutput': 'playwright',
        'agentMcpListSpawnedOutput': 'connected',
    },
]


def agent_case_id(case):
    return case['agent']
