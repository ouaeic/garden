import { useEffect, useRef, useState } from 'react';
import { FolderOpen } from './icons';
import { Button, Dialog, ErrorNotice } from './ui.js';
import { bytes } from './model.js';
import {
  chooseLocalFolder,
  listLocalFolder,
  nativeCapabilities,
  readLocalFile,
  revokeLocalFolder
} from './native.js';
import type { LocalEntry, LocalFolder } from './native.js';
import './local-folder.css';

const IMPORT_BYTES = 100 * 1024 * 1024;
export default function LocalFolderAttachments({
  disabled,
  remaining,
  onFiles,
  onCancel
}: {
  disabled: boolean;
  remaining: number;
  onFiles: (files: readonly File[]) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [supported, setSupported] = useState(false);
  const [folder, setFolder] = useState<LocalFolder | null>(null);
  const [relative, setRelative] = useState('');
  const [entries, setEntries] = useState<LocalEntry[]>([]);
  const [selected, setSelected] = useState<LocalEntry[]>([]);
  const [shown, setShown] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const grant = useRef<string | null>(null);
  const mounted = useRef(true);
  const cancelled = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void nativeCapabilities()
      .then((capabilities) => {
        if (mounted.current) setSupported(Boolean(capabilities?.folderPicker));
      })
      .catch((cause: unknown) => {
        if (mounted.current) setError(cause);
      });
    return () => {
      mounted.current = false;
      if (grant.current) void revokeLocalFolder(grant.current).catch(() => undefined);
    };
  }, []);
  async function browse(token: string, path: string) {
    const result = await listLocalFolder(token, path);
    if (!mounted.current || grant.current !== token) return;
    setEntries(result);
    setRelative(path);
    setShown(100);
  }
  async function close() {
    setBusy(true);
    setError(null);
    try {
      if (grant.current) await revokeLocalFolder(grant.current);
      grant.current = null;
      if (mounted.current) {
        setFolder(null);
        setSelected([]);
        setEntries([]);
      }
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function choose() {
    setBusy(true);
    setError(null);
    try {
      const result = await chooseLocalFolder();
      if (!result) return;
      if (!mounted.current) {
        await revokeLocalFolder(result.token);
        return;
      }
      grant.current = result.token;
      setFolder(result);
      setSelected([]);
      await browse(result.token, '');
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function navigate(path: string) {
    if (!folder || busy) return;
    setBusy(true);
    setError(null);
    try {
      await browse(folder.token, path);
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function attach() {
    if (!folder || !selected.length || selected.length > remaining || busy) return;
    if (selected.reduce((total, file) => total + file.sizeBytes, 0) > IMPORT_BYTES) {
      setError(new Error(`Select no more than ${bytes(IMPORT_BYTES)} in one import.`));
      return;
    }
    setBusy(true);
    setError(null);
    cancelled.current = false;
    try {
      for (const entry of selected) {
        if (!mounted.current || cancelled.current || grant.current !== folder.token) return;
        const contents = await readLocalFile(folder.token, entry.relativePath);
        if (!mounted.current || cancelled.current || grant.current !== folder.token) return;
        if (contents.byteLength > IMPORT_BYTES)
          throw new Error('This file exceeds the import size limit.');
        if (!(await onFiles([new File([contents], entry.name)])))
          throw new Error(
            'This file could not be uploaded. Previously attached files remain in your direction.'
          );
        setSelected((current) =>
          current.filter((file) => file.relativePath !== entry.relativePath)
        );
      }
      await close();
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  if (!supported) return error ? <ErrorNotice error={error} /> : null;
  return (
    <>
      <Button
        aria-label="Choose files from a local folder"
        disabled={disabled || remaining < 1}
        busy={busy}
        onClick={() => void choose()}
      >
        <FolderOpen size={18} />
      </Button>
      {!folder && <ErrorNotice error={error} />}
      {folder && (
        <Dialog
          title={`Attach from ${folder.name}`}
          onClose={() => {
            if (!busy) void close();
          }}
          wide
        >
          <div className="stack">
            <p className="muted">
              Browse only this chosen folder. Select up to {remaining} files, {bytes(IMPORT_BYTES)}{' '}
              total. Folder access ends when you close this window.
            </p>
            <div className="row">
              <strong>
                {folder.name}
                {relative ? ` / ${relative}` : ''}
              </strong>
              {relative && (
                <Button
                  disabled={busy}
                  onClick={() => void navigate(relative.split('/').slice(0, -1).join('/'))}
                >
                  Parent folder
                </Button>
              )}
            </div>
            <div className="local-folder-list">
              {entries.slice(0, shown).map((entry) =>
                entry.isDirectory ? (
                  <Button
                    key={entry.relativePath}
                    disabled={busy}
                    onClick={() => void navigate(entry.relativePath)}
                  >
                    <FolderOpen size={16} />
                    {entry.name}
                  </Button>
                ) : (
                  <label className="check" key={entry.relativePath}>
                    <input
                      type="checkbox"
                      checked={selected.some((file) => file.relativePath === entry.relativePath)}
                      disabled={
                        busy ||
                        entry.sizeBytes > IMPORT_BYTES ||
                        (selected.length >= remaining &&
                          !selected.some((file) => file.relativePath === entry.relativePath))
                      }
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, entry]
                            : current.filter((file) => file.relativePath !== entry.relativePath)
                        )
                      }
                    />
                    <span>
                      {entry.name} <small className="muted">{bytes(entry.sizeBytes)}</small>
                    </span>
                  </label>
                )
              )}
            </div>
            {!entries.length && !busy && <p className="empty">This folder is empty.</p>}
            {shown < entries.length && (
              <Button disabled={busy} onClick={() => setShown((current) => current + 100)}>
                Show more files
              </Button>
            )}
            <ErrorNotice error={error} />
            <div className="row">
              <Button disabled={busy} onClick={() => void close()}>
                Close and release folder
              </Button>
              {busy && (
                <Button
                  onClick={() => {
                    cancelled.current = true;
                    onCancel();
                  }}
                >
                  Cancel import
                </Button>
              )}
              <Button
                className="primary"
                disabled={!selected.length || selected.length > remaining}
                busy={busy}
                onClick={() => void attach()}
              >
                Attach {selected.length || ''} selected files
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
