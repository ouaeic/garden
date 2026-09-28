import type { SubagentLane, TaskEvent } from '@garden/contracts';
import { data } from './model';

/**
 * The delegated specialists behind a task, one card per lane, live as `subagent` events arrive.
 *
 * A `delegate` call used to be two timeline rows minutes apart; this is what "where are the
 * subagents?" is answered with. The fold is by `laneId`, latest status wins, and a terminal row
 * freezes the clock: an elapsed time that keeps ticking on a finished card is the component
 * telling the owner a subagent is still running when it is not.
 */
export default function SubagentLanes({ events }: { events: TaskEvent[] }) {
  const lanes = new Map<string, { lane: SubagentLane; lastEventAt: string }>();
  for (const event of events) {
    if (event.kind !== 'subagent') continue;
    const lane = data(event.payload) as unknown as Partial<SubagentLane>;
    if (typeof lane.laneId !== 'string' || typeof lane.name !== 'string') continue;
    lanes.set(lane.laneId, { lane: lane as SubagentLane, lastEventAt: event.createdAt });
  }
  if (!lanes.size) return null;
  const sorted = [...lanes.values()].sort(
    (left, right) =>
      (terminal(left.lane.status) ? 1 : 0) - (terminal(right.lane.status) ? 1 : 0) ||
      left.lane.name.localeCompare(right.lane.name)
  );
  // Not "working" once they have all stopped: a finished task would have said its specialists were
  // still going, which is the same untruth as a status line reading Complete over an unfinished list.
  const live = sorted.filter((entry) => !terminal(entry.lane.status)).length;
  return (
    <section className="garden-missions" aria-label="Sub-agents">
      <div className="eyebrow">
        {live > 0 ? `Sub-agents working · ${live}` : `Sub-agents · ${sorted.length} finished`}
      </div>
      {sorted.map((entry) => (
        <LaneCard key={entry.lane.laneId} lane={entry.lane} lastEventAt={entry.lastEventAt} />
      ))}
    </section>
  );
}

const terminal = (status: string): boolean =>
  status === 'completed' || status === 'failed' || status === 'verified';

const statusLabel: Record<string, string> = {
  started: 'Started',
  working: 'Working',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
  verified: 'Verified'
};
const laneLabel: Record<string, string> = {
  research: 'Research',
  coding: 'Coding',
  review: 'Review'
};

const elapsed = (ms: unknown): string | null => {
  if (typeof ms !== 'number' || ms < 0) return null;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

function LaneCard({ lane, lastEventAt }: { lane: SubagentLane; lastEventAt: string }) {
  const status = lane.status;
  const done = terminal(status);
  const clock = elapsed(lane.elapsedMs);
  const credits =
    typeof lane.usedCredits === 'number'
      ? `${lane.usedCredits.toLocaleString(undefined, { maximumFractionDigits: 2 })}${
          typeof lane.allocatedCredits === 'number'
            ? ` of ${lane.allocatedCredits.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
            : ''
        } credits`
      : null;
  /*
   * A lane still working, whose report has not landed, has no elapsed figure of its own yet - and a
   * lane card with no time on it is the thing the owner said was missing. The last frame this lane
   * wrote is the honest stand-in: it says the specialist is alive and when it last spoke.
   */
  const heardFrom =
    !done && !clock && lastEventAt
      ? new Date(lastEventAt).toLocaleTimeString(undefined, {
          hour: 'numeric',
          minute: '2-digit'
        })
      : null;
  const body = (
    <>
      {heardFrom && <p className="muted">working · last heard from at {heardFrom}</p>}
      {typeof lane.steps === 'number' && (
        <p className="muted">
          {lane.steps} {lane.steps === 1 ? 'step' : 'steps'}
          {credits ? ` · ${credits}` : ''}
          {clock ? ` · ${clock}` : ''}
        </p>
      )}
      {typeof lane.steps !== 'number' && (credits || clock) && (
        <p className="muted">
          {credits}
          {credits && clock ? ' · ' : ''}
          {clock}
        </p>
      )}
      {typeof lane.verified === 'object' && lane.verified && (
        <p className="muted">
          {lane.verified.held} quotation matches · {lane.verified.checked}{' '}
          {lane.verified.checked === 1 ? 'source checked' : 'sources checked'}
        </p>
      )}
      {lane.citations && (
        <p className="muted">
          {lane.citations.matched} quotation matches · {lane.citations.checked} of{' '}
          {lane.citations.cited} citations checked
        </p>
      )}
      {lane.claimReview && (
        <p className="muted">
          Claim review: {lane.claimReview.supported} supported · {lane.claimReview.contradicted}{' '}
          contradicted ·{' '}
          {Math.max(
            0,
            lane.claimReview.checked - lane.claimReview.supported - lane.claimReview.contradicted
          )}{' '}
          inconclusive
        </p>
      )}
      {typeof lane.detail === 'string' && lane.detail && <p>{lane.detail}</p>}
    </>
  );
  return (
    <article className="garden-mission">
      <div className="row between">
        <strong>
          {lane.name} <span className="badge">{laneLabel[String(lane.lane)] ?? lane.lane}</span>
        </strong>
        <span className="badge">
          {lane.lane === 'research' && status === 'verified'
            ? 'Quotations checked'
            : (statusLabel[status] ?? status)}
        </span>
      </div>
      {done ? (
        <details>
          <summary>Report outcome</summary>
          {body}
        </details>
      ) : (
        body
      )}
    </article>
  );
}
