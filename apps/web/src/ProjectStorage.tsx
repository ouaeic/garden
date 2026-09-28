import { useEffect, useRef, useState } from 'react';
import type { ProjectStorageUsage } from '@garden/contracts';
import { get } from './client';
import { Button, ErrorNotice, Spinner } from './ui';
import './project-storage.css';

const bytes = (value: number) => {
  if (value < 1024) return `${value.toLocaleString()} B`;
  const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
};

export function ProjectStorageDetails({ usage }: { usage: ProjectStorageUsage }) {
  return (
    <>
      <dl className="project-storage-metrics">
        <div>
          <dt>File allocation</dt>
          <dd>{bytes(usage.allocatedBytes)}</dd>
        </div>
        <div>
          <dt>Combined file sizes</dt>
          <dd>{bytes(usage.logicalBytes)}</dd>
        </div>
        <div>
          <dt>Shared file copies</dt>
          <dd>{usage.sharedCopies.toLocaleString()}</dd>
        </div>
      </dl>
      {!usage.complete && (
        <p role="status" className="project-storage-partial">
          Partial scan: these measurements cover only the entries inspected.
          {usage.limited && ' The scan reached its size or time limit.'}
          {usage.changedDuringScan && ' Files changed while they were being counted.'}
          {usage.skippedEntries > 0 &&
            ` ${usage.skippedEntries.toLocaleString()} ${usage.skippedEntries === 1 ? 'entry' : 'entries'} could not be counted.`}
        </p>
      )}
      <p className="muted">
        Shared copies reuse storage. A cleanup preview estimates the space released by its selected
        files.
      </p>
      <details className="project-storage-scope">
        <summary>What this measures</summary>
        <p className="muted">
          Includes stored project versions, prepared updates and their records. Conversation working
          folders and job files are separate. Folder and filesystem overhead are excluded.
        </p>
        <p className="muted">
          Shared file copies are counted once in allocated blocks. Some blocks may also be used
          elsewhere, so this is not an estimate of space that can be freed.
        </p>
      </details>
      <small className="muted">
        Sampled {new Date(usage.observedAt).toLocaleString()} ·{' '}
        {usage.fileReferences.toLocaleString()} file references
      </small>
    </>
  );
}

export default function ProjectStorage({ projectId }: { projectId: string }) {
  const [usage, setUsage] = useState<ProjectStorageUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const read = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    try {
      const result = await get<ProjectStorageUsage>(`/v1/projects/${projectId}/storage`, {
        signal: controller.signal
      });
      if (!controller.signal.aborted) setUsage(result);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <details
      className="project-storage"
      onToggle={(event) => {
        if (event.currentTarget.open && !usage && !busy) void read();
      }}
    >
      <summary>History storage</summary>
      <div className="project-storage-body">
        <ErrorNotice error={error} />
        {usage && <ProjectStorageDetails usage={usage} />}
        {busy && <Spinner label="Measuring stored project files…" />}
        <Button
          aria-disabled={busy}
          aria-busy={busy}
          onClick={() => {
            if (!busy) void read();
          }}
        >
          {usage ? 'Refresh measurement' : 'Measure storage'}
        </Button>
      </div>
    </details>
  );
}
