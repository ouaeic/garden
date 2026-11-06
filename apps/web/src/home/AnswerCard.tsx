import { lazy, Suspense } from 'react';
import type { OwnerMove, Task } from '@garden/contracts';
import { answerIsStreaming, surfaceAnswer } from '../model';
import { ago, goalLine, growth, money } from '../app/derive';
import { Close, External } from '../app/icons';
import { openDeal, openGoal } from '../app/route';
import { dismissAsked } from './recent';
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
  const status = task?.status ?? 'queued';
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
  const thinking = !answer.markdown && !deal && !move && !finished && state === 'working';
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
            onClick={() => dismissAsked(taskId)}
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
          <p className="muted">{task ? goalLine(task, moves) : 'Starting…'}</p>
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
        {task?.completedAt && <span>{ago(task.completedAt)}</span>}
        {task && !finished && !deal && (
          <button type="button" className="link" onClick={() => openGoal(taskId)}>
            Watch it work
          </button>
        )}
        {finished && (
          <button type="button" className="link" onClick={() => openGoal(taskId)}>
            Follow up
          </button>
        )}
      </footer>
    </article>
  );
}
