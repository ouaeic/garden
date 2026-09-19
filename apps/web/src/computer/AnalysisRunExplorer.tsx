import { useEffect, useRef, useState } from 'react';
import type { AnalysisRunRecord } from '@athanor/contracts/analysis-run';
import AnalysisRunPreview, {
  type AnalysisLocation,
  type ProducerSelection
} from './AnalysisRunPreview';
import { checkedProducer } from './analysis-producer';
import { readWorkspaceFile } from './workspace-file';
import { message } from './format';
import { apiUrl } from '../client';

const RECENT_VIEWS = 32;

export default function AnalysisRunExplorer({
  record,
  location,
  onInspectingChange
}: {
  record: AnalysisRunRecord;
  location: AnalysisLocation;
  onInspectingChange?: (value: boolean) => void;
}) {
  const [history, setHistory] = useState<ProducerSelection[]>([]);
  const [loaded, setLoaded] = useState<{
    selection: ProducerSelection;
    record?: AnalysisRunRecord;
    error?: string;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const container = useRef<HTMLElement>(null);
  const navigated = useRef(false);
  const selection = history.at(-1);
  const current = selection ? (loaded?.selection === selection ? loaded : null) : null;
  useEffect(() => {
    if (!selection) return;
    const controller = new AbortController();
    setLoaded(null);
    void readWorkspaceFile(location.workspaceId, selection.path, {
      windowed: true,
      signal: controller.signal
    })
      .then((file) => {
        const producer = checkedProducer(file, selection.input);
        if (!controller.signal.aborted) setLoaded({ selection, record: producer });
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setLoaded({ selection, error: message(cause) });
      });
    return () => controller.abort();
  }, [location.workspaceId, selection, attempt]);
  useEffect(() => {
    if (selection) heading.current?.focus();
    else if (navigated.current) container.current?.focus();
    navigated.current = Boolean(selection);
    onInspectingChange?.(Boolean(selection));
  }, [selection, onInspectingChange]);
  return (
    <section
      ref={container}
      tabIndex={-1}
      className="stack analysis-run-explorer"
      aria-label="Analysis provenance"
    >
      {selection && (
        <section className="stack analysis-provenance-nav" aria-label="Producer navigation">
          <div className="row">
            <button className="button" onClick={() => setHistory([])}>
              Original run
            </button>
            {history.length > 1 && (
              <button className="button" onClick={() => setHistory((items) => items.slice(0, -1))}>
                Previous producer
              </button>
            )}
          </div>
          <h3 ref={heading} tabIndex={-1} className="sr-only">
            Producer: {selection.input.producer?.name || 'record'}
          </h3>
          <p className="analysis-run-path">
            <code>{selection.path}</code>
          </p>
          {!current && <p role="status">Checking producer record…</p>}
          {current?.error && (
            <>
              <p role="alert" className="error">
                {current.error}
              </p>
              <div className="row">
                <button className="button" onClick={() => setAttempt((value) => value + 1)}>
                  Check again
                </button>
                <a
                  href={apiUrl(
                    `/v1/workspaces/${location.workspaceId}/download?${new URLSearchParams({ path: selection.path })}`
                  )}
                  download={selection.path.split('/').at(-1)}
                >
                  Download current record
                </a>
              </div>
            </>
          )}
          {current?.record && <p role="status">File matches the recorded producer and output.</p>}
          <details>
            <summary>About this check</summary>
            <p className="muted">
              The complete file is checked against the recorded SHA-256, run identity and output.
              Opening never runs commands. Each link is checked separately; this does not establish
              scientific validity or verify the whole chain.
            </p>
          </details>
        </section>
      )}
      {(!selection || current?.record) && (
        <AnalysisRunPreview
          key={selection ? selection.path + selection.input.producer?.sha256 : record.id}
          record={current?.record ?? record}
          location={selection ? { ...location, manifestPath: selection.path } : location}
          onInspectProducer={(next) => setHistory((items) => [...items, next].slice(-RECENT_VIEWS))}
        />
      )}
    </section>
  );
}
