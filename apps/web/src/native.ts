import { ApiError, del, get, isNativeClient, post } from './client.js';

export type NetworkPreference = 'unknown' | 'dynamic' | 'fixed';
export interface NativeStatus {
  configured: boolean;
  connected: boolean;
  identity: string | null;
  endpoints: string[];
  error: string | null;
  networkPreference: NetworkPreference | null;
  appVersion: string;
}
export interface NativeBootstrap {
  pairingCode: string | null;
  installerUrl: string;
}
export interface NativeCapabilities {
  browserAuthorization?: boolean;
  folderPicker: boolean;
  notifications: boolean;
  downloads: boolean;
  deepLinkEvents: boolean;
}
export interface LocalFolder {
  token: string;
  name: string;
}
export interface LocalEntry {
  name: string;
  relativePath: string;
  isDirectory: boolean;
  sizeBytes: number;
}
export interface TicketPreview {
  identity: string;
  endpoints: string[];
  expiresAt: number;
}

const invalidTicket = (message = 'Paste a complete garden connection ticket.') =>
  new ApiError('invalid_connection_ticket', message);
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A preview never grants access: the native gateway verifies the pinned identity before pairing. */
export function previewConnectionTicket(raw: string, now = Date.now()): TicketPreview {
  if (new TextEncoder().encode(raw).length > 32 * 1024)
    throw invalidTicket('This connection ticket is too large.');
  const match = /^garden:\/\/pair\/([A-Za-z0-9_-]+)$/.exec(raw.trim());
  if (!match?.[1]) throw invalidTicket();
  let parsed: unknown;
  try {
    const bytes = Uint8Array.from(atob(match[1].replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0)
    );
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw invalidTicket();
  }
  const ticket = record(parsed);
  const fields = ['version', 'endpoints', 'identity', 'discovery', 'pairingCode', 'expiresAt'];
  if (Object.keys(ticket).some((key) => !fields.includes(key)) || ticket.version !== 2)
    throw invalidTicket('This connection ticket format is not supported.');
  if (typeof ticket.identity !== 'string' || !/^sha256\/[A-Za-z0-9+/]{43}=$/.test(ticket.identity))
    throw invalidTicket('This ticket has an invalid server identity.');
  if (btoa(atob(ticket.identity.slice(7))) !== ticket.identity.slice(7))
    throw invalidTicket('This ticket has an invalid server identity.');
  const discovery = record(ticket.discovery);
  if (
    Object.keys(discovery).some((key) => !['mdnsService', 'mdnsPort'].includes(key)) ||
    discovery.mdnsService !== '_garden._tcp.local' ||
    discovery.mdnsPort !== 443
  )
    throw invalidTicket('This ticket has unsupported discovery settings.');
  if (typeof ticket.pairingCode !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(ticket.pairingCode))
    throw invalidTicket('This ticket has an invalid pairing code.');
  if (
    typeof ticket.expiresAt !== 'number' ||
    !Number.isSafeInteger(ticket.expiresAt) ||
    ticket.expiresAt <= Math.floor(now / 1000)
  )
    throw invalidTicket('This connection ticket has expired. Create another on your server.');
  if (!Array.isArray(ticket.endpoints) || !ticket.endpoints.length || ticket.endpoints.length > 16)
    throw invalidTicket('This ticket has no usable server address.');
  const endpoints = ticket.endpoints.map((value: unknown) => {
    try {
      if (typeof value !== 'string') throw invalidTicket();
      const url = new URL(value);
      if (
        url.protocol !== 'https:' ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        url.port
      )
        throw invalidTicket();
      return url.origin;
    } catch {
      throw invalidTicket('Server addresses must be HTTPS origins on port 443.');
    }
  });
  return {
    identity: ticket.identity,
    endpoints: [...new Set(endpoints)],
    expiresAt: ticket.expiresAt
  };
}

/** The installer owns a separate loopback origin so the web app never receives SSH secrets. */
export function localInstallerUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' &&
      url.hostname === 'localhost' &&
      /^[0-9]+$/.test(url.port) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
      ? `${url.origin}/`
      : null;
  } catch {
    return null;
  }
}

export function enrollmentCodeFromFragment(fragment: string, origin: string): string | null {
  const match = /^#pair=([A-Za-z0-9_-]+)$/.exec(fragment);
  if (!match?.[1]) return null;
  try {
    const preview = previewConnectionTicket(`garden://pair/${match[1]}`);
    const current = new URL(origin);
    if (current.protocol !== 'https:' || !preview.endpoints.includes(current.origin)) return null;
    const bytes = Uint8Array.from(atob(match[1].replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0)
    );
    const payload = record(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    );
    return typeof payload.pairingCode === 'string' ? payload.pairingCode : null;
  } catch {
    return null;
  }
}

export async function nativeStatus(signal?: AbortSignal): Promise<NativeStatus | null> {
  return isNativeClient()
    ? get<NativeStatus>('/__garden/client/status', { signal: signal ?? null })
    : null;
}
export async function nativeBootstrap(signal?: AbortSignal): Promise<NativeBootstrap> {
  const result = await get<NativeBootstrap>('/__garden/client/bootstrap', {
    signal: signal ?? null
  });
  const installerUrl = localInstallerUrl(result.installerUrl);
  if (!installerUrl)
    throw new ApiError(
      'invalid_installer_origin',
      'The native installer address is unavailable. Reopen the app.'
    );
  return { ...result, installerUrl };
}
export async function pairNative(
  ticket: string,
  preference: NetworkPreference = 'unknown'
): Promise<NativeBootstrap> {
  previewConnectionTicket(ticket);
  await post('/__garden/client/pair', { ticket: ticket.trim() });
  await setNetworkPreference(preference);
  return nativeBootstrap();
}
export const setNetworkPreference = (preference: NetworkPreference): Promise<{ saved: true }> =>
  post('/__garden/client/network-preference', { preference });
export const forgetNative = (): Promise<{ connected: false }> => del('/__garden/client/profile');

type NativeBridge = { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> };
const bridge = (): NativeBridge | null => {
  if (typeof window === 'undefined') return null;
  const candidate = record((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__);
  return typeof candidate.invoke === 'function' ? (candidate as NativeBridge) : null;
};
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const native = bridge();
  if (!native)
    throw new ApiError('native_unavailable', 'This action is available in the garden app.');
  return native.invoke<T>(command, args);
}
export async function nativeCapabilities(): Promise<NativeCapabilities | null> {
  return bridge() ? invoke<NativeCapabilities>('native_capabilities') : null;
}
export const openAuthorizationBrowser = (url: string): Promise<void> =>
  invoke('open_authorization_browser', { url });
export const openPreviewBrowser = (url: string): Promise<void> =>
  invoke('open_preview_browser', { url });
export const chooseLocalFolder = (): Promise<LocalFolder | null> => invoke('choose_folder');
export const revokeLocalFolder = (token: string): Promise<void> =>
  invoke('revoke_folder', { token });
export const listLocalFolder = (token: string, relative = ''): Promise<LocalEntry[]> =>
  invoke('list_local_folder', { token, relative });
export async function readLocalFile(
  token: string,
  relative: string
): Promise<Uint8Array<ArrayBuffer>> {
  return Uint8Array.from(await invoke<number[]>('read_local_file', { token, relative }));
}
export async function requestNativeNotifications(): Promise<boolean> {
  const capabilities = await nativeCapabilities();
  if (!capabilities?.notifications) return false;
  const granted = await invoke<boolean>('plugin:notification|is_permission_granted');
  return granted || (await invoke<string>('plugin:notification|request_permission')) === 'granted';
}
export async function nativeNotificationPermission(): Promise<boolean> {
  const capabilities = await nativeCapabilities();
  return capabilities?.notifications
    ? invoke<boolean>('plugin:notification|is_permission_granted')
    : false;
}
export async function notifyNative(title: string, body: string): Promise<void> {
  await invoke('plugin:notification|notify', { options: { title, body } });
}
