import { ApiError, get, nativeServerOrigin, put } from './client';
import type { Draft } from './model';
import {
  DraftConflict,
  type DraftRecovery,
  type DraftStorage,
  type DraftWrite
} from './draft-sync';

const DB_NAME = 'garden-private-drafts';
const POLICY = 'garden-keep-device-drafts';
interface SealedDraft {
  id: string;
  namespace: string;
  version: string;
  iv: string;
  ciphertext: string;
}
interface DeviceKey {
  userId: string;
  sessionId: string;
  key: string;
}
let keyGeneration = 0;
let device: { namespace: string; key: CryptoKey; userId: string } | null = null;
let recoveries = new Map<string, DraftRecovery>();
let database: Promise<IDBDatabase> | null = null;
const bytes = (value: string) =>
  Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
const base64 = (value: ArrayBuffer | Uint8Array) => {
  const input = new Uint8Array(value instanceof Uint8Array ? value : value);
  let text = '';
  for (let offset = 0; offset < input.length; offset += 8192)
    text += String.fromCharCode(...input.subarray(offset, offset + 8192));
  return btoa(text);
};
export const keepsDeviceDrafts = (): boolean => {
  try {
    return localStorage.getItem(POLICY) !== 'off';
  } catch {
    return false;
  }
};
const openDatabase = () =>
  (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = null;
      reject(request.error ?? new Error('Device draft storage could not open.'));
    };
    request.onblocked = () => {
      database = null;
      reject(new Error('Close another Garden tab to open draft storage.'));
    };
  }));
async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, done: (value: T) => void) => void
): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', mode);
    let result: T;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? new Error('Device draft storage failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('Device draft storage was interrupted.'));
    try {
      run(tx.objectStore('drafts'), (value) => {
        result = value;
      });
    } catch (error) {
      tx.abort();
      reject(
        error instanceof Error ? error : new Error('Device draft storage failed.', { cause: error })
      );
    }
  });
}
const allRows = () =>
  transaction<SealedDraft[]>('readonly', (store, done) => {
    const request = store.getAll();
    request.onsuccess = () => done(request.result as SealedDraft[]);
  });
export async function sealDraft(
  record: DraftRecovery,
  key: CryptoKey,
  namespace: string
): Promise<SealedDraft> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(JSON.stringify([namespace, record.id, record.version]));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    new TextEncoder().encode(JSON.stringify(record))
  );
  return {
    id: record.id,
    namespace,
    version: record.version,
    iv: base64(iv),
    ciphertext: base64(encrypted)
  };
}
export async function openDraft(
  row: SealedDraft,
  key: CryptoKey,
  namespace: string
): Promise<DraftRecovery> {
  if (row.namespace !== namespace)
    throw new Error('This draft belongs to another signed-in device.');
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: bytes(row.iv),
      additionalData: new TextEncoder().encode(JSON.stringify([namespace, row.id, row.version]))
    },
    key,
    bytes(row.ciphertext)
  );
  const record = JSON.parse(new TextDecoder().decode(plaintext)) as DraftRecovery;
  if (
    record.id !== row.id ||
    record.version !== row.version ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 0 ||
    (!record.head && !record.latest && !record.submission)
  )
    throw new Error('The saved device draft is invalid.');
  return record;
}
export const draftStorage: DraftStorage = {
  async save(record) {
    if (!keepsDeviceDrafts()) return;
    if (!device)
      throw new Error('Connect to Garden once before saving encrypted drafts on this device.');
    const generation = keyGeneration;
    const row = await sealDraft(record, device.key, device.namespace);
    if (generation !== keyGeneration)
      throw new Error('The device session changed before the draft was saved.');
    await transaction<void>('readwrite', (store, done) => {
      store.put(row);
      done();
    });
    recoveries.set(record.id, structuredClone(record));
  },
  async remove(id, version) {
    if (!device) return;
    await transaction<void>('readwrite', (store, done) => {
      const read = store.get(id);
      read.onsuccess = () => {
        const row = read.result as SealedDraft | undefined;
        if (row && row.namespace === device?.namespace && (!version || row.version === version))
          store.delete(id);
        done();
      };
    });
    if (!version || recoveries.get(id)?.version === version) recoveries.delete(id);
  }
};
export const recoveryFor = (draft?: Draft) =>
  draft?.recoveryId ? recoveries.get(draft.recoveryId) : undefined;
export async function recoverDeviceDrafts(userId: string): Promise<Draft[]> {
  if (!keepsDeviceDrafts()) return [];
  if (!device || device.userId !== userId) {
    const supplied = await get<DeviceKey>('/v1/drafts/device-key', {
      signal: AbortSignal.timeout(5000)
    });
    if (supplied.userId !== userId) throw new Error('The device session changed. Reload Garden.');
    const namespace = JSON.stringify([
      nativeServerOrigin() ?? location.origin,
      userId,
      supplied.sessionId
    ]);
    device = {
      namespace,
      userId,
      key: await crypto.subtle.importKey('raw', bytes(supplied.key), { name: 'AES-GCM' }, false, [
        'encrypt',
        'decrypt'
      ])
    };
    recoveries = new Map();
    for (const row of await allRows())
      if (row.namespace === namespace) {
        const record = await openDraft(row, device.key, namespace);
        recoveries.set(record.id, record);
      }
  }
  return [...recoveries.values()]
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .map((record) => ({
      ...(record.submission?.draft ?? record.latest ?? record.head!.draft),
      revision: record.revision,
      recoveryId: record.id
    }));
}
export async function writeDraft(
  input: DraftWrite
): Promise<{ revision: number; updatedAt: string }> {
  const {
    recoveryId: _recoveryId,
    revision: _revision,
    updatedAt: _updatedAt,
    ...draft
  } = input.draft;
  try {
    return await put(
      '/v1/drafts',
      { ...draft, expectedRevision: input.expectedRevision },
      { idempotencyKey: input.key }
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === 'draft_conflict') {
      const query = new URLSearchParams({
        workspaceId: draft.workspaceId,
        ...(draft.taskId ? { taskId: draft.taskId } : {})
      });
      throw new DraftConflict(await get<Draft>(`/v1/drafts?${query}`));
    }
    throw error;
  }
}
export async function clearDeviceDrafts(): Promise<void> {
  ++keyGeneration;
  // Logout removes encrypted leftovers too; no content is stored in the policy setting.
  await transaction<void>('readwrite', (store, done) => {
    store.clear();
    done();
  });
  recoveries.clear();
  device = null;
}
export async function setKeepsDeviceDrafts(enabled: boolean): Promise<void> {
  if (!enabled) await clearDeviceDrafts();
  localStorage.setItem(POLICY, enabled ? 'on' : 'off');
  window.dispatchEvent(new Event('garden-draft-policy'));
}
export function forgetDraftKey(): void {
  ++keyGeneration;
  device = null;
  recoveries.clear();
}

/** Question drafts use the same device key; private computer input never enters this path. */
export async function readQuestionDraft(userId: string, id: string): Promise<string> {
  if (!keepsDeviceDrafts()) return '';
  if (!device || device.userId !== userId) await recoverDeviceDrafts(userId);
  if (!device) return '';
  const row = sessionStorage.getItem(id);
  if (!row) return '';
  const sealed = JSON.parse(row) as { iv: string; ciphertext: string };
  const value = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: bytes(sealed.iv),
      additionalData: new TextEncoder().encode(JSON.stringify([device.namespace, id]))
    },
    device.key,
    bytes(sealed.ciphertext)
  );
  return new TextDecoder().decode(value);
}
export async function writeQuestionDraft(userId: string, id: string, value: string): Promise<void> {
  if (!value) {
    sessionStorage.removeItem(id);
    return;
  }
  if (!keepsDeviceDrafts()) return;
  if (!device || device.userId !== userId) await recoverDeviceDrafts(userId);
  if (!device) throw new Error('Connect to Garden to save your answer draft.');
  const generation = keyGeneration;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(JSON.stringify([device.namespace, id]))
    },
    device.key,
    new TextEncoder().encode(value)
  );
  if (generation !== keyGeneration)
    throw new Error('The device session changed before the answer draft was saved.');
  sessionStorage.setItem(id, JSON.stringify({ iv: base64(iv), ciphertext: base64(ciphertext) }));
}
