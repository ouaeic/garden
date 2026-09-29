import { isIP } from 'node:net';

/** Literal private addresses avoid resolving a public hostname into an HTTP credential route. */
export const privateProviderAddress = (url: URL): boolean => {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  if (isIP(host) === 4) {
    const [a = -1, b = -1] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  return isIP(host) === 6 && /^(fc|fd)/.test(host);
};
