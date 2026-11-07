import { useEffect, useRef, useState, type RefObject } from 'react';
import type { OwnerMove, Task } from '@garden/contracts';
import { doingText } from '../app/activity';
import { goalLine, leaves } from '../app/derive';
import { kindOf, sizeText } from '../app/kinds';
import { shareArtifactDocument } from '../share-html';
import { MoveCard } from '../today/Moves';
import type { Form } from './forms';
import { leadOf } from './lead';
import type { Outcome, OutcomeFile } from './outcomes';

export const contentUrl = (file: Pick<OutcomeFile, 'id'>) =>
  `/v1/artifacts/${encodeURIComponent(file.id)}/content`;

const texts = new Map<string, Promise<string>>();

/** A small file's text, read once per version and shared by every face and sheet that shows it. */
export function useFileText(file: OutcomeFile | undefined, enabled = true): string | null {
  const [text, setText] = useState<string | null>(null);
  const key = file ? `${file.id}@${file.version}` : '';
  useEffect(() => {
    setText(null);
    if (!file || !enabled || file.sizeBytes > 600_000) return;
    let live = true;
    let work = texts.get(key);
    if (!work) {
      work = fetch(contentUrl(file), { credentials: 'include' }).then((response) =>
        response.ok ? response.text() : Promise.reject(new Error(String(response.status)))
      );
      texts.set(key, work);
      work.catch(() => texts.delete(key));
    }
    work.then(
      (value) => live && setText(value),
      () => live && setText('')
    );
    return () => {
      live = false;
    };
    // The version key stands for the file.
  }, [key, enabled]);
  return text;
}

/** True once the element has been on screen, so heavy faces draw only what is looked at. */
export function useSeen<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return;
    if (typeof IntersectionObserver === 'undefined') return void setSeen(true);
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);
  return [ref, seen];
}

/** Plain words out of a line of markdown, for the small type on a face. */
export const plain = (line: string) =>
  line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The first few points an answer makes, when it makes them as a list. */
export function pointsOf(answer: string | null, limit = 3): string[] {
  if (!answer) return [];
  return answer
    .split('\n')
    .filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line))
    .map((line) => plain(line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')))
    .filter(Boolean)
    .slice(0, limit);
}

/** An answer as a card: its conclusion in display type, and the points it rests on. */
export function AnswerFace({
  headline,
  answer,
  kicker = 'Answer',
  live,
  rich = false
}: {
  headline: string;
  answer: string | null;
  kicker?: string;
  live?: string | null;
  /** Room for more of it: what was just asked, shown large in front. */
  rich?: boolean;
}) {
  if (live)
    return (
      <div className="face face-paper face-answer is-live">
        <span className="face-kicker">{kicker}</span>
        <div className="face-live-text">{plain(live).slice(-900)}</div>
      </div>
    );
  const text = plain(headline);
  const { lead, dek } = leadOf(text);
  // A number or a word reads best large; a sentence, set like a pull quote.
  const short = lead.length <= 12;
  const brief = !short && lead.length <= 72;
  const points = short ? [] : pointsOf(answer, rich ? 7 : 3);
  // Without a list, a rich card carries on with the answer's next lines instead.
  const rest =
    rich && !points.length && answer
      ? answer
          .split('\n')
          .map(plain)
          // The headline is the reply's first sentence; what follows it on that line carries on.
          .map((line) => (line.startsWith(text) ? line.slice(text.length).trim() : line))
          .filter(Boolean)
          .slice(0, 4)
      : [];
  return (
    <div className={`face face-paper face-answer ${short ? 'is-short' : brief ? 'is-brief' : ''}`}>
      <span className="face-kicker">{kicker}</span>
      <p className="face-answer-text">{lead || 'Answered'}</p>
      {dek && <p className="face-dek">{dek}</p>}
      {points.length > 0 && (
        <ul className="face-points">
          {points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      )}
      {rest.length > 0 && (
        <div className="face-rest">
          {rest.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
    </div>
  );
}

/** A document as its first page: the PDF itself drawn small, or its text set as a page. */
export function PageFace({
  file,
  title,
  answer
}: {
  file: OutcomeFile | undefined;
  title: string;
  answer: string | null;
}) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const isPdf = Boolean(file && /pdf$/i.test(file.mimeType + file.name));
  const [image, setImage] = useState<string | null>(null);
  const text = useFileText(file, seen && !isPdf && Boolean(file));
  useEffect(() => {
    if (!seen || !isPdf || !file) return;
    let live = true;
    void import('./pdf-thumb')
      .then(({ pdfThumb }) => pdfThumb(contentUrl(file), `${file.id}@${file.version}`, 300))
      .then(
        (url) => live && setImage(url),
        () => undefined
      );
    return () => {
      live = false;
    };
  }, [seen, isPdf, file]);
  const body = (text ?? answer ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .slice(0, 28);
  return (
    <div className="face face-desk" ref={ref}>
      <div className={`page ${image ? 'has-image' : ''}`}>
        {image ? (
          <img src={image} alt="" className="page-image" />
        ) : (
          <>
            <span className="page-title">{plain(body[0]?.startsWith('#') ? body[0] : title)}</span>
            <div className="page-lines" aria-hidden="true">
              {body
                .slice(body[0]?.startsWith('#') ? 1 : 0)
                .map((line, index) =>
                  /^#{1,3}\s/.test(line) ? (
                    <b key={index}>{plain(line)}</b>
                  ) : (
                    <span key={index}>{plain(line)}</span>
                  )
                )}
            </div>
          </>
        )}
      </div>
      {file && <span className="face-file-name">{file.name}</span>}
    </div>
  );
}

/**
 * A site as a site: the page it built, drawn live but inert - no scripts, nothing fetched from
 * outside - in the frame every page gets, scaled to the card.
 */
export function SiteFace({
  file,
  label,
  outcome
}: {
  file: OutcomeFile | undefined;
  label: string;
  outcome: Outcome | undefined;
}) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const html = useFileText(file, seen && Boolean(file));
  const page =
    html && /<(?:!doctype html|html|body|div|section|main)[\s>]/i.test(html) ? html : null;
  const [scale, setScale] = useState(0.3);
  // The page fades in over its wireframe once it has drawn, rather than flashing an empty frame.
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setScale(entry.contentRect.width / 1280);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return (
    <div className="face face-site">
      <div className="site-chrome" aria-hidden="true">
        <i />
        <i />
        <i />
        <span>{outcome?.previews[0]?.label ?? label}</span>
      </div>
      <div className="site-view" ref={ref} style={{ '--s': scale } as React.CSSProperties}>
        {!drawn && (
          <div className="site-wire" aria-hidden="true">
            <b />
            <span />
            <span />
            <span />
          </div>
        )}
        {page && (
          <iframe
            title={label}
            className={drawn ? 'is-drawn' : undefined}
            srcDoc={shareArtifactDocument(page)}
            sandbox=""
            referrerPolicy="no-referrer"
            tabIndex={-1}
            onLoad={() => setDrawn(true)}
          />
        )}
      </div>
    </div>
  );
}

const splitRow = (line: string, separator: string) => {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === separator && !quoted) {
      cells.push(cell);
      cell = '';
    } else cell += char;
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
};

/** A delimited table's first rows, enough to see what the data is. */
export function parseTable(text: string, name: string, rows = 6, columns = 5) {
  const separator = /\.tsv$/i.test(name) || (text.split('\n')[0] ?? '').includes('\t') ? '\t' : ',';
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const table = lines.slice(0, rows + 1).map((line) => splitRow(line, separator).slice(0, columns));
  return { head: table[0] ?? [], body: table.slice(1), total: Math.max(0, lines.length - 1) };
}

const numeric = (value: string) => /^[-+]?[$£€]?\d[\d,]*(\.\d+)?%?$/.test(value.trim());

/** Data as a table: the columns and the first rows, numbers set as numbers. */
export function DataFace({ file }: { file: OutcomeFile | undefined }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const delimited = Boolean(
    file && /\.(csv|tsv)$|csv|tab-separated/i.test(file.name + file.mimeType)
  );
  const text = useFileText(file, seen && delimited);
  const table = text && file ? parseTable(text, file.name) : null;
  return (
    <div className="face face-paper face-data" ref={ref}>
      <span className="face-kicker">{file?.name ?? 'Data'}</span>
      {table ? (
        <table className="face-table">
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
                  <td key={column} className={numeric(cell) ? 'num' : ''}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="face-bars" aria-hidden="true">
          {[0.55, 0.8, 0.35, 0.95, 0.62, 0.74].map((height, index) => (
            <i key={index} style={{ '--h': height } as React.CSSProperties} />
          ))}
        </div>
      )}
      {table && table.total > table.body.length && (
        <span className="face-more">{table.total} rows</span>
      )}
    </div>
  );
}

export function ImageFace({ file }: { file: OutcomeFile }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  return (
    <div className="face face-image" ref={ref}>
      {seen && <img src={contentUrl(file)} alt={file.name} loading="lazy" />}
    </div>
  );
}

export function FileFace({ files }: { files: readonly OutcomeFile[] }) {
  return (
    <div className="face face-paper face-files">
      {files.slice(0, 4).map((file) => {
        const kind = kindOf(file.name, file.mimeType);
        return (
          <span key={file.id} className="face-file">
            <kind.icon aria-hidden="true" />
            <span className="face-file-text">
              <b>{file.name}</b>
              <small>
                {kind.label} · {sizeText(file.sizeBytes)}
              </small>
            </span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * Work still under way, drawn as the thing it is becoming: a page filling with lines, a site
 * frame laying out, bars rising. Above it, in one line, what it is doing now.
 */
export function WorkingFace({
  task,
  moves,
  form,
  doing,
  live
}: {
  task: Task;
  moves: readonly OwnerMove[];
  form: Form;
  doing?: string | undefined;
  live?: string | null | undefined;
}) {
  const grown = leaves(task);
  const line = doing ? doingText(doing) : goalLine(task, moves);
  return (
    <div className={`face face-working is-${form}`}>
      <div className="assemble" aria-hidden="true">
        {form === 'site' ? (
          <div className="assemble-site">
            <b />
            <span />
            <span />
            <span />
            <span />
          </div>
        ) : form === 'data' ? (
          <div className="assemble-bars">
            {[0.4, 0.7, 0.3, 0.9, 0.55, 0.8, 0.45].map((height, index) => (
              <i key={index} style={{ '--h': height, '--i': index } as React.CSSProperties} />
            ))}
          </div>
        ) : form === 'image' ? (
          <div className="assemble-image" />
        ) : (
          <div className="assemble-lines">
            {Array.from({ length: form === 'document' ? 9 : 4 }, (_, index) => (
              <i key={index} style={{ '--i': index } as React.CSSProperties} />
            ))}
          </div>
        )}
      </div>
      {live ? <p className="working-live">{plain(live).slice(-260)}</p> : null}
      <div className="working-now">
        <span className="working-dot" aria-hidden="true" />
        <span className="working-line">{line}</span>
      </div>
      {grown.total > 1 && (
        <span className="working-pips" aria-label={`${grown.done} of ${grown.total} steps done`}>
          {Array.from({ length: grown.total }, (_, index) => (
            <i
              key={index}
              className={index < grown.done ? 'is-done' : index === grown.done ? 'is-now' : ''}
            />
          ))}
        </span>
      )}
    </div>
  );
}

/** Something only the owner can settle, answerable on the card itself. */
export function DecisionFace({ move, onDone }: { move: OwnerMove; onDone: () => void }) {
  return (
    <div className="face face-decision">
      <MoveCard move={move} top onDone={onDone} />
    </div>
  );
}

/** Any one file, drawn as what it is: the face the desk would give the result it belongs to. */
export function MadeFace({ file }: { file: OutcomeFile }) {
  const kind = kindOf(file.name, file.mimeType).id;
  const page =
    /\.html?$/i.test(file.name) ||
    file.mimeType === 'text/html' ||
    (kind === 'other' &&
      file.mimeType === 'application/octet-stream' &&
      !/\.[a-z0-9]{1,5}$/i.test(file.name));
  if (page) return <SiteFace file={file} label={file.name} outcome={undefined} />;
  if (kind === 'doc') return <PageFace file={file} title={file.name} answer={null} />;
  if (kind === 'data' && /\.(csv|tsv)$|csv|tab-separated/i.test(file.name + file.mimeType))
    return <DataFace file={file} />;
  if (kind === 'image') return <ImageFace file={file} />;
  return <FileFace files={[file]} />;
}
