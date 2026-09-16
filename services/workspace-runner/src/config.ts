import { z } from 'zod';

const Config = z.object({
  JOB_SUPERVISOR_SOCKET: z.string().optional(),
  RUNNER_HOST: z.string().default('127.0.0.1'),
  RUNNER_PORT: z.coerce.number().int().positive().default(4300),
  RUNNER_SHARED_SECRET: z.string().min(32),
  WORKSPACE_ROOT: z.string().default('.athanor/workspaces'),
  TAR_EXECUTABLE: z.string().default('/usr/bin/tar'),
  SNAPSHOT_EXECUTABLE: z.string().default('/usr/local/lib/athanor/athanor-snapshot'),
  BROWSER_EXECUTABLE_PATH: z.string().optional(),
  // On by default: run the browser on the workspace's own X server rather than headless. Headless
  // Chromium tells every site it has no hover and a coarse pointer, so responsive pages serve it
  // a phone layout while its user agent says desktop - which changes what the agent can even see
  // to click. On a host with no desktop runtime, or with this off, it falls back to headless.
  BROWSER_USE_DESKTOP_DISPLAY: z
    .string()
    .default('true')
    .transform((value) => value !== 'false'),
  /**
   * How far down the scheduler the session browser sits, as a nice value.
   *
   * This host has no GPU, so a headful Chromium renders through SwiftShader and any animated page
   * pins the machine - measured at about thirteen of sixteen cores, held for as long as the page
   * stayed open. Ten is a weight, not a cap: the browser still gets the whole processor when
   * nothing else wants it, and yields to the agent's own commands when they do, which is the same
   * argument `athanor-runner.service` makes for its own `CPUWeight`. Zero switches it off.
   */
  BROWSER_CPU_NICE: z.coerce.number().int().min(0).max(19).default(10),
  DESKTOP_BRIDGE_EXECUTABLE: z.string().optional(),
  DESKTOP_SESSION_EXECUTABLE: z.string().optional(),
  SYSTEM_PACKAGE_HELPER: z.string().optional(),
  // Root-owned, outside every directory on the agent's PATH. Left unset - a developer's laptop,
  // where there is no second account to drop to - agent commands run as the runner's own user
  // and the runner says so rather than pretending otherwise.
  AGENT_SANDBOX_HELPER: z.string().optional(),
  // The FOREGROUND ceiling, and the only one of the two that is about this process rather than
  // about the work. A foreground command holds an HTTP request open in the worker for its whole
  // run and blocks the turn behind it, so the hour here is chosen to sit just inside
  // `TOOL_REQUEST_TIMEOUT_MS` in apps/worker/src/runner-client.ts, which is 3,900 s. What would
  // change it: moving that number too, in the same commit. A run that wants longer than this does
  // not want to be in the foreground at all, and `execute` says so by name rather than clamping.
  MAX_EXECUTION_SECONDS: z.coerce.number().int().positive().default(3600),
  // Unnamed task sessions have a fallback deadline. Named finite jobs have only an explicitly
  // requested deadline, and services are supervised without one. This setting also supplies the
  // upper bound for task-scoped interpreter sessions.
  MAX_BACKGROUND_SECONDS: z.coerce.number().int().positive().max(2_147_483).default(86_400),
  // prlimit is part of util-linux, an essential package, so it is present on every stock
  // Debian and Ubuntu host without anything being installed for athanor's benefit.
  RESOURCE_LIMIT_EXECUTABLE: z.string().default('/usr/bin/prlimit'),
  // A bare name rather than a path, which is the one spelling everything else in athanor uses for
  // this: the installer puts a compatibility command on PATH where the release only packages the
  // older ImageMagick, and the toolchain probe and the skills both name it this way. The package
  // table already installs it for image work, so a photograph the owner wants looked at is
  // converted by the toolchain that is on the box rather than by a dependency added for one format.
  IMAGE_CONVERT_EXECUTABLE: z.string().default('magick'),
  // Left unset the ceiling is derived from the host's own memory, because a number that suits a
  // 32 GiB server would be larger than the whole of a 2 GiB one.
  COMMAND_MEMORY_LIMIT_BYTES: z.coerce.number().int().positive().optional(),
  // There is deliberately no COMMAND_FILE_LIMIT_BYTES. It was 4 GiB, it was the first ceiling the
  // owner's own work reached, and it killed mutely; limits.ts states why a per-file rlimit was the
  // wrong instrument and what the host-disk floor covers instead. A host that still has the key in
  // its runner.env is unaffected - unknown keys are stripped here - rather than refused a start.
  COMMAND_PROCESS_LIMIT: z.coerce.number().int().positive().default(1024),
  COMMAND_OPEN_FILE_LIMIT: z.coerce.number().int().positive().default(4096),
  MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
  // Turn checkpoints. Both tools are probed by using them, never by assuming a mount is what it
  // looks like, so a path that does not exist on this host simply means that mechanism is not
  // offered. dpkg's database is read to tell the owner which packages a rewind will not remove.
  CHECKPOINT_BTRFS_EXECUTABLE: z.string().default('/usr/bin/btrfs'),
  CHECKPOINT_ZFS_EXECUTABLE: z.string().default('/usr/sbin/zfs'),
  CHECKPOINT_PACKAGE_MANIFEST: z.string().default('/var/lib/dpkg/status'),
  // Off by default: the profile holds the session cookie for every site the owner has signed into,
  // and rewinding a morning's work should not sign them out of all of them.
  CHECKPOINT_INCLUDE_BROWSER_PROFILE: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  CHECKPOINT_RETAIN_TURNS: z.coerce.number().int().min(1).max(500).default(20),
  CHECKPOINT_RETAIN_DAILY_DAYS: z.coerce.number().int().min(0).max(3650).default(14),
  CHECKPOINT_MAX_FILES: z.coerce.number().int().min(1000).default(250_000),
  // A file this large is a disk image or a dataset. Holding a second copy of one per turn is not a
  // cheap checkpoint, so it is left out and the preview says so rather than pretending otherwise.
  CHECKPOINT_MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 ** 3),
  // Every loopback port this installation already serves something private on. Publishing a
  // preview points the public internet at a loopback port, so these are told to the runner rather
  // than guessed: the API, the preview gateway and the database are configurable, and the runner's
  // own port is added to whatever arrives here. One spelling across both processes and the
  // installer: this was named the other way round here for a while, three lines from the API's
  // version of the same idea, which is a trap for whoever next moves a port.
  RESERVED_PREVIEW_PORTS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => Number.parseInt(entry.trim(), 10))
        .filter((port) => Number.isInteger(port) && port > 0)
    ),
  // Off by default because a command in its own network namespace cannot be reached over
  // loopback either, and that is how a published preview serves the port a command is listening
  // on. Turning it on needs the sandbox helper: an unprivileged process cannot create a network
  // namespace, so without it the setting used to make every command fail instead of isolating.
  ISOLATE_AGENT_NETWORK: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  /*
   * Whether an agent command is confined to its own workspace by a Landlock ruleset on the same
   * exec line that already drops it to the agent account.
   *
   * Off by default and turned on by the installer from a measurement rather than from a guess:
   * `athanor-sandbox check` reports `filesystem=landlock` or `filesystem=none`, and
   * scripts/install-native.sh writes this key from that line. Defaulting it on would have been the
   * braver spelling and the wrong one - a kernel without Landlock, or a util-linux older than 2.41,
   * makes setpriv exit before the command runs, so an upgrade would have turned every command on
   * that box into exit 125 in exchange for a boundary it cannot enforce anyway.
   *
   * It needs the sandbox helper for the same reason ISOLATE_AGENT_NETWORK does, and refuses the
   * same way: applying a ruleset happens on the privileged side of the drop, so without the helper
   * there is nowhere to apply it and every command would run exactly as unconfined as before while
   * this key said otherwise.
   *
   * It also needs WORKSPACE_ROOT to be /home/athanor, which the helper hard-codes and will not take
   * from a caller. That is not checked here, because a runner started with a different workspace
   * root is a development configuration where AGENT_SANDBOX_HELPER is unset and this is moot; on a
   * box where it is set, the same installer writes both values.
   *
   * Optional rather than defaulted, which is the one place a setting in this file differs in shape
   * from its neighbours, and the difference is the kind of setting it is. ISOLATE_AGENT_NETWORK is
   * a policy an operator chooses and can be asked of any configuration. This is a measurement the
   * installer took of the kernel, so an absent key is not the same fact as `false`: `false` is a
   * box that was looked at and has no Landlock, and absence is a runner.env written before anything
   * looked. Both run unconfined, and `resolveAgentSandbox` reads absence as no.
   */
  CONFINE_AGENT_FILESYSTEM: z
    .string()
    .transform((value) => value === 'true')
    .optional()
});

export type RunnerConfig = z.infer<typeof Config>;

/**
 * Secrets are read once and removed from the environment. An agent command that reaches the
 * runner's process - through /proc, a core file, or anything that reads it back - must not find
 * the capability signing key there: with it, a command mints its own tokens for any workspace.
 */
const SECRET_KEYS = ['RUNNER_SHARED_SECRET'] as const;

export const loadConfig = (): RunnerConfig => {
  const config = Config.parse(process.env);
  for (const key of SECRET_KEYS) delete process.env[key];
  if (config.ISOLATE_AGENT_NETWORK && !config.AGENT_SANDBOX_HELPER) {
    throw new Error(
      'ISOLATE_AGENT_NETWORK is on but AGENT_SANDBOX_HELPER is unset. Creating a network namespace needs privilege the runner does not have, so every command would fail rather than run isolated.'
    );
  }
  if (config.CONFINE_AGENT_FILESYSTEM && !config.AGENT_SANDBOX_HELPER) {
    throw new Error(
      'CONFINE_AGENT_FILESYSTEM is on but AGENT_SANDBOX_HELPER is unset. A Landlock ruleset is applied on the privileged side of the drop to the agent account, so without the helper every command would run with no filesystem boundary at all while this setting said it had one.'
    );
  }
  return config;
};
