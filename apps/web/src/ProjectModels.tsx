import { useRef, useState } from 'react';
import type { ProjectModelChoices, ProjectModelPreferences } from '@garden/contracts';
import { put } from './client.js';
import { ActionFeedback, ResourceState, useAction, useResource } from './management.js';
import { Button } from './ui.js';
import ModelChoiceFields from './ModelChoiceFields.js';
import ModelRoleChoices from './ModelRoleChoices.js';

export default function ProjectModels({
  taskId,
  projectId,
  onChange,
  disabled,
  compact = false
}: {
  taskId?: string;
  projectId?: string;
  onChange?: (choices: ProjectModelChoices, previous: ProjectModelChoices) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const scopeId = projectId ?? taskId!;
  const endpoint = projectId
    ? `/v1/projects/${projectId}/model-preferences`
    : `/v1/tasks/${taskId}/model-preferences`;
  const resource = useResource<ProjectModelPreferences>(endpoint);
  const [draft, setDraft] = useState<{
    taskId: string;
    revision: number;
    choices: ProjectModelChoices;
  } | null>(null);
  const action = useAction();
  const operation = useRef<{ signature: string; key: string } | null>(null);
  const current = resource.value;
  const editing = draft?.taskId === scopeId ? draft : null;
  const choices = editing?.choices ?? current?.choices ?? {};
  const dirty = current && JSON.stringify(choices) !== JSON.stringify(current.choices);
  const save = (next = choices) => {
    if (!current) return;
    const payload = { expectedRevision: editing?.revision ?? current.revision, choices: next };
    const signature = JSON.stringify([scopeId, payload]);
    if (operation.current?.signature !== signature)
      operation.current = { signature, key: crypto.randomUUID() };
    const idempotencyKey = operation.current.key;
    void action.run(
      async () => {
        const saved = await put<ProjectModelPreferences>(endpoint, payload, { idempotencyKey });
        resource.setValue(saved);
        setDraft(null);
        window.dispatchEvent(new CustomEvent('garden-model-preferences', { detail: saved }));
        onChange?.(saved.choices, current.choices);
      },
      projectId ? 'Project model choices saved' : 'Conversation model choices saved'
    );
  };
  const changeChoices = (next: ProjectModelChoices) => {
    if (!current) return;
    setDraft({ taskId: scopeId, revision: editing?.revision ?? current.revision, choices: next });
  };
  return (
    <section
      className={compact ? 'prompt-models' : 'stack'}
      aria-label={projectId ? 'Project models' : 'Conversation models'}
    >
      {!compact && (
        <p className="muted">
          {projectId
            ? 'Project defaults apply to conversations that follow them. Each purpose can follow your Settings or use its own model.'
            : 'These choices apply to this conversation from its next turn. Each purpose can follow the project default or use its own model.'}
        </p>
      )}
      <ResourceState resource={resource} />
      {current && (
        <>
          {compact ? (
            <ModelRoleChoices
              purposes={current.purposes}
              choices={choices}
              disabled={disabled || action.busy}
              inheritLabel="Use project default"
              scope="These choices apply to this conversation from its next turn. Other conversations keep their own choices."
              onChange={changeChoices}
            />
          ) : (
            <ModelChoiceFields
              purposes={current.purposes}
              inheritLabel={projectId ? 'Use global choice' : 'Use project choice'}
              inheritDetail={
                projectId
                  ? 'Follow your defaults in Settings.'
                  : 'Follow the defaults in project settings.'
              }
              choices={choices}
              disabled={disabled || action.busy}
              onChange={changeChoices}
            />
          )}
          <div
            className={
              compact ? 'prompt-model-footer model-choice-actions' : 'model-choice-actions'
            }
          >
            <Button
              className="primary"
              busy={action.busy}
              disabled={disabled || !dirty}
              onClick={() => save()}
            >
              {projectId ? 'Save project choices' : 'Save conversation choices'}
            </Button>
            {!projectId && Object.keys(current.choices).length > 0 && (
              <Button disabled={disabled || action.busy} onClick={() => save({})}>
                Use project defaults
              </Button>
            )}
            {dirty && (
              <Button disabled={action.busy} onClick={() => setDraft(null)}>
                Discard changes
              </Button>
            )}
            {dirty && (
              <small className="muted" role="status">
                Unsaved changes
              </small>
            )}
            {action.error != null && (
              <Button
                disabled={action.busy}
                onClick={() => {
                  setDraft(null);
                  resource.refresh();
                }}
              >
                Reload saved choices
              </Button>
            )}
          </div>
        </>
      )}
      <ActionFeedback action={action} />
    </section>
  );
}
