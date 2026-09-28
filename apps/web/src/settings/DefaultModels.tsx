import { useEffect, useState } from 'react';
import type { ProjectModelChoices, ProjectModelPreferences } from '@garden/contracts';
import { put } from '../client.js';
import { Button } from '../ui.js';
import { ActionFeedback, ResourceState, useAction, useResource } from '../management.js';
import ModelChoiceFields, { automaticChoice, textPurposes } from '../ModelChoiceFields.js';

export default function DefaultModels({
  onChange,
  connectionRevision
}: {
  onChange: () => void;
  connectionRevision: number;
}) {
  const resource = useResource<ProjectModelPreferences>('/v1/workspace-model-preferences');
  const { refresh } = resource;
  useEffect(() => {
    if (connectionRevision) refresh();
  }, [connectionRevision, refresh]);
  const [draft, setDraft] = useState<ProjectModelChoices | null>(null);
  const action = useAction();
  const decisionAction = useAction();
  const [lastReceived, setLastReceived] = useState<ProjectModelPreferences | null>(null);
  useEffect(() => {
    if (resource.value) setLastReceived(resource.value);
  }, [resource.value]);
  // Keep controls and disclosure focus mounted while saved preferences refresh.
  const current = resource.value ?? lastReceived;
  const choices = draft ?? current?.choices ?? {};
  const dirty = current && JSON.stringify(choices) !== JSON.stringify(current.choices);
  return (
    <div className="stack">
      <ResourceState resource={resource} />
      {current && (
        <>
          <ModelChoiceFields
            purposes={current.purposes.filter((item) =>
              textPurposes.some((purpose) => purpose === item.purpose)
            )}
            choices={choices}
            onChange={setDraft}
            disabled={action.busy}
            inherit={false}
          />
          <details className="settings-disclosure">
            <summary>Decision model preference</summary>{' '}
            <div className="stack">
              <label className="management-check">
                <input
                  type="checkbox"
                  checked={current.decisionModelsEnabled !== false}
                  disabled={decisionAction.busy}
                  aria-describedby="decision-models-hint"
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    void decisionAction.run(
                      async () => {
                        await put('/v1/account/preferences', { decisionModelsEnabled: enabled });
                        resource.refresh();
                        onChange();
                      },
                      enabled ? 'Decision models allowed' : 'Decision models disabled'
                    );
                  }}
                />
                Allow decision models
              </label>
              <p className="muted" id="decision-models-hint">
                Allow decision models in workflows with a verified benefit. Garden works fully
                without a decision model.
              </p>
              <ActionFeedback action={decisionAction} />
            </div>
          </details>{' '}
          <div className="model-choice-actions">
            <Button
              className="primary"
              busy={action.busy}
              disabled={!dirty}
              onClick={() => {
                void action.run(async () => {
                  await put('/v1/account/preferences', {
                    model: choices.main ?? automaticChoice,
                    modelPurposes: Object.fromEntries(
                      textPurposes
                        .filter((purpose) => purpose !== 'main')
                        .map((purpose) => [purpose, choices[purpose] ?? automaticChoice])
                    )
                  });
                  resource.refresh();
                  setDraft(null);
                  onChange();
                }, 'Model defaults saved');
              }}
            >
              Save model defaults
            </Button>
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
          </div>
        </>
      )}
      <ActionFeedback action={action} />
    </div>
  );
}
