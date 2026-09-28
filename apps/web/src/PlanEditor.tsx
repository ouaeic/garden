import { useEffect, useState } from 'react';
import { Plus, X } from './icons';
import type { Task, TaskPlan, TaskPlanStep } from '@garden/contracts';
import { get, post } from './client';
import { date } from './model';
import { Button, Empty, ErrorNotice, Field } from './ui';

const STEP_STATUSES = ['pending', 'in_progress', 'completed', 'skipped'] as const;

export default function PlanEditor({
  task,
  plan,
  onSaved
}: {
  task: Task;
  plan: TaskPlan | null;
  onSaved: (plan: TaskPlan) => void;
}) {
  const [steps, setSteps] = useState(plan?.steps ?? []);
  const [name, setName] = useState(plan?.branchName ?? 'Main');
  const [baseVersion, setBaseVersion] = useState(plan?.version ?? 0);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<TaskPlan[]>([]);
  useEffect(() => {
    void get<TaskPlan[]>(`/v1/tasks/${task.id}/plans`).then(setVersions).catch(setError);
  }, [task.id]);
  const editStep = (id: string, patch: Partial<TaskPlanStep>) =>
    setSteps((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  const editSubstep = (stepId: string, subId: string, patch: Partial<TaskPlanStep>) =>
    setSteps((current) =>
      current.map((item) =>
        item.id === stepId
          ? {
              ...item,
              substeps: (item.substeps ?? []).map((sub) =>
                sub.id === subId ? { ...sub, ...patch } : sub
              )
            }
          : item
      )
    );
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result = await post<TaskPlan>(`/v1/tasks/${task.id}/plan`, {
        expectedVersion: baseVersion,
        branchName: name,
        steps
      });
      setBaseVersion(result.version);
      onSaved(result);
      setVersions((current) => [result, ...current]);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      {plan && plan.version !== baseVersion && (
        <div className="management-note" role="status">
          <p>A newer plan is available. Your draft is still based on version {baseVersion}.</p>
          <Button
            disabled={busy}
            onClick={() => {
              setSteps(plan.steps);
              setName(plan.branchName);
              setBaseVersion(plan.version);
              setError(null);
            }}
          >
            Discard draft and load latest plan
          </Button>
        </div>
      )}
      <Field label="Plan name">
        <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
      </Field>
      {steps.map((step, index) => (
        <div className="plan-editor-group" key={step.id}>
          <div className="plan-editor-step">
            <label className="sr-only" htmlFor={`step-${step.id}`}>
              Step {index + 1}
            </label>
            <input
              id={`step-${step.id}`}
              value={step.title}
              maxLength={240}
              onChange={(event) => editStep(step.id, { title: event.target.value })}
            />
            <select
              aria-label={`Step ${index + 1} status`}
              value={step.status}
              onChange={(event) =>
                editStep(step.id, { status: event.target.value as typeof step.status })
              }
            >
              {STEP_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
            <Button
              aria-label={`Remove step ${index + 1}`}
              onClick={() => setSteps((current) => current.filter((item) => item.id !== step.id))}
            >
              <X size={16} />
            </Button>
          </div>
          {/*
           * The parts, editable rather than merely preserved. A milestone the model broke into
           * five is the level the owner actually wants to correct - "no, do the migration before
           * the backfill" is a sentence about a part - and an editor that showed only the headline
           * would leave them re-typing the whole milestone to change one line of it.
           */}
          <ol className="plan-editor-substeps">
            {(step.substeps ?? []).map((sub, subIndex) => (
              <li key={sub.id}>
                <label className="sr-only" htmlFor={`substep-${sub.id}`}>
                  Step {index + 1}, part {subIndex + 1}
                </label>
                <input
                  id={`substep-${sub.id}`}
                  value={sub.title}
                  maxLength={240}
                  onChange={(event) => editSubstep(step.id, sub.id, { title: event.target.value })}
                />
                <select
                  aria-label={`Step ${index + 1}, part ${subIndex + 1} status`}
                  value={sub.status}
                  onChange={(event) =>
                    editSubstep(step.id, sub.id, {
                      status: event.target.value as typeof sub.status
                    })
                  }
                >
                  {STEP_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status.replaceAll('_', ' ')}
                    </option>
                  ))}
                </select>
                <Button
                  aria-label={`Remove step ${index + 1}, part ${subIndex + 1}`}
                  onClick={() =>
                    editStep(step.id, {
                      substeps: (step.substeps ?? []).filter((item) => item.id !== sub.id)
                    })
                  }
                >
                  <X size={14} />
                </Button>
              </li>
            ))}
            <li>
              <Button
                className="text-button"
                disabled={(step.substeps ?? []).length >= 30}
                onClick={() =>
                  editStep(step.id, {
                    substeps: [
                      ...(step.substeps ?? []),
                      { id: crypto.randomUUID(), title: '', status: 'pending' as const }
                    ]
                  })
                }
              >
                <Plus size={13} />
                Add a part
              </Button>
            </li>
          </ol>
        </div>
      ))}
      {!steps.length && (
        <Empty title="No plan yet">You or the agent can set a plan for this work.</Empty>
      )}
      <div className="row">
        <Button
          disabled={steps.length >= 30}
          onClick={() =>
            setSteps((current) => [
              ...current,
              { id: crypto.randomUUID(), title: '', status: 'pending' }
            ])
          }
        >
          <Plus size={15} />
          Add step
        </Button>
        <Button
          className="primary"
          busy={busy}
          disabled={
            !steps.length ||
            steps.some(
              (step) => !step.title.trim() || (step.substeps ?? []).some((sub) => !sub.title.trim())
            )
          }
          onClick={save}
        >
          Save plan
        </Button>
      </div>
      <ErrorNotice error={error} />
      {versions.length > 0 && (
        <details>
          <summary>Earlier plan versions</summary>
          {versions.map((version) => (
            <article key={version.id}>
              <h3>
                {version.branchName} · v{version.version}
              </h3>
              <p className="muted">
                {date(version.createdAt)} · {version.createdBy}
              </p>
              <ol>
                {version.steps.map((step) => (
                  <li key={step.id}>
                    {step.title} · {step.status.replaceAll('_', ' ')}
                  </li>
                ))}
              </ol>
              <Button
                onClick={() => {
                  setSteps(version.steps);
                  setName(version.branchName);
                }}
              >
                Use these steps as a new version
              </Button>
            </article>
          ))}
        </details>
      )}
    </div>
  );
}
