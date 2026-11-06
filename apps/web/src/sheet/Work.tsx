import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { Artifact, OwnerMove, ResultNote, Task } from '@garden/contracts';
import { kindOf, sizeText } from '../app/kinds';
import { openArtifact } from '../app/viewer';
import { CommentSurface } from '../result-notes';
import { TaskOutputs } from '../TaskCanvas';
import { currentWork } from '../current-work';
import { surfaceAnswer, answerIsStreaming } from '../model';
import type { useTaskRecord } from '../useTaskRecord';
import { contentUrl, parseTable, useFileText, WorkingFace } from '../desk/faces';
import type { Form } from '../desk/forms';
import type { Outcome, OutcomeFile } from '../desk/outcomes';
import { shareArtifactDocument } from '../share-html';

const Markdown = lazy(() => import('../MarkdownBody'));
const PdfPreview = lazy(() => import('../computer/PdfPreview'));
const CodingMissions = lazy(() => import('../CodingMissions'));
const MediaJobs = lazy(() => import('../MediaJobs'));
const ResultPreview = lazy(() =>
  import('../computer/ResultPreview').then((module) => ({ default: module.ResultPreview }))
);

type Record = ReturnType<typeof useTaskRecord>;

/** The newest version of every file a goal made, newest first. */
const latest = (artifacts: readonly Artifact[]): OutcomeFile[] => {
  const byName = new Map<string, Artifact>();
  for (const artifact of artifacts) {
    const held = byName.get(artifact.name);
    if (!held || artifact.version > held.version) byName.set(artifact.name, artifact);
  }
  return [...byName.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
};

/**
 * The work, at the size it deserves and in its own form: a site as a page you can look at on a
 * phone or a desk, a document as pages, data as a table, an answer set like a page of a good
 * book. Select any part of it and the bar below takes the passage as what to change.
 */
export default function Work({
  task,
  moves,
  record,
  outcome,
  form,
  working,
  comments,
  onNote
}: {
  task: Task;
  moves: readonly OwnerMove[];
  record: Record;
  outcome: Outcome | undefined;
  form: Form;
  working: boolean;
  comments: ResultNote[];
  onNote: (note: ResultNote) => void;
}) {
  const files = useMemo(
    () => (outcome?.files.length ? outcome.files : latest(record.artifacts)),
    [outcome?.files, record.artifacts]
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const shown = files.find((file) => file.id === chosen) ?? files[0];
  const presentation = currentWork(record.storedPresentation, record.events);
  const since = presentation?.surface?.direction?.sequence ?? 0;
  const current = record.events.filter((event) => event.sequence >= since);
  const answer = surfaceAnswer(current);
  const writing = answer.partial && answerIsStreaming(current, task.status);
  const text = outcome?.answer ?? answer.markdown;
  const previews = presentation?.results.filter((result) => result.kind === 'preview') ?? [];
  const doing = [...record.events]
    .reverse()
    .find(
      (event) =>
        ['tool_started', 'plan', 'notice', 'subagent', 'status'].includes(event.kind) &&
        event.summary?.trim()
    )?.summary;

  return (
    <div className={`work-area is-${form}`}>
      {files.length > 1 && (
        <nav className="work-files" aria-label="What it made">
          {files.map((file) => {
            const kind = kindOf(file.name, file.mimeType);
            return (
              <button
                key={file.id}
                type="button"
                aria-pressed={file.id === shown?.id}
                onClick={() => setChosen(file.id)}
              >
                <kind.icon aria-hidden="true" />
                <span>{file.name}</span>
              </button>
            );
          })}
        </nav>
      )}
      {previews.length > 0 && presentation && (
        <TaskOutputs
          presentation={{ ...presentation, results: previews }}
          events={record.events}
          artifacts={record.artifacts}
          onArtifact={(id) => {
            const artifact = record.artifacts.find((item) => item.id === id);
            if (artifact) openArtifact(artifact);
          }}
          notes={comments}
          onNote={onNote}
          afterPreview={null}
        />
      )}
      {shown ? (
        <FileWork key={shown.id} file={shown} />
      ) : text ? (
        <article className={`work-paper ${writing ? 'is-writing' : ''}`}>
          <Suspense fallback={<div className="skeleton" style={{ height: 120 }} />}>
            <CommentSurface on="the answer" notes={comments} onNote={onNote}>
              <Markdown artifacts={record.artifacts} imageMode="links">
                {text}
              </Markdown>
            </CommentSurface>
          </Suspense>
        </article>
      ) : working ? (
        <div className="work-assembling">
          <WorkingFace task={task} moves={moves} form={form} doing={doing} live={answer.markdown} />
        </div>
      ) : (
        <p className="work-nothing">Nothing was made in this goal.</p>
      )}
      <Suspense fallback={null}>
        <CodingMissions
          taskId={task.id}
          onOpenTask={() => undefined}
          onChange={() => void record.reload()}
        />
        <MediaJobs taskId={task.id} onDelivered={() => void record.reload()} />
      </Suspense>
    </div>
  );
}

/** One file, shown as the thing it is. */
function FileWork({ file }: { file: OutcomeFile }) {
  const kind = kindOf(file.name, file.mimeType).id;
  const pdf = /pdf$/i.test(file.mimeType) || /\.pdf$/i.test(file.name);
  if (pdf)
    return (
      <div className="work-pdf">
        <Suspense fallback={<div className="skeleton work-skeleton" />}>
          <PdfPreview url={contentUrl(file)} name={file.name} />
        </Suspense>
      </div>
    );
  if (kind === 'data' && /\.(csv|tsv)$|csv|tab-separated/i.test(file.name + file.mimeType))
    return <TableWork file={file} />;
  if (
    kind === 'doc' &&
    /\.(md|markdown|txt)$|markdown|text\/plain/i.test(file.name + file.mimeType)
  )
    return <TextWork file={file} />;
  if (kind === 'image')
    return (
      <figure className="work-image">
        <img src={contentUrl(file)} alt={file.name} />
      </figure>
    );
  return <PageOrFile file={file} />;
}

/** A page it built, shown as a page, at the width of a desk or of a phone. */
function PageOrFile({ file }: { file: OutcomeFile }) {
  const html = useFileText(file);
  const page =
    html && /<(?:!doctype html|html|body|div|section|main)[\s>]/i.test(html) ? html : null;
  const [phone, setPhone] = useState(false);
  if (html === null) return <div className="skeleton work-skeleton" />;
  if (!page)
    return (
      <div className="work-other">
        <Suspense fallback={<div className="skeleton work-skeleton" />}>
          <ResultPreview artifact={file} />
        </Suspense>
      </div>
    );
  return (
    <div className="work-site">
      <div className="work-site-bar">
        <span className="work-site-name">{file.name}</span>
        <span className="seg" role="group" aria-label="Width">
          <button type="button" aria-pressed={!phone} onClick={() => setPhone(false)}>
            Desktop
          </button>
          <button type="button" aria-pressed={phone} onClick={() => setPhone(true)}>
            Phone
          </button>
        </span>
      </div>
      <div className={`work-site-stage ${phone ? 'is-phone' : ''}`}>
        <iframe
          title={file.name}
          srcDoc={shareArtifactDocument(page)}
          sandbox=""
          referrerPolicy="no-referrer"
        />
      </div>
      <p className="work-site-note">
        Shown without its scripts, so nothing in it can run here. Download it to use it fully.
      </p>
    </div>
  );
}

function TableWork({ file }: { file: OutcomeFile }) {
  const text = useFileText(file);
  const table = useMemo(
    () => (text ? parseTable(text, file.name, 400, 40) : null),
    [text, file.name]
  );
  if (!table) return <div className="skeleton work-skeleton" />;
  return (
    <div className="work-data">
      <Bars head={table.head} rows={table.body} />
      <div className="work-table-wrap">
        <table className="work-table">
          <thead>
            <tr>
              {table.head.map((cell, index) => (
                <th key={index}>{cell}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.body.map((row, index) => (
              <tr key={index}>
                {row.map((cell, column) => (
                  <td
                    key={column}
                    className={/^[-+]?[$£€]?\d[\d,]*(\.\d+)?%?$/.test(cell) ? 'num' : ''}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="work-table-note">
          {table.total} rows · {sizeText(file.sizeBytes)}
          {table.total > table.body.length ? ` · showing the first ${table.body.length}` : ''}
        </p>
      </div>
    </div>
  );
}

const amount = (value: string): number | null => {
  const cleaned = value.replace(/[\s,$£€%]/g, '');
  return /^[-+]?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
};

/**
 * The table's main column drawn as bars, so its shape is seen before a row is read. The label is
 * the first column of words; the value the last column of amounts that is not a share or a change,
 * which a bar of absolute length would misstate. A total row is left out of its own comparison.
 */
function Bars({ head, rows }: { head: string[]; rows: string[][] }) {
  const labelAt = head.findIndex((_, column) =>
    rows.some((row) => row[column] && amount(row[column]) === null)
  );
  const body = rows.filter((row) => !/^(total|sum|all)$/i.test((row[labelAt] ?? '').trim()));
  const numeric = head
    .map((name, column) => ({ name, column }))
    .filter(
      ({ column }) =>
        column !== labelAt &&
        body.length > 1 &&
        body.every((row) => row[column] !== undefined && amount(row[column]) !== null)
    );
  // The last such column, which in a table of periods is the latest one.
  const chosen =
    [...numeric]
      .reverse()
      .find(
        ({ name, column }) =>
          !/%|share|change|rate|growth/i.test(name) &&
          !body.some((row) => row[column]!.includes('%'))
      ) ?? null;
  if (labelAt < 0 || !chosen || body.length > 24) return null;
  const values = body.map((row) => amount(row[chosen.column]!) ?? 0);
  const top = Math.max(...values.map(Math.abs), 1);
  return (
    <figure className="work-bars" aria-label={`${chosen.name} by ${head[labelAt]}`}>
      <figcaption>
        {chosen.name} <span>by {head[labelAt]?.toLowerCase()}</span>
      </figcaption>
      {body.map((row, index) => (
        <div key={index} className="work-bar">
          <span className="work-bar-label">{row[labelAt]}</span>
          <span className="work-bar-track">
            <i
              style={{ '--w': `${(Math.abs(values[index]!) / top) * 100}%` } as React.CSSProperties}
            />
          </span>
          <span className="work-bar-value num">{row[chosen.column]}</span>
        </div>
      ))}
    </figure>
  );
}

function TextWork({ file }: { file: OutcomeFile }) {
  const text = useFileText(file);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(text !== null), [text]);
  if (!ready || text === null) return <div className="skeleton work-skeleton" />;
  return (
    <article className="work-paper">
      <Suspense fallback={<div className="skeleton" style={{ height: 120 }} />}>
        <Markdown imageMode="links">{text}</Markdown>
      </Suspense>
    </article>
  );
}
