const state = (globalThis.__kaidenOpenShellE2E ??= { registeredAgents: [] });

export const registeredAgents = state.registeredAgents;

export const agents = {
  registerAgent(agent) {
    registeredAgents.push(agent);
    return { dispose() {} };
  },
};

export function resetRegisteredAgents() {
  registeredAgents.length = 0;
}
