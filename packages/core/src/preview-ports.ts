import { GardenError } from './errors.js';

/**
 * A preview publishes a loopback port of the agent computer to the internet, so the set of ports it
 * may not choose is exactly the set garden itself listens on. Expressing that as "everything of
 * ours" rather than "the runner" is the difference between a demo server and a route to the API,
 * the preview gateway or PostgreSQL - none of which were ever meant to face the internet, and all
 * of which are reachable on loopback from inside the machine.
 */
export interface ReservedPortSources {
  /** Ports this service knows from its own configuration. */
  ports?: readonly (number | undefined | null)[];
  /** URLs whose port belongs to another garden service, e.g. the runner or the database. */
  urls?: readonly (string | undefined | null)[];
  /**
   * Ports of services this process has no configuration for - the sibling health endpoints the
   * installer binds to loopback. Supplied as text so it can come straight from an environment
   * variable.
   */
  additional?: string | null;
}

const portOfUrl = (raw: string): number | null => {
  try {
    const url = new URL(raw);
    if (url.port) return Number(url.port);
    // A URL with no port still names one: the database and the runner are both addressed this way.
    if (['https:', 'wss:'].includes(url.protocol)) return 443;
    if (['http:', 'ws:'].includes(url.protocol)) return 80;
    return null;
  } catch {
    return null;
  }
};

const usable = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65_535;

export const reservedPreviewPorts = (sources: ReservedPortSources): Set<number> => {
  const ports = new Set<number>();
  for (const port of sources.ports ?? []) if (usable(port)) ports.add(port);
  for (const url of sources.urls ?? []) {
    if (!url) continue;
    const port = portOfUrl(url);
    if (usable(port)) ports.add(port);
  }
  for (const entry of (sources.additional ?? '').split(',')) {
    const port = Number(entry.trim());
    if (entry.trim() && usable(port)) ports.add(port);
  }
  return ports;
};

/**
 * Refused rather than rewritten: the caller asked to publish a specific service, and quietly
 * publishing a different one would be worse than saying no.
 */
export const assertPublishablePort = (port: number, reserved: ReadonlySet<number>): void => {
  if (reserved.has(port))
    throw new GardenError(
      'preview_port_reserved',
      `Port ${port} belongs to this server's own services and cannot be published`,
      422
    );
};
