import { useId, useState } from 'react';
import { ShieldCheck, ArrowUpRight } from './icons';
import type { Task } from '@garden/contracts';
import type { Decision } from './model';
import { data, text, date } from './model';
import { post, ApiError } from './client';
import { stepUp } from './auth';
import { Button, ErrorNotice } from './ui';
import {
  APPROVAL_NOTE_MAX_CHARS,
  approvalIntroduction,
  approvalToolPhrases
} from './approval-copy';
export function DecisionCard({
  decision,
  onResolved,
  taskTitle,
  onOpenTask,
  onComputer
}: {
  decision: Decision;
  onResolved: () => void;
  taskTitle?: string;
  onOpenTask?: (id: string) => void;
  onComputer?: (tool: 'browser' | 'desktop') => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState('');
  const noteHintId = useId();
  const preview = data(decision.preview);
  const args = data(preview.arguments ?? preview.args ?? preview.input);
  const tool = text(preview.tool, text(preview.toolName, text(preview.name)));
  const command = text(preview.command, text(args.command));
  const description = text(
    preview.reason,
    text(
      preview.description,
      text(preview.explanation, text(preview.summary, text(preview.preview)))
    )
  );
  const introduction = approvalIntroduction(tool, decision.action, description);
  const addresses = Array.isArray(preview.addresses)
    ? preview.addresses.filter((value): value is string => typeof value === 'string')
    : [];
  const grantDescription = text(data(preview.taskGrant).description);
  const privateInput =
    Boolean(data(preview.handoff).kind) ||
    ['secure_input', 'type_secure'].includes(text(args.action)) ||
    decision.action === 'secure_input_handoff' ||
    /^Secure (browser|desktop) input required$/.test(decision.action);
  const expired = Date.parse(decision.expiresAt) <= Date.now();
  async function resolve(action: 'approve' | 'deny', scope: 'once' | 'conversation' = 'once') {
    const body =
      action === 'deny' && note.trim()
        ? { note: note.trim() }
        : action === 'approve' && scope === 'conversation'
          ? { scope }
          : {};
    setBusy(true);
    setError(null);
    try {
      try {
        await post(`/v1/approvals/${decision.id}/${action}`, body);
      } catch (err) {
        if (
          !(err instanceof ApiError) ||
          !['step_up_required', 'recent_authentication_required'].includes(err.code)
        )
          throw err;
        await stepUp();
        await post(`/v1/approvals/${decision.id}/${action}`, body);
      }
      onResolved();
    } catch (err) {
      setError(err);
      if (err instanceof ApiError && err.code === 'approval_unavailable') onResolved();
    } finally {
      setBusy(false);
    }
  }
  if (privateInput)
    return (
      <article className="decision-card computer-handoff text-box">
        <div className="eyebrow">Needs you · personal action</div>
        <h3>{decision.action}</h3>
        <p>
          {data(preview.handoff).kind === 'signature'
            ? 'Review and sign the document yourself, then continue from the computer.'
            : 'Enter the private value in the computer, then continue there. It will not be put into the conversation.'}
        </p>
        {onComputer ? (
          <Button
            className="primary"
            onClick={() => onComputer(tool === 'desktop_action' ? 'desktop' : 'browser')}
          >
            Open {tool === 'desktop_action' ? 'desktop' : 'browser'}
          </Button>
        ) : (
          onOpenTask && (
            <Button onClick={() => onOpenTask(decision.taskId)}>Open conversation</Button>
          )
        )}
        <Button disabled={busy || expired} onClick={() => resolve('deny')}>
          Cancel request
        </Button>
        <ErrorNotice error={error} />
      </article>
    );
  // What to decide comes first and the decision straight after it; the detail behind it, and a
  // reason for denying, stay folded below so the card never pushes its own buttons out of view.
  return (
    <article className="decision-card text-box">
      <div className="eyebrow">
        <ShieldCheck size={14} aria-hidden="true" />
        {preview.securityMode === 'autonomous' ? 'Autonomous · needs approval' : 'Your approval'}
      </div>
      {taskTitle && onOpenTask && (
        <button className="text-button" onClick={() => onOpenTask(decision.taskId)}>
          {taskTitle}
          <ArrowUpRight size={14} />
        </button>
      )}
      <h3>{decision.action === tool ? (approvalToolPhrases[tool] ?? tool) : decision.action}</h3>
      {introduction && <p>{introduction}</p>}
      {addresses.length > 0 && (
        <p className="decision-addresses">
          <span>Reaches</span> {addresses.join(', ')}
        </p>
      )}
      <div className="row decision-actions">
        <Button
          className="primary"
          busy={busy}
          disabled={expired}
          onClick={() => resolve('approve')}
        >
          {expired ? 'Expired' : 'Approve once'}
        </Button>
        {grantDescription && (
          <Button disabled={busy || expired} onClick={() => resolve('approve', 'conversation')}>
            Allow in this conversation
          </Button>
        )}
        <Button disabled={busy || expired} onClick={() => resolve('deny')}>
          Deny
        </Button>
      </div>
      {grantDescription && (
        <div className="decision-permission">
          <strong>In this conversation</strong>
          <p>{grantDescription}</p>
          <small>
            Ends if you stop the conversation or change its approvals. Revoke in Work options.
          </small>
        </div>
      )}
      <ErrorNotice error={error} />
      <details className="decision-detail">
        <summary>Inspect full action</summary>
        {decision.origin && <p>Content read before this action: {decision.origin}</p>}
        <p>Effect: {decision.sideEffect.replaceAll('_', ' ')}</p>
        <p>Expires: {date(decision.expiresAt)}</p>
        {command && (
          <pre className="command-preview">
            <code>{command}</code>
          </pre>
        )}
        <pre>
          {typeof decision.preview === 'string'
            ? decision.preview
            : JSON.stringify(decision.preview, null, 2)}
        </pre>
      </details>
      <details className="decision-note">
        <summary>Add a reason for denying</summary>
        <label className="field">
          <span className="sr-only">Reason for denying (optional)</span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={APPROVAL_NOTE_MAX_CHARS}
            rows={2}
            disabled={busy || expired}
            aria-describedby={noteHintId}
            placeholder="What should change before the agent continues."
          />
        </label>
        <small id={noteHintId}>
          Sent with Deny. {note.length}/{APPROVAL_NOTE_MAX_CHARS}
        </small>
      </details>
    </article>
  );
}
export default function DecisionQueue({
  decisions,
  tasks,
  onResolved,
  onOpenTask
}: {
  decisions: Decision[];
  tasks: Task[];
  onResolved: () => void;
  onOpenTask: (id: string) => void;
}) {
  return (
    <section className="decision-grid">
      {decisions.map((decision) => (
        <DecisionCard
          key={decision.id}
          decision={decision}
          taskTitle={tasks.find((task) => task.id === decision.taskId)?.title ?? 'Open work'}
          onResolved={onResolved}
          onOpenTask={onOpenTask}
        />
      ))}
    </section>
  );
}
