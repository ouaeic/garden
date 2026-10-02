import type { ProjectModelChoices, ProjectModelPreferences, PrivacyRoute } from '@garden/contracts';
import { ResourceState, useResource } from './management.js';
import { Button } from './ui.js';
import ModelRoleChoices from './ModelRoleChoices.js';
import ProjectModels from './ProjectModels.js';

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
  if (taskId)
    return (
      <ProjectModels
        taskId={taskId}
        compact
        disabled={props.disabled ?? false}
        onChange={(next, previous) => {
          if (JSON.stringify(next.main) !== JSON.stringify(previous.main)) props.onChange({});
          props.onClose();
        }}
      />
    );
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
  return (
    <div className="prompt-models">
      <ResourceState resource={resource} />
      {resource.value && (
        <>
          <ModelRoleChoices
            purposes={resource.value.purposes}
            choices={choices}
            onChange={onChange}
            disabled={disabled}
            inheritLabel={projectId ? 'Use project default' : 'Use Settings default'}
            scope={
              projectId
                ? 'Defaults come from this project. Overrides apply to the new conversation.'
                : 'Defaults come from Settings. Overrides become this project’s model choices.'
            }
          />
          <div className="prompt-model-footer">
            <span className="muted" role="status">
              {saved === 'Draft synced' ? 'Saved with draft' : saved || 'Applies to this draft'}
            </span>
            <div className="row">
              {Object.keys(choices).length > 0 && (
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
