export class InversifyBinding {
  async initBindings() {
    return {
      async getAsync() {
        return {
          async init() {},
          dispose() {},
        };
      },
    };
  }

  async dispose() {}
}

export class ClaudeSkillsManager {}

export class ClaudeInferenceManager {}
