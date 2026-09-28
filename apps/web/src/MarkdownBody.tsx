import { lazy, Suspense } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import {
  resolveArtifactReference,
  type ArtifactReference
} from '@garden/contracts/artifact-reference';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
const Syntax = lazy(() => import('./Syntax'));

export default function Markdown({
  children,
  artifacts = [],
  onArtifact,
  imageSources
}: {
  children: string;
  artifacts?: readonly ArtifactReference[];
  onArtifact?: (id: string) => void;
  imageSources?: ReadonlyMap<string, string>;
}) {
  const artifactUrl = (id: string) => `/v1/artifacts/${encodeURIComponent(id)}/content`;
  return (
    <div className="markdown">
      <ReactMarkdown
        urlTransform={(url, key) => {
          if (key === 'src' && imageSources) return imageSources.get(url) ?? '';
          if (key === 'href' && url.startsWith('artifact:')) {
            const artifact = resolveArtifactReference(url, artifacts);
            return artifact ? artifactUrl(artifact.id) : '';
          }
          return defaultUrlTransform(url);
        }}
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          code: ({ node: _node, children, className, ...props }) => {
            const language = /language-([\w+-]+)/.exec(className ?? '')?.[1];
            const code = (typeof children === 'string' ? children : '').replace(/\n$/, '');
            return language ? (
              <Suspense
                fallback={
                  <code {...props} className={className}>
                    {children}
                  </code>
                }
              >
                <Syntax code={code} language={language} />
              </Suspense>
            ) : (
              <code {...props} className={className}>
                {children}
              </code>
            );
          },
          a: ({ node: _node, children, href, ...props }) => {
            if (!href) return <span title="Link unavailable">{children}</span>;
            const artifact = artifacts.find((item) => artifactUrl(item.id) === href);
            return (
              <a
                {...props}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => {
                  if (
                    !artifact ||
                    !onArtifact ||
                    event.ctrlKey ||
                    event.metaKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  onArtifact(artifact.id);
                }}
              >
                {children}
              </a>
            );
          },
          img: ({ node: _node, src, alt, ...props }) =>
            src &&
            (imageSources
              ? true
              : (src.startsWith('/') && !src.startsWith('//')) || src.startsWith('blob:')) ? (
              <img {...props} src={src} alt={alt ?? ''} loading="lazy" />
            ) : src ? (
              <a href={src} target="_blank" rel="noopener noreferrer">
                {alt || 'Open image'}
              </a>
            ) : (
              <span className="muted">{alt || 'Image'} (image unavailable in this preview)</span>
            )
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
