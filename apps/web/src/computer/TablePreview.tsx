/* eslint jsx-a11y/no-noninteractive-tabindex: ["error", {"roles": ["region"]}] -- Keyboard users must be able to scroll the labeled data region. */
import { useEffect, useRef, useState } from 'react';
import type { TablePage } from '@athanor/contracts';
import { get } from '../client';
import { Button, ErrorNotice, Spinner } from '../ui';
import { processMemory } from '../process-display';
import './table-preview.css';

/** Only the visible page is retained; earlier pages are revisited using signed byte cursors. */
export default function TablePreview({ base, path }: { base: string; path: string }) {
  const [page, setPage] = useState<TablePage | null>(null);
  const [history, setHistory] = useState<Array<string | undefined>>([undefined]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const region = useRef<HTMLDivElement>(null);
  const cursor = history.at(-1);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPage(null);
    const query = new URLSearchParams({ path });
    if (cursor) query.set('cursor', cursor);
    void get<TablePage>(`${base}/table?${query}`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setPage(result);
        if (region.current) region.current.scrollTop = 0;
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [base, path, cursor, revision]);
  return (
    <section className="table-preview" aria-label={`Table preview for ${path}`}>
      <div className="table-preview-toolbar">
        <div aria-live="polite" aria-atomic="true">
          {page && (
            <>
              <strong>
                {page.rows.length
                  ? `Rows ${page.rowStart.toLocaleString()}–${(page.rowStart + page.rows.length - 1).toLocaleString()}`
                  : 'No data rows on this page'}
              </strong>
              <span className="muted">
                {' '}
                · {processMemory(page.sizeBytes)} · {page.format.toUpperCase()}
              </span>
            </>
          )}
        </div>
        <Button
          disabled={loading}
          onClick={() => {
            setHistory([undefined]);
            setRevision((value) => value + 1);
          }}
        >
          Refresh table
        </Button>
      </div>
      <ErrorNotice error={error} onRetry={() => setRevision((value) => value + 1)} />
      {loading && <Spinner label="Reading table page…" />}
      {page && (
        <>
          <p className="table-preview-note muted">
            Column types are inferred from this page. Values are shown as text.
          </p>
          {(page.columnsOmitted > 0 ||
            page.cellsTruncated > 0 ||
            page.columns.some((column) => column.truncated)) && (
            <p className="table-preview-note" role="status">
              {page.columnsOmitted > 0 &&
                `${page.columnsOmitted.toLocaleString()} additional columns are not shown. `}
              {page.cellsTruncated > 0 &&
                `${page.cellsTruncated.toLocaleString()} ${page.cellsTruncated === 1 ? 'long value is' : 'long values are'} shortened. `}
              {page.columns.some((column) => column.truncated) &&
                'Long column names are shortened. '}
              Download the file for all values.
            </p>
          )}
          {page.columns.length > 0 && (
            <div
              className="table-preview-scroll"
              ref={region}
              role="region"
              aria-label="Table data, scroll for more columns"
              tabIndex={0}
            >
              <table>
                <caption className="sr-only">
                  {path}, page {history.length}. Column types describe only the displayed rows.
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="table-preview-row-number">
                      Row
                    </th>
                    {page.columns.map((column, index) => (
                      <th scope="col" key={index}>
                        <span>
                          {column.name}
                          {column.truncated && '…'}
                        </span>
                        <small className="muted">{column.types.join(' / ') || 'no values'}</small>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row, index) => (
                    <tr key={index}>
                      <th scope="row" className="table-preview-row-number">
                        {(page.rowStart + index).toLocaleString()}
                      </th>
                      {page.columns.map((_, col) => (
                        <td key={col}>
                          {row[col]?.text === null || row[col] === undefined ? (
                            <span className="muted" aria-label="No value">
                              —
                            </span>
                          ) : (
                            row[col].text
                          )}
                          {row[col]?.truncated && (
                            <span className="table-preview-truncated" aria-label="Value shortened">
                              …
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <nav className="table-preview-pagination" aria-label="Table pages">
        <Button
          aria-label="Previous page"
          disabled={loading || history.length <= 1}
          onClick={() => setHistory((value) => value.slice(0, -1))}
        >
          Previous
        </Button>
        <span className="muted">Page {history.length.toLocaleString()}</span>
        <Button
          aria-label="Next page"
          disabled={loading || !page?.nextCursor}
          onClick={() => {
            if (page?.nextCursor) setHistory((value) => [...value, page.nextCursor!]);
          }}
        >
          Next
        </Button>
      </nav>
    </section>
  );
}
