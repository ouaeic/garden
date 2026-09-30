import { expect, it } from 'vitest';
import { serverInstallCommand } from './ServerInstall';

it('pins the download, checkout and expected commit to the displayed source revision', () => {
  const revision = 'a'.repeat(40);
  expect(serverInstallCommand(revision)).toBe(
    `curl -fsSL https://raw.githubusercontent.com/ouaeic/garden/${revision}/install.sh | sudo env GARDEN_REF=${revision} GARDEN_EXPECTED_COMMIT=${revision} sh`
  );
});

it('keeps unrecognized revision text out of the terminal command', () => {
  const fallback = serverInstallCommand(null);
  expect(fallback).toContain('/v0.2.0/install.sh');
  for (const revision of ['main', 'a'.repeat(39), 'a'.repeat(41), 'a; touch /tmp/injected'])
    expect(serverInstallCommand(revision)).toBe(fallback);
});
