import type { ProjectModelChoices, ProjectModelPreferences, PrivacyRoute } from '@garden/contracts';
import { ResourceState, useResource } from './management.js';
import ModelChoiceFields from './ModelChoiceFields.js';
import ProjectModels from './ProjectModels.js';

export default function PromptModelChoices({
  taskId,
  projectId,
  disabled = false,
  choices,
  onChange,
  privacyRoute
}: {
  taskId: string;
  projectId?: string | undefined;
  disabled?: boolean;
  choices: ProjectModelChoices;
  onChange: (choices: ProjectModelChoices) => void;
  privacyRoute: PrivacyRoute;
}) {
  if (taskId) return <ProjectModels taskId={taskId} disabled={disabled} />;
  return (
    <NewPromptChoices
      projectId={projectId}
      choices={choices}
      onChange={onChange}
      disabled={disabled}
      privacyRoute={privacyRoute}
    />
  );
}
function NewPromptChoices({
  projectId,
  choices,
  onChange,
  disabled,
  privacyRoute
}: {
  projectId?: string | undefined;
  choices: ProjectModelChoices;
  onChange: (choices: ProjectModelChoices) => void;
  disabled?: boolean;
  privacyRoute: PrivacyRoute;
}) {
  const resource = useResource<ProjectModelPreferences>(
    projectId
      ? `/v1/projects/${projectId}/model-preferences`
      : `/v1/workspace-model-preferences?privacyRoute=${privacyRoute}`
  );
  return (
    <div className="stack">
      <p className="muted">
        {projectId
          ? 'These choices are saved with your draft and apply to this conversation. Unchanged purposes follow the project defaults.'
          : "Choose models before you begin. These choices are saved with your draft and become this project's defaults when you send it."}
      </p>
      <ResourceState resource={resource} />
      {resource.value && (
        <ModelChoiceFields
          purposes={
            projectId
              ? resource.value.purposes.map((purpose) => ({
                  ...purpose,
                  source: 'global' as const
                }))
              : resource.value.purposes
          }
          inheritLabel={projectId ? 'Use project choice' : 'Use global choice'}
          inheritDetail={
            projectId
              ? 'Follow the defaults in project settings.'
              : 'Follow your defaults in Settings.'
          }
          choices={choices}
          onChange={onChange}
          disabled={disabled}
        />
      )}
    </div>
  );
}
