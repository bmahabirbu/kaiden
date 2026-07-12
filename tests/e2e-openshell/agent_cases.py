import json
from pathlib import Path


PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp@0.0.73'
PLAYWRIGHT_MCP_NAME = 'ai.openkaiden.registry/playwright'
SVELTE_SKILL_PATH = '.agents/skills/svelte-code-writer'
SVELTE_SKILL_NAME = 'svelte-code-writer'
BRIAN_FOOD_SKILL_PATH = 'tests/e2e-openshell/fixtures/brian-food'
BRIAN_FOOD_SKILL_NAME = 'brian-food'
BRIAN_FOOD_SKILL_PROMPT = f'Using skill {BRIAN_FOOD_SKILL_NAME}, what does Brian like? Reply with just the food.'
BRIAN_FOOD_SKILL_OUTPUT = 'cheese'
AGENT_COMMAND_REGISTRY = Path(__file__).with_name('agent-command-registry.json')
REPO_ROOT = Path(__file__).resolve().parents[2]


def _has_agent_extension(agent):
    return (REPO_ROOT / 'extensions' / agent / 'src' / 'extension.ts').is_file()


def _load_agent_registry():
    with AGENT_COMMAND_REGISTRY.open() as f:
        registry = json.load(f)

    agents = registry.get('agents')
    if not isinstance(agents, list):
        raise ValueError(f'{AGENT_COMMAND_REGISTRY} must contain an "agents" list')

    by_agent = {}
    for entry in agents:
        if entry.get('enabled', True) is False:
            continue
        agent = entry.get('agent')
        commands = entry.get('commands', {})
        if not agent or not isinstance(commands, dict):
            raise ValueError(f'each {AGENT_COMMAND_REGISTRY} entry must include "agent" and "commands"')
        if not _has_agent_extension(agent):
            continue
        by_agent[agent] = entry

    return by_agent


AGENT_COMMANDS = _load_agent_registry()


def _agents_with_command(command_name):
    return [
        {'agent': entry['agent'], 'commands': entry['commands']}
        for entry in AGENT_COMMANDS.values()
        if command_name in entry['commands']
    ]


def _build_npm_mcp_case(agent_entry):
    agent = agent_entry['agent']
    commands = agent_entry['commands']
    mcp_list_command = commands.get('mcpList')
    if not mcp_list_command:
        return None

    return {
        'agent': agent,
        'description': f'npm scoped MCP package (@playwright/mcp) via {agent}',
        'skills': [SVELTE_SKILL_PATH],
        'skillName': SVELTE_SKILL_NAME,
        'skillReadOutput': f'name: {SVELTE_SKILL_NAME}',
        'network': {'mode': 'deny', 'hosts': ['registry.npmjs.org']},
        'mcpName': PLAYWRIGHT_MCP_NAME,
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
        'agentMcpListCommand': mcp_list_command,
        'agentMcpListNameOutput': 'playwright',
        'agentMcpListSpawnedOutput': 'connected',
    }


AGENT_CASES = [case for entry in AGENT_COMMANDS.values() if (case := _build_npm_mcp_case(entry)) is not None]


def _build_skill_case(agent_entry):
    agent = agent_entry['agent']
    commands = agent_entry['commands']
    skill_list_command = commands.get('skillList')
    if not skill_list_command:
        return None

    return {
        'agent': agent,
        'description': f'skill discovery via {agent}',
        'skills': [SVELTE_SKILL_PATH],
        'skillName': SVELTE_SKILL_NAME,
        'skillListCommand': skill_list_command,
        'skillListOutput': SVELTE_SKILL_NAME,
    }


AGENT_SKILL_CASES = [
    case for entry in AGENT_COMMANDS.values() if (case := _build_skill_case(entry)) is not None
]


AGENT_PROMPT_CASES = _agents_with_command('prompt')


def agent_case_id(case):
    return case['agent']


def agent_prompt_command(agent, prompt, **values):
    entry = AGENT_COMMANDS[agent]
    template = entry['commands']['prompt']
    replacements = {'prompt': prompt, **values}
    return [part.format(**replacements) for part in template]
