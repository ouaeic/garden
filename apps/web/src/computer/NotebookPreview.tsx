/* eslint jsx-a11y/no-noninteractive-tabindex: ["error", {"roles": ["region"]}] -- Long text remains keyboard-scrollable inside each labeled region. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Markdown from '../MarkdownBody';
import { Button, ErrorNotice, Spinner } from '../ui';
import { shareArtifactDocument } from '../share-html';
import { notebookHtml } from './notebook-html';
import {
  notebookAttachments,
  notebookImage,
  notebookObject,
  notebookText,
  parseNotebook,
  readNotebookResponse,
  type Notebook
} from './notebook';
import './notebook-preview.css';

const CELLS_PER_PAGE = 20;
const OUTPUTS_PER_PAGE = 10;
const TEXT_PER_PAGE = 16000;
const MARKDOWN_LIMIT = 32000;
const HTML_LIMIT = 262144;

function Pages({
  label,
  page,
  count,
  onChange
}: {
  label: string;
  page: number;
  count: number;
  onChange: (page: number) => void;
}) {
  if (count <= 1) return null;
  return (
    <nav className="notebook-pages" aria-label={label}>
      <Button disabled={page === 0} onClick={() => onChange(page - 1)}>
        Previous<span className="sr-only"> {label.toLowerCase()}</span>
      </Button>
      <span role="status">
        Page {page + 1} of {count.toLocaleString()}
      </span>
      <Button disabled={page + 1 >= count} onClick={() => onChange(page + 1)}>
        Next<span className="sr-only"> {label.toLowerCase()}</span>
      </Button>
    </nav>
  );
}

function TextBlock({ text, label = 'Text' }: { text: string; label?: string }) {
  const [page, setPage] = useState(0);
  const pages = Math.ceil(text.length / TEXT_PER_PAGE);
  return (
    <div className="notebook-text">
      {pages > 1 && (
        <p className="muted">
          {label}: characters {(page * TEXT_PER_PAGE + 1).toLocaleString()}–
          {Math.min(text.length, (page + 1) * TEXT_PER_PAGE).toLocaleString()} of{' '}
          {text.length.toLocaleString()}.
        </p>
      )}
      <pre role="region" aria-label={label} tabIndex={0}>
        <code>{text.slice(page * TEXT_PER_PAGE, (page + 1) * TEXT_PER_PAGE)}</code>
      </pre>
      <Pages label={`${label} pages`} page={page} count={pages} onChange={setPage} />
    </div>
  );
}

function RawValue({ value, label = 'Recorded JSON' }: { value: unknown; label?: string }) {
  return <TextBlock text={JSON.stringify(value, null, 2) ?? 'null'} label={label} />;
}

function Disclosure({ title, children }: { title: string; children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{title}</summary>
      {open && children()}
    </details>
  );
}

function FormattedOutput({ html, label }: { html: string; label: string }) {
  const safe = useMemo(() => notebookHtml(html), [html]);
  return (
    <>
      <p className="muted">
        Static formatting only; interactive content and linked images are omitted.
        {safe.limited
          ? ' Some deeply nested or extensive content is omitted; inspect Output data for the original.'
          : ''}
      </p>
      <iframe
        className="notebook-html"
        srcDoc={shareArtifactDocument(
          '<style>body{font:14px system-ui;line-height:1.5;margin:16px;color:#242b29}table{border-collapse:collapse}td,th{padding:6px 10px;border:1px solid #d5ded9;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>' +
            safe.html
        )}
        sandbox=""
        referrerPolicy="no-referrer"
        title={`${label}, recorded HTML`}
      />
    </>
  );
}

function RichOutput({ data, label }: { data: unknown; label: string }) {
  const bundle = notebookObject(data);
  const image = notebookImage(bundle);
  const html = notebookText(bundle?.['text/html']);
  const plain = notebookText(bundle?.['text/plain']);
  if (image)
    return (
      <figure className="notebook-image">
        <img src={image} alt={`${label}, recorded`} loading="lazy" />
        {plain && (
          <figcaption>
            <TextBlock text={plain} label={`${label} description`} />
          </figcaption>
        )}
      </figure>
    );
  if (html !== null && html.length <= HTML_LIMIT)
    return (
      <>
        {plain !== null && <TextBlock text={plain} label={label} />}
        <Disclosure title="Formatted output">
          {() => <FormattedOutput html={html} label={label} />}
        </Disclosure>
      </>
    );
  if (plain !== null) return <TextBlock text={plain} label={label} />;
  if (bundle && 'application/json' in bundle)
    return <RawValue value={bundle['application/json']} label={label} />;
  return (
    <>
      <p className="muted">
        This output format cannot be displayed. Its recorded data is available below.
      </p>
      <RawValue value={data} label={label} />
    </>
  );
}

function Output({ value, index, cell }: { value: unknown; index: number; cell: number }) {
  const output = notebookObject(value);
  const label = `Cell ${cell} output ${index + 1}`;
  if (output?.output_type === 'stream') {
    const text = notebookText(output.text);
    return (
      <div className="notebook-output">
        <small className="muted">
          {output.name === 'stderr'
            ? 'Standard error'
            : output.name === 'stdout'
              ? 'Standard output'
              : 'Stream'}
        </small>
        {text === null ? (
          <RawValue value={value} label={label} />
        ) : (
          <TextBlock text={text} label={label} />
        )}
      </div>
    );
  }
  if (output?.output_type === 'error') {
    const traceback =
      Array.isArray(output.traceback) && output.traceback.every((line) => typeof line === 'string')
        ? output.traceback.join('\n')
        : null;
    return (
      <div className="notebook-output notebook-error">
        <strong>Recorded error</strong>
        {traceback ? (
          <TextBlock text={traceback} label={label} />
        ) : (
          <RawValue value={value} label={label} />
        )}
      </div>
    );
  }
  if (output?.output_type === 'display_data' || output?.output_type === 'execute_result')
    return (
      <div className="notebook-output">
        <RichOutput data={output.data} label={label} />
        <Disclosure title="Output data">
          {() => <RawValue value={value} label={`${label} JSON`} />}
        </Disclosure>
      </div>
    );
  return (
    <div className="notebook-output">
      <p className="muted">Unrecognized output; showing its recorded data.</p>
      <RawValue value={value} label={label} />
    </div>
  );
}

function Cell({ value, index }: { value: unknown; index: number }) {
  const cell = notebookObject(value);
  const source = notebookText(cell?.source);
  const images = useMemo(() => notebookAttachments(cell?.attachments), [cell?.attachments]);
  const [outputPage, setOutputPage] = useState(0);
  const number = index + 1;
  const kind = cell?.cell_type;
  const known = kind === 'markdown' || kind === 'code' || kind === 'raw';
  const outputs: unknown[] | null = Array.isArray(cell?.outputs) ? cell.outputs : null;
  const execution = cell?.execution_count;
  return (
    <article className="notebook-cell" aria-label={`Cell ${number}`}>
      <header>
        <strong>Cell {number}</strong>
        <span className="muted">
          {kind === 'markdown'
            ? 'Markdown'
            : kind === 'code'
              ? 'Code'
              : kind === 'raw'
                ? 'Raw text'
                : 'Unrecognized cell'}
        </span>
        {kind === 'code' && (
          <span className="muted">
            {typeof execution === 'number' && Number.isSafeInteger(execution) && execution >= 0
              ? `Execution ${execution}`
              : 'No execution count'}
          </span>
        )}
      </header>
      {!known ? (
        <RawValue value={value} label={`Cell ${number} JSON`} />
      ) : source === null ? (
        <>
          <p className="muted">Cell source is missing or malformed.</p>
          <RawValue value={value} label={`Cell ${number} JSON`} />
        </>
      ) : kind === 'markdown' && source.length <= MARKDOWN_LIMIT ? (
        <Markdown imageSources={images}>{source}</Markdown>
      ) : (
        <>
          {kind === 'markdown' && (
            <p className="muted">Long Markdown is shown as paged source text.</p>
          )}
          <TextBlock text={source} label={`Cell ${number} source`} />
        </>
      )}
      {kind === 'code' &&
        (outputs ? (
          <>
            {outputs.length === 0 && <p className="notebook-empty muted">No saved output.</p>}
            {outputs
              .slice(outputPage * OUTPUTS_PER_PAGE, (outputPage + 1) * OUTPUTS_PER_PAGE)
              .map((output, offset) => (
                <Output
                  key={outputPage * OUTPUTS_PER_PAGE + offset}
                  value={output}
                  index={outputPage * OUTPUTS_PER_PAGE + offset}
                  cell={number}
                />
              ))}
            <Pages
              label={`Cell ${number} outputs`}
              page={outputPage}
              count={Math.ceil(outputs.length / OUTPUTS_PER_PAGE)}
              onChange={setOutputPage}
            />
          </>
        ) : (
          <p className="notebook-empty muted">This code cell has no valid output list.</p>
        ))}
      {known && (
        <Disclosure title="Cell data">
          {() => <RawValue value={value} label={`Cell ${number} JSON`} />}
        </Disclosure>
      )}
    </article>
  );
}

export function NotebookDocument({ notebook, content }: { notebook: Notebook; content: string }) {
  const [page, setPage] = useState(0);
  const [source, setSource] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <div className="notebook-preview">
      <div className="notebook-toolbar">
        <h3 ref={heading} tabIndex={-1}>
          Notebook
        </h3>
        <div className="row" role="group" aria-label="Notebook display">
          <Button aria-pressed={!source} onClick={() => setSource(false)}>
            Cells
          </Button>
          <Button aria-pressed={source} onClick={() => setSource(true)}>
            Source JSON
          </Button>
        </div>
      </div>
      <p className="muted notebook-note">
        {notebook.cells.length.toLocaleString()} {notebook.cells.length === 1 ? 'cell' : 'cells'}
        {notebook.kernel || notebook.language ? ` · ${notebook.kernel || notebook.language}` : ''}.
        Saved outputs may be stale. Opening this preview does not run code.
      </p>
      {source ? (
        <TextBlock text={content} label="Notebook JSON" />
      ) : (
        <>
          {notebook.cells.length === 0 && <p>This notebook has no cells.</p>}
          <p className="sr-only" role="status">
            {notebook.cells.length
              ? `Showing cells ${page * CELLS_PER_PAGE + 1} to ${Math.min(notebook.cells.length, (page + 1) * CELLS_PER_PAGE)}`
              : 'No cells'}
          </p>
          {notebook.cells
            .slice(page * CELLS_PER_PAGE, (page + 1) * CELLS_PER_PAGE)
            .map((value, offset) => (
              <Cell
                key={page * CELLS_PER_PAGE + offset}
                value={value}
                index={page * CELLS_PER_PAGE + offset}
              />
            ))}
          <Pages
            label="Notebook cells"
            page={page}
            count={Math.ceil(notebook.cells.length / CELLS_PER_PAGE)}
            onChange={(next) => {
              setPage(next);
              heading.current?.focus();
            }}
          />
        </>
      )}
    </div>
  );
}

export default function NotebookPreview({ url, name }: { url: string; name: string }) {
  const [loaded, setLoaded] = useState<{ notebook: Notebook; content: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
    setLoaded(null);
    setError(null);
    void fetch(url, { credentials: 'include', signal, redirect: 'error' })
      .then(readNotebookResponse)
      .then((content) => {
        const notebook = parseNotebook(content);
        if (!controller.signal.aborted) setLoaded({ notebook, content });
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      });
    return () => controller.abort();
  }, [url, revision]);
  return (
    <section aria-label={`Notebook preview for ${name}`}>
      <ErrorNotice error={error} onRetry={() => setRevision((value) => value + 1)} />
      {!error && !loaded && <Spinner label="Opening notebook…" />}
      {loaded && <NotebookDocument key={`${url}:${revision}`} {...loaded} />}
    </section>
  );
}
