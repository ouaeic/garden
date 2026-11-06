import { lazy, Suspense, useEffect, useState } from 'react';
import type { OwnerMove, Task, TaskPresentation } from '@garden/contracts';
import { get } from '../client';
import { accept } from '../app/actions';
import { toast } from '../app/toast';
import { answerIsStreaming, surfaceAnswer } from '../model';
import { ago, goalLine, growth, money } from '../app/derive';
import { Close, External, Globe } from '../app/icons';
import { doingText } from '../app/activity';
import { kindOf } from '../app/kinds';
import { openDeal, openGoal } from '../app/route';
import { openArtifact, type Viewed } from '../app/viewer';
import { dismissAsked, focusAsk } from './recent';
import { useAnswerEvents } from './useAnswer';

const Markdown = lazy(() => import('../MarkdownBody'));

/**
 * What the owner just asked, answered in place.
 *
 * A quick question reads as an answer and nothing more. A bigger ask shows the plan it proposes, or
 * what it is doing now, with the goal one click away - the card never pretends a job is a reply.
 */
export default function AnswerCard({
  taskId,
  task,
  moves
}: {
  taskId: string;
  task: Task | undefined;
  moves: readonly OwnerMove[];
}) {
  const events = useAnswerEvents(taskId);
  // The stream says a run ended before the desk's next read does.
  const ended = events.some((event) => event.kind === 'completed');
  const status = ended && task?.status !== 'failed' ? 'completed' : (task?.status ?? 'queued');
  // Read again whenever something new is made, and once more when the run ends.
  const { made, previews } = useMade(
    taskId,
    events.filter((event) => event.kind === 'artifact' || event.kind === 'preview').length +
      (ended ? 1 : 0)
  );
  // What it is doing now, from the newest line the record has for it.
  const doing = [...events]
    .reverse()
    .find(
      (event) =>
        ['tool_started', 'plan', 'notice', 'subagent', 'status', 'assistant_message'].includes(
          event.kind
        ) && event.summary?.trim()
    )?.summary;
  const doingLine = doing ? doingText(doing) : undefined;
  const answer = surfaceAnswer(events);
  const writing = answer.partial && answerIsStreaming(events, status);
  const deal = moves.find(
    (move): move is Extract<OwnerMove, { kind: 'deal' }> =>
      move.kind === 'deal' && move.taskId === taskId
  );
  const move = moves.find((item) => item.taskId === taskId && item.kind !== 'deal');
  const state = task ? growth(task, moves) : 'working';
  const asked =
    (events.find((event) => event.kind === 'user_message')?.payload as { markdown?: string })
      ?.markdown ??
    task?.title ??
    '';
  const finished = status === 'completed';
  const thinking = !answer.markdown && !deal && !move && !finished && state !== 'needs';
  return (
    <article
      className={`answer-card is-${state}${writing ? ' is-writing' : ''}`}
      aria-busy={thinking || writing}
    >
      <header className="answer-card-head">
        <p className="answer-card-ask" title={asked}>
          {asked || 'Your ask'}
        </p>
        <div className="answer-card-tools">
          {task && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Open as a goal"
              title="Open as a goal"
              onClick={() => {
                dismissAsked(taskId);
                openGoal(taskId);
              }}
            >
              <External />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-label="Dismiss"
            onClick={() => {
              dismissAsked(taskId);
              // Reading a finished answer is accepting it; it is filed away, one press from back.
              if (finished && task && !task.archivedAt)
                void accept(taskId).then(
                  () =>
                    toast('Filed away.', {
                      action: { label: 'Undo', run: () => void accept(taskId, false) }
                    }),
                  () => undefined
                );
            }}
          >
            <Close />
          </button>
        </div>
      </header>

      {deal ? (
        <div className="answer-card-deal">
          <p className="answer-card-kicker">A plan to agree before it starts</p>
          <p className="answer-card-summary">{deal.deal.summary}</p>
          <button type="button" className="btn primary" onClick={() => openDeal(taskId)}>
            Review the plan
          </button>
        </div>
      ) : answer.markdown ? (
        <div className="answer-card-body">
          <Suspense fallback={<p className="faint">{answer.markdown.slice(0, 280)}</p>}>
            <Markdown imageMode="links">{answer.markdown}</Markdown>
          </Suspense>
        </div>
      ) : move ? (
        <div className="answer-card-wait">
          <p className="answer-card-kicker">Needs you</p>
          <p>{task ? goalLine(task, moves) : 'Waiting for you'}</p>
          <button type="button" className="btn" onClick={() => openGoal(taskId)}>
            Answer it
          </button>
        </div>
      ) : (
        <div className="answer-card-wait">
          <span className="thinking-line" aria-hidden="true" />
          <p className="muted">{doingLine ?? (task ? goalLine(task, moves) : 'Starting…')}</p>
        </div>
      )}

      {made.length + previews.length > 0 && (
        <div className="answer-card-made" aria-label="What it made">
          {previews.map((preview) => (
            <button
              key={preview.id}
              type="button"
              className="made-chip"
              onClick={() => openGoal(taskId)}
            >
              <Globe aria-hidden="true" />
              <span className="made-chip-name">{preview.title}</span>
              <span className="made-chip-size">Preview</span>
            </button>
          ))}
          {made.map((file) => {
            const kind = kindOf(file.name, file.mimeType);
            return (
              <button
                key={file.id}
                type="button"
                className="made-chip"
                onClick={() => openArtifact(file)}
              >
                <kind.icon aria-hidden="true" />
                <span className="made-chip-name">{file.name}</span>
              </button>
            );
          })}
        </div>
      )}

      <footer className="answer-card-foot">
        <span className={`answer-card-state is-${state}`}>
          {writing
            ? 'Writing'
            : finished
              ? 'Done'
              : deal
                ? 'Waiting for your go-ahead'
                : state === 'needs'
                  ? 'Needs you'
                  : state === 'failed'
                    ? 'Stopped short'
                    : 'Working'}
        </span>
        {task && <span className="num">{money(task.spentUsd)}</span>}
        {!finished && answer.markdown && doingLine && (
          <span className="answer-card-doing">{doingLine}</span>
        )}
        {task?.completedAt && <span>{ago(task.completedAt)}</span>}
        {task && !finished && !deal && (
          <button type="button" className="link" onClick={() => openGoal(taskId)}>
            Watch it work
          </button>
        )}
        {finished && (
          <button
            type="button"
            className="link"
            onClick={() => {
              openGoal(taskId);
              focusAsk();
            }}
          >
            Follow up
          </button>
        )}
      </footer>
    </article>
  );
}

/**
 * The files and previews a goal made, read once it has made one, so they open from the card: a
 * file as itself, a running preview on the goal, where its private link is issued.
 */
function useMade(
  taskId: string,
  changes: number
): { made: Viewed[]; previews: { id: string; title: string }[] } {
  const [found, setFound] = useState<{ made: Viewed[]; previews: { id: string; title: string }[] }>(
    { made: [], previews: [] }
  );
  useEffect(() => {
    if (!changes) return;
    const controller = new AbortController();
    get<TaskPresentation>(`/v1/tasks/${taskId}/presentation`, { signal: controller.signal }).then(
      (presentation) =>
        setFound({
          made: presentation.results.flatMap((result) =>
            result.kind === 'artifact' && result.artifactId
              ? [
                  {
                    id: result.artifactId,
                    name: result.title,
                    mimeType: result.mimeType ?? '',
                    sizeBytes: result.sizeBytes ?? 0,
                    taskId,
                    ...(result.version ? { version: result.version } : {})
                  }
                ]
              : []
          ),
          previews: presentation.results
            .filter((result) => result.kind === 'preview' && result.status === 'ready')
            .map((result) => ({ id: result.id, title: result.title }))
        }),
      () => undefined
    );
    return () => controller.abort();
  }, [taskId, changes]);
  return found;
}
