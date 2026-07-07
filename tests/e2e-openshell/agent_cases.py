PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp@0.0.73'


AGENT_CASES = [
    {
        'agent': 'opencode',
        'description': 'npm scoped MCP package (@playwright/mcp) via OpenCode',
        'network': {'mode': 'deny', 'hosts': ['registry.npmjs.org']},
        'mcpCommands': [
            {
                'name': 'ai.openkaiden.registry/playwright',
                'command': 'npx',
                'args': [PLAYWRIGHT_MCP_PACKAGE],
            },
        ],
        'verifyCommand': ['npx', PLAYWRIGHT_MCP_PACKAGE, '--help'],
        'verifyOutput': 'Playwright MCP',
    },
]


def agent_case_id(case):
    return case['agent']
