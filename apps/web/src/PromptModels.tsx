import { useEffect, useRef, useState } from 'react';
import type {
  ModelPurpose,
  ProjectModelChoices,
  ProjectModelPreferences,
  PrivacyRoute,
  PurposeModelChoice
} from '@garden/contracts';
import { ArrowLeft, ChevronRight } from './icons';
import { ResourceState, useResource } from './management.js';
import { Button } from './ui.js';
import { purposeDescriptions, purposeLabels } from './ModelChoiceFields.js';
import ModelBrowser from './ModelBrowser.js';
import ProjectModels from './ProjectModels.js';

type Purpose = ProjectModelPreferences['purposes'][number];
const groups: { label: string; purposes: ModelPurpose[] }[] = [
  { label: 'Work', purposes: ['main', 'specialist', 'coding'] },
  { label: 'Media', purposes: ['image', 'audio', 'transcription', 'video'] },
  { label: 'Background tasks', purposes: ['summarise', 'title', 'decisions'] }
];
const preferenceLabels = { balanced: 'Balanced', fast: 'Faster', best: 'Higher quality' };

export default function PromptModelChoices({
  taskId,
  ...props
}: {
  taskId: string;
  projectId?: string | undefined;
  disabled?: boolean;
  choices: ProjectModelChoices;
  onChange: (choices: ProjectModelChoices) => void;
  privacyRoute: PrivacyRoute;
  saved: string;
  onClose: () => void;
}) {
  if (taskId) return <ProjectModels taskId={taskId} disabled={props.disabled ?? false} />;
  return <NewPromptChoices {...props} />;
}

function NewPromptChoices({
  projectId,
  choices,
  onChange,
  disabled,
  privacyRoute,
  saved,
  onClose
}: Omit<Parameters<typeof PromptModelChoices>[0], 'taskId'>) {
  const resource = useResource<ProjectModelPreferences>(
    projectId
      ? `/v1/projects/${projectId}/model-preferences`
      : `/v1/workspace-model-preferences?privacyRoute=${privacyRoute}`
  );
  const [editing, setEditing] = useState<ModelPurpose | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<ModelPurpose | null>(null);
  useEffect(() => {
    if (!editing && returnFocus.current) {
      list.current
        ?.querySelector<HTMLButtonElement>(`[data-purpose="${returnFocus.current}"]`)
        ?.focus();
      returnFocus.current = null;
    }
  }, [editing]);
  const purposes = resource.value?.purposes ?? [];
  const current = purposes.find((item) => item.purpose === editing);
  const inheritLabel = projectId ? 'Use project default' : 'Use Settings default';
  const change = (purpose: ModelPurpose, choice?: PurposeModelChoice) => {
    const next = { ...choices };
    if (choice) next[purpose] = choice;
    else delete next[purpose];
    onChange(next);
  };
  const back = () => {
    returnFocus.current = editing;
    setEditing(null);
  };
  const selectedValue = (item: Purpose) => {
    const choice = choices[item.purpose];
    return !choice ? 'inherit' : choice.automatic ? 'automatic' : choice.modelId;
  };
  const summary = (item: Purpose) => {
    const choice = choices[item.purpose];
    if (!choice) return `Default · ${item.effective?.displayName ?? 'No model available'}`;
    if (choice.automatic) return `Automatic · ${preferenceLabels[choice.preference]}`;
    const model = item.options.find((option) => option.id === choice.modelId);
    return model
      ? [model.displayName, 'connectionLabel' in model ? model.connectionLabel : null]
          .filter(Boolean)
          .join(' · ')
      : `${choice.modelId} · unavailable`;
  };
  const warning = (item: Purpose) => {
    const choice = choices[item.purpose];
    if (!choice) return !item.available ? item.reason : null;
    if (choice.automatic) return null;
    const model = item.options.find((option) => option.id === choice.modelId);
    return model?.unavailableReason ?? (!model ? 'This saved model is unavailable.' : null);
  };
  return (
    <div className="prompt-models">
      <ResourceState resource={resource} />
      {resource.value && (
        <>
          {current ? (
            <div className="prompt-model-editor">
              <div className="prompt-model-editor-heading">
                <Button onClick={back} aria-label="Back to model roles">
                  <ArrowLeft size={16} />
                  Roles
                </Button>
                <div>
                  <h3>{purposeLabels[current.purpose]}</h3>
                  <p className="muted">{purposeDescriptions[current.purpose]}</p>
                </div>
              </div>
              <ModelBrowser
                key={current.purpose}
                embedded
                label={purposeLabels[current.purpose]}
                value={selectedValue(current)}
                models={current.options}
                disabled={disabled}
                shortcuts={[
                  {
                    value: 'inherit',
                    label: inheritLabel,
                    detail: current.effective
                      ? `Currently ${current.effective.displayName}`
                      : (current.reason ?? 'Follows your saved defaults.')
                  },
                  {
                    value: 'automatic',
                    label: 'Automatic',
                    detail: 'Let Garden choose an available model for this role.'
                  }
                ]}
                onClose={back}
                onChange={(value) => {
                  change(
                    current.purpose,
                    value === 'inherit'
                      ? undefined
                      : {
                          automatic: value === 'automatic',
                          modelId: value === 'automatic' ? '' : value,
                          preference:
                            choices[current.purpose]?.preference ?? current.choice.preference
                        }
                  );
                  back();
                }}
              />
            </div>
          ) : (
            <div className="prompt-model-roles" ref={list}>
              <p className="prompt-model-scope muted">
                {projectId
                  ? 'Defaults come from this project. Overrides apply to the new conversation.'
                  : 'Defaults come from Settings. Overrides become this project’s model choices.'}
              </p>
              {groups.map((group) => {
                const items = group.purposes.flatMap((purpose) =>
                  purposes.filter((item) => item.purpose === purpose && !item.disabled)
                );
                if (!items.length) return null;
                return (
                  <section
                    className="prompt-model-group"
                    key={group.label}
                    aria-label={`${group.label} model roles`}
                  >
                    <h3>{group.label}</h3>
                    {items.map((item) => (
                      <div className="prompt-model-row" key={item.purpose}>
                        <button
                          type="button"
                          data-purpose={item.purpose}
                          aria-label={`${purposeLabels[item.purpose]}: ${summary(item)}`}
                          disabled={disabled}
                          onClick={() => setEditing(item.purpose)}
                        >
                          <span className="prompt-model-role-name">
                            {purposeLabels[item.purpose]}
                          </span>
                          <span className="prompt-model-role-value">{summary(item)}</span>
                          <ChevronRight size={15} />
                        </button>
                        {warning(item) && <p className="model-unavailable">{warning(item)}</p>}
                        {choices[item.purpose]?.automatic &&
                          !['summarise', 'title', 'decisions'].includes(item.purpose) && (
                            <label className="prompt-model-preference">
                              <span>Prefer</span>
                              <select
                                aria-label={`${purposeLabels[item.purpose]} preference`}
                                disabled={disabled}
                                value={choices[item.purpose]!.preference}
                                onChange={(event) =>
                                  change(item.purpose, {
                                    ...choices[item.purpose]!,
                                    preference: event.target
                                      .value as PurposeModelChoice['preference']
                                  })
                                }
                              >
                                {Object.entries(preferenceLabels).map(([value, label]) => (
                                  <option key={value} value={value}>
                                    {label}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                      </div>
                    ))}
                  </section>
                );
              })}
              {purposes.some((item) => item.disabled) && (
                <details className="prompt-model-inactive">
                  <summary>Inactive roles</summary>
                  {purposes
                    .filter((item) => item.disabled)
                    .map((item) => (
                      <p className="muted" key={item.purpose}>
                        {item.reason}
                      </p>
                    ))}
                </details>
              )}
            </div>
          )}
          <div className="prompt-model-footer">
            <span className="muted" role="status">
              {saved === 'Draft synced' ? 'Saved with draft' : saved || 'Applies to this draft'}
            </span>
            <div className="row">
              {!current && Object.keys(choices).length > 0 && (
                <Button disabled={disabled} onClick={() => onChange({})}>
                  Reset to defaults
                </Button>
              )}
              <Button onClick={onClose}>Done</Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
