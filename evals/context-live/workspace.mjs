import { assertUserDataPath } from '../../services/workspace-runner/src/files.ts';

/** The runner accepts bare names and workspace-prefixed names as the same file. */
export function fixtureFiles(files = {}) {
  const canonical = Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      assertUserDataPath('/garden/eval', path),
      content
    ])
  );
  return new Proxy(canonical, {
    get(target, key) {
      if (typeof key !== 'string' || key === 'toJSON') return Reflect.get(target, key);
      try {
        return target[assertUserDataPath('/garden/eval', key)];
      } catch {
        return undefined;
      }
    }
  });
}
