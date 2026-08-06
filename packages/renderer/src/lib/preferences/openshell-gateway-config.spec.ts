import { expect, test } from 'vitest';

import { getBindMountsEnabled, setBindMountsEnabled } from './openshell-gateway-config';

test('reads the bind mounts setting', () => {
  expect(getBindMountsEnabled('[openshell.drivers.podman]\nenable_bind_mounts = true\n')).toBe(true);
  expect(getBindMountsEnabled('[openshell.drivers.podman]\nenable_bind_mounts = false\n')).toBe(false);
});

test('updates an existing bind mounts setting', () => {
  const config = '[openshell.drivers.podman]\nenable_bind_mounts = true\nsupervisor_image = "image"\n';

  expect(setBindMountsEnabled(config, false)).toBe(
    '[openshell.drivers.podman]\nenable_bind_mounts = false\nsupervisor_image = "image"\n',
  );
});

test('adds the setting to an existing driver section', () => {
  const config = '[openshell.drivers.podman]\nsupervisor_image = "image"\n';

  expect(setBindMountsEnabled(config, true)).toBe(
    '[openshell.drivers.podman]\nenable_bind_mounts = true\nsupervisor_image = "image"\n',
  );
});

test('does not invent a driver section', () => {
  expect(setBindMountsEnabled('[openshell]\nversion = 1\n', true)).toBe('[openshell]\nversion = 1\n');
});
