import { applyTheme } from './appearance';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { ShareSnapshot } from '@garden/contracts';
import { loadShare, loadShareArtifact } from './share-crypto.js';
import type { OpenedShare } from './share-crypto.js';
import { shareArtifactDocument } from './share-html.js';
import './share.css';
import Wordmark from './app/Wordmark';

const friendlyDate = (value: string) =>
  new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
const fileSize = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function Markdown({ text }: { text: string }) {
  return (
    <div className="shared-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { output: 'mathml', strict: 'ignore' }]]}
        skipHtml
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ src, alt }) =>
            typeof src === 'string' && src ? (
              <a href={src} target="_blank" rel="noopener noreferrer">
                {alt || 'Open referenced image'} ↗
              </a>
            ) : (
              <span>{alt || 'Referenced image'}</span>
            )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function SharedMedia({ url, name, audio }: { url: string; name: string; audio: boolean }) {
  return audio ? (
    // eslint-disable-next-line jsx-a11y/media-has-caption -- A shared artifact has no caption-file metadata to attach.
    <audio controls src={url} aria-label={name} />
  ) : (
    // eslint-disable-next-line jsx-a11y/media-has-caption -- A shared artifact has no caption-file metadata to attach.
    <video controls src={url} aria-label={name} />
  );
}

function SharedFile({
  opened,
  file
}: {
  opened: OpenedShare;
  file: ShareSnapshot['artifacts'][number];
}) {
  const [content, setContent] = useState<{
    url: string;
    text: string | null;
    html: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(false);
  useEffect(
    () => () => {
      if (content) URL.revokeObjectURL(content.url);
    },
    [content]
  );
  const open = async () => {
    if (content) {
      setPreview(!preview);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const bytes = await loadShareArtifact(opened, file.n);
      const type = file.mimeType.toLowerCase().split(';')[0] ?? 'application/octet-stream';
      const isText =
        (type.startsWith('text/') || /json|javascript|xml/.test(type)) && type !== 'text/html';
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      setContent({
        url,
        text: isText ? new TextDecoder().decode(bytes) : null,
        html: type === 'text/html' ? new TextDecoder().decode(bytes) : null
      });
      setPreview(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This file could not be opened.');
    } finally {
      setLoading(false);
    }
  };
  const name = file.name.split(/[\\/]/).at(-1) || 'shared-file';
  return (
    <article className="shared-file">
      <div className="shared-file-row">
        <div>
          <h3>{name}</h3>
          <p>{fileSize(file.sizeBytes)}</p>
        </div>
        <div className="shared-file-actions">
          <button type="button" onClick={() => void open()} disabled={loading}>
            {loading ? 'Opening…' : content && preview ? 'Close preview' : 'Open file'}
          </button>
          {content && (
            <a href={content.url} download={name}>
              Download
            </a>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="shared-error">
          {error}
        </p>
      )}
      {content && preview && (
        <div className="shared-file-preview">
          {content.text !== null ? (
            <pre>{content.text}</pre>
          ) : file.mimeType.startsWith('image/') ? (
            <img src={content.url} alt={name} />
          ) : file.mimeType.startsWith('audio/') ? (
            <SharedMedia url={content.url} name={name} audio />
          ) : file.mimeType.startsWith('video/') ? (
            <SharedMedia url={content.url} name={name} audio={false} />
          ) : content.html !== null ? (
            <iframe
              srcDoc={shareArtifactDocument(content.html)}
              title={name}
              sandbox=""
              referrerPolicy="no-referrer"
            />
          ) : /application\/pdf/.test(file.mimeType) ? (
            <iframe src={content.url} title={name} sandbox="" referrerPolicy="no-referrer" />
          ) : (
            <p>
              This file is ready to{' '}
              <a href={content.url} download={name}>
                download
              </a>
              .
            </p>
          )}
        </div>
      )}
    </article>
  );
}

function ShareViewer() {
  const [opened, setOpened] = useState<OpenedShare | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void loadShare(window.location.pathname, window.location.hash, controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setOpened(value);
      },
      (cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'This link could not be opened.');
      }
    );
    return () => controller.abort();
  }, [attempt]);
  const snapshot = opened?.snapshot;
  const result = snapshot
    ? [...snapshot.events].reverse().find((event) => event.kind === 'assistant_message')
    : undefined;
  const brief = snapshot?.events.find((event) => event.kind === 'user_message');
  return (
    <div className="share-page">
      <header className="share-masthead">
        <a className="share-wordmark" href="/" aria-label="garden">
          <Wordmark />
        </a>
        <span>Shared work</span>
      </header>
      {!snapshot ? (
        <main className="share-state" aria-live="polite">
          <span className="share-orbit" aria-hidden="true" />
          <h1>{error ? 'This link could not be opened' : 'Opening a shared work'}</h1>
          <p>{error || 'Decrypting the snapshot in your browser.'}</p>
          {error && (
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              Try again
            </button>
          )}
        </main>
      ) : (
        <main>
          <div className="share-heading">
            <p className="share-eyebrow">A saved snapshot · {friendlyDate(snapshot.createdAt)}</p>
            <h1>{snapshot.title}</h1>
          </div>
          {brief && (
            <details className="share-brief">
              <summary>The brief</summary>
              <Markdown text={brief.text} />
            </details>
          )}
          <section className="share-result" aria-label="Shared result">
            {result ? (
              <Markdown text={result.text} />
            ) : (
              <p>The owner shared a work in progress. Its record is below.</p>
            )}
          </section>
          {opened && snapshot.artifacts.length > 0 && (
            <section className="share-files" aria-labelledby="shared-files">
              <h2 id="shared-files">Files to take with you</h2>
              {snapshot.artifacts.map((file) => (
                <SharedFile key={file.n} opened={opened} file={file} />
              ))}
            </section>
          )}
          <details className="share-record">
            <summary>
              Read the working record <span>{snapshot.events.length} entries</span>
            </summary>
            <div>
              {snapshot.events.map((event, index) => (
                <article className={`shared-event shared-event-${event.kind}`} key={index}>
                  <p className="shared-event-label">
                    {event.kind.replace(/_/g, ' ')}{' '}
                    <time dateTime={event.at}>
                      {new Date(event.at).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </time>
                  </p>
                  <Markdown text={event.text} />
                </article>
              ))}
            </div>
          </details>
        </main>
      )}
      <footer className="share-footer">
        <span>A moment of work, shared with you.</span>
        <span>Read only · Decrypted on this device</span>
      </footer>
    </div>
  );
}

applyTheme();
const root = document.getElementById('root');
if (root) createRoot(root).render(<ShareViewer />);
