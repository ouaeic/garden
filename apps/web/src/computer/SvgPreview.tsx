import { useEffect, useState } from 'react';
import { readBoundedText } from '../bounded-response';
import { shareArtifactDocument } from '../share-html';
import { message } from './format';

const SVG_PREVIEW_BYTES = 32 * 1024 * 1024;
const tooLarge = 'This SVG is too large to preview here. Download the original to open it.';

export default function SvgPreview({
  url,
  name,
  bytes
}: {
  url: string;
  name: string;
  bytes: number;
}) {
  const [document, setDocument] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setDocument(null);
    setError('');
    if (bytes > SVG_PREVIEW_BYTES) return;
    const controller = new AbortController();
    void fetch(url, { credentials: 'include', signal: controller.signal })
      .then((response) =>
        readBoundedText(response, SVG_PREVIEW_BYTES, {
          tooLarge,
          empty: 'The SVG response was empty.'
        })
      )
      .then((source) => {
        if (controller.signal.aborted) return;
        const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
        if (
          parsed.querySelector('parsererror') ||
          parsed.documentElement.localName !== 'svg' ||
          parsed.documentElement.namespaceURI !== 'http://www.w3.org/2000/svg'
        )
          throw new Error('This SVG could not be displayed. Download the original to inspect it.');
        // Image mode disables SVG scripts and external references; the enclosing frame is opaque.
        setDocument(
          shareArtifactDocument(
            '<style>html,body{margin:0;width:100%;height:100%;background:white}' +
              'img{display:block;width:100%;height:100%;object-fit:contain}</style>' +
              `<img alt="SVG image" src="data:image/svg+xml,${encodeURIComponent(source)}">`
          )
        );
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(message(cause));
      });
    return () => controller.abort();
  }, [url, bytes]);
  if (bytes > SVG_PREVIEW_BYTES) return <p className="muted">{tooLarge}</p>;
  if (error)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  return document === null ? (
    <p className="muted" role="status">
      Opening image…
    </p>
  ) : (
    <iframe
      className="computer-preview"
      srcDoc={document}
      title={name}
      sandbox=""
      referrerPolicy="no-referrer"
    />
  );
}
