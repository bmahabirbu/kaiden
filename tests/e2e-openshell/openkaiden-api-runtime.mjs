const state = (globalThis.__kaidenOpenShellE2E ??= { registeredAgents: [] });

export const registeredAgents = state.registeredAgents;

export const agents = {
  registerAgent(agent) {
    registeredAgents.push(agent);
    return { dispose() {} };
  },
};

export const provider = {
  createProvider(providerConfig) {
    return {
      ...providerConfig,
      registerInferenceProviderConnectionFactory() {
        return { dispose() {} };
      },
      registerInferenceProviderConnection() {
        return { dispose() {} };
      },
      registerSkill() {
        return { dispose() {} };
      },
    };
  },
};

export function resetRegisteredAgents() {
  registeredAgents.length = 0;
}
