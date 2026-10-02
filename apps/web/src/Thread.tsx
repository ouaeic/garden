import { lazy, Suspense } from 'react';
import type { Artifact, TaskEvent } from '@garden/contracts';
import { data, date, eventText, text } from './model';
import MessageAttachmentList from './MessageAttachmentList';
const Markdown = lazy(() => import('./MarkdownBody'));

export interface Exchange {
  readonly direction: TaskEvent;
  readonly answer?: string;
}

/**
 * The conversation as exchanges: each thing the owner said and the last answer that followed it.
 * Read from the loaded events rather than fetched separately, so it is exactly what the turn saw.
 */
export const exchangesOf = (events: readonly TaskEvent[]): Exchange[] => {
  const exchanges: Array<{ direction: TaskEvent; answer?: string }> = [];
  for (const event of events) {
    if (event.kind === 'user_message' || event.kind === 'queued_message')
      exchanges.push({ direction: event });
    else if (event.kind === 'assistant_message' && exchanges.length)
      exchanges[exchanges.length - 1]!.answer = eventText(event);
    else if (event.kind === 'completed' && exchanges.length) {
      const answer = text(data(event.payload).answer);
      if (answer) exchanges[exchanges.length - 1]!.answer = answer;
    }
  }
  return exchanges;
};

const firstLine = (value: string, limit = 120): string => {
  const line =
    value
      .replace(/[#*_`>]/g, '')
      .trim()
      .split('\n')[0] ?? '';
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
};

/** What the owner asked, one line, opening to the whole of it. */
export function OwnerLine({
  event,
  workspaceId,
  artifacts
}: {
  event: TaskEvent;
  workspaceId: string;
  artifacts: Artifact[];
}) {
  const body = eventText(event);
  const long = body.length > 140 || body.includes('\n');
  const attachments = data(event.payload).attachments;
  const label = event.kind === 'queued_message' ? 'You · queued' : 'You';
  if (!long && !Array.isArray(attachments))
    return (
      <p className="owner-line">
        <span className="eyebrow">{label}</span>
        <span>{body}</span>
      </p>
    );
  return (
    <details className="owner-line">
      <summary>
        <span className="eyebrow">{label}</span>
        <span>{firstLine(body)}</span>
      </summary>
      <Suspense fallback={<p>{body}</p>}>
        <Markdown artifacts={artifacts}>{body}</Markdown>
      </Suspense>
      <MessageAttachmentList workspaceId={workspaceId} paths={attachments} />
    </details>
  );
}

/** Earlier exchanges, one line each, opening in place. */
export default function Thread({
  exchanges,
  workspaceId,
  artifacts
}: {
  exchanges: readonly Exchange[];
  workspaceId: string;
  artifacts: Artifact[];
}) {
  if (!exchanges.length) return null;
  return (
    <ol className="thread" aria-label="Earlier in this conversation">
      {exchanges.map(({ direction, answer }) => (
        <li key={direction.id}>
          <details>
            <summary>
              <span className="eyebrow">You</span>
              <span className="thread-ask">{firstLine(eventText(direction), 90)}</span>
              {answer && <span className="thread-answer">{firstLine(answer, 90)}</span>}
              <time>{date(direction.createdAt)}</time>
            </summary>
            <div className="thread-body">
              <Suspense fallback={<p>{eventText(direction)}</p>}>
                <div className="thread-direction">
                  <Markdown artifacts={artifacts}>{eventText(direction)}</Markdown>
                  <MessageAttachmentList
                    workspaceId={workspaceId}
                    paths={data(direction.payload).attachments}
                  />
                </div>
                {answer && (
                  <div className="thread-reply">
                    <Markdown artifacts={artifacts} imageMode="links">
                      {answer}
                    </Markdown>
                  </div>
                )}
              </Suspense>
            </div>
          </details>
        </li>
      ))}
    </ol>
  );
}
