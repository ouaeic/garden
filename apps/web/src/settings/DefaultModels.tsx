import { useState } from 'react';
import type { ProjectModelChoices, ProjectModelPreferences } from '@athanor/contracts';
import { put } from '../client.js';
import { Button } from '../ui.js';
import { ActionFeedback, ResourceState, useAction, useResource } from '../management.js';
import ModelChoiceFields, { automaticChoice, textPurposes } from '../ModelChoiceFields.js';

export default function DefaultModels({ onChange }: { onChange: () => void }) {
  const resource = useResource<ProjectModelPreferences>('/v1/workspace-model-preferences');
  const [draft, setDraft] = useState<ProjectModelChoices | null>(null);
  const action = useAction();
  const decisionAction = useAction();
  const current = resource.value;
  const choices = draft ?? current?.choices ?? {};
  const dirty = current && JSON.stringify(choices) !== JSON.stringify(current.choices);
  return (
    <div className="stack">
      <ResourceState resource={resource} />
      {current && (
        <>
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
                    enabled ? 'Decision models turned on' : 'Decision models turned off'
                  );
                }}
              />
              Use decision models
            </label>
            <p className="muted" id="decision-models-hint">
              Let a fast model help with focused choices. Turning this off removes decision tools
              and their instructions from future model steps across all projects. Calls already
              underway may finish. Turning it on applies from the next turn.
            </p>
            <ActionFeedback action={decisionAction} />
          </div>
          <ModelChoiceFields
            purposes={current.purposes.filter((item) =>
              textPurposes.some((purpose) => purpose === item.purpose)
            )}
            choices={choices}
            onChange={setDraft}
            disabled={action.busy}
            inherit={false}
          />
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
