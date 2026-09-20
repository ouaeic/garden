import { lazy, Suspense, useEffect, useState } from 'react';
import type { Artifact } from '@athanor/contracts';
import { responseError } from '../client.js';
import { shareArtifactDocument } from '../share-html.js';
import { message, mimeTypeForFile } from './format.js';
import '../computer.css';
const Markdown = lazy(() => import('../MarkdownBody'));
const PdfPreview = lazy(() => import('./PdfPreview'));
const AnalysisJsonPreview = lazy(() => import('./AnalysisJsonPreview'));
const NotebookPreview = lazy(() => import('./NotebookPreview'));
const SvgPreview = lazy(() => import('./SvgPreview'));

export function ResultPreview({
  artifact
}: {
  artifact: Pick<Artifact, 'id' | 'name' | 'mimeType' | 'sizeBytes'>;
}) {
  const url = `/v1/artifacts/${artifact.id}/content`;
  const declaredMime = artifact.mimeType.split(';')[0]!;
  const mime =
    declaredMime === 'application/octet-stream' ? mimeTypeForFile(artifact.name) : declaredMime;
  const plain = (mime.startsWith('text/') && mime !== 'text/html') || mime === 'application/json';
  const notebook = /\.ipynb$/i.test(artifact.name) || mime === 'application/x-ipynb+json';
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setContent(null);
    setError('');
    if (notebook || (!plain && mime !== 'text/html') || artifact.sizeBytes > 262144) return;
    const controller = new AbortController();
    void fetch(url, { credentials: 'include', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw await responseError(response);
        const text = await response.text();
        if (!controller.signal.aborted) setContent(text);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(message(cause));
      });
    return () => controller.abort();
  }, [artifact.sizeBytes, mime, plain, notebook, url]);
  if (notebook)
    return (
      <Suspense fallback={<p className="muted">Opening notebook…</p>}>
        <NotebookPreview key={artifact.id} url={url} name={artifact.name} />
      </Suspense>
    );
  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (mime === 'image/svg+xml')
    return (
      <Suspense fallback={<p className="muted">Opening image…</p>}>
        <SvgPreview key={artifact.id} url={url} name={artifact.name} bytes={artifact.sizeBytes} />
      </Suspense>
    );
  if (mime.startsWith('image/'))
    return (
      <img
        className="computer-result-image"
        src={url}
        alt={artifact.name}
        onError={() =>
          setError('This image could not be displayed. Download it to open the original.')
        }
      />
    );
  if (mime.startsWith('audio/'))
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption -- Owner artifacts do not supply a caption track; transcription must not be invented.
      <audio
        className="computer-result-media"
        controls
        preload="metadata"
        src={url}
        aria-label={artifact.name}
      />
    );
  if (mime.startsWith('video/'))
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption -- Owner artifacts do not supply a caption track; transcription must not be invented.
      <video
        className="computer-result-media"
        controls
        preload="metadata"
        src={url}
        aria-label={artifact.name}
      />
    );
  if (mime === 'text/html' && artifact.sizeBytes <= 262144)
    return content === null ? (
      <p className="muted">Loading preview…</p>
    ) : (
      <iframe
        className="computer-preview"
        srcDoc={shareArtifactDocument(content)}
        title={artifact.name}
        sandbox=""
        referrerPolicy="no-referrer"
      />
    );
  if (mime === 'application/pdf')
    return (
      <Suspense fallback={<p className="muted">Opening document…</p>}>
        <PdfPreview key={artifact.id} url={url} name={artifact.name} />
      </Suspense>
    );
  if (plain && /\.md(?:own)?$/i.test(artifact.name) && artifact.sizeBytes <= 262144)
    return content === null ? (
      <p className="muted">Loading document…</p>
    ) : (
      <Suspense fallback={<p className="muted">Opening document…</p>}>
        <Markdown>{content}</Markdown>
      </Suspense>
    );
  if (mime === 'application/json' && content !== null && artifact.sizeBytes <= 262144)
    return (
      <Suspense fallback={<p className="muted">Opening run record…</p>}>
        <AnalysisJsonPreview key={artifact.id} content={content} />
      </Suspense>
    );
  if (plain && artifact.sizeBytes <= 262144)
    return <pre className="computer-log">{content ?? 'Loading preview…'}</pre>;
  return <p className="muted">Download this result to open its complete contents.</p>;
}
