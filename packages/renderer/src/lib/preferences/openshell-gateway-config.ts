const BIND_MOUNTS_SETTING = /^\s*enable_bind_mounts\s*=\s*(true|false)\s*$/m;
const DRIVER_SECTION = /^\s*\[openshell\.drivers\.[^\]]+\]\s*$/m;

export function getBindMountsEnabled(config: string): boolean {
  return BIND_MOUNTS_SETTING.exec(config)?.[1] === 'true';
}

export function setBindMountsEnabled(config: string, enabled: boolean): string {
  const value = `enable_bind_mounts = ${enabled}`;
  if (BIND_MOUNTS_SETTING.test(config)) {
    return config.replace(BIND_MOUNTS_SETTING, value);
  }

  const section = DRIVER_SECTION.exec(config);
  if (!section?.index && section?.index !== 0) {
    return config;
  }
  const insertionIndex = section.index + section[0].length;
  return `${config.slice(0, insertionIndex)}\n${value}${config.slice(insertionIndex)}`;
}
