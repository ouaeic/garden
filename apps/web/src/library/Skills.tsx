import { useState } from 'react';
import type { Workspace } from '@garden/contracts';
import { del, patch, post } from '../client.js';
import { Button, Dialog, Field } from '../ui.js';
import {
  ActionFeedback,
  ConfirmButton,
  ResourceState,
  Section,
  fieldValue,
  useAction,
  useResource
} from '../management.js';
import { date } from '../model.js';

interface Skill {
  id: string;
  version: number;
  enabled: boolean;
  status: 'active' | 'stale' | 'archived';
  pinned: boolean;
  useCount: number;
  lastUsedAt: string | null;
  name: string;
  description: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}
const outline = '## When to use\n\n\n## Procedure\n\n\n## Pitfalls\n\n\n## Verification\n';
export function SkillsLibrary({ workspace }: { workspace: Workspace | null }) {
  const root = workspace ? `/v1/workspaces/${workspace.id}/skills` : null;
  const skills = useResource<Skill[]>(root);
  const action = useAction(skills.refresh);
  const [editing, setEditing] = useState<Skill | 'new' | null>(null);
  const [filter, setFilter] = useState('');
  if (!workspace) return <p className="empty">Select a workspace to manage reusable skills.</p>;
  return (
    <Section
      title="Reusable ways of working"
      description="Small, explicit procedures the agent can choose when they fit the job."
    >
      <div className="row">
        <Field label="Find a skill">
          <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} />
        </Field>
        <Button onClick={() => setEditing('new')}>Create skill</Button>
      </div>
      <ResourceState resource={skills} />
      <div className="management-list">
        {skills.value
          ?.filter((skill) =>
            `${skill.name} ${skill.description}`.toLowerCase().includes(filter.toLowerCase())
          )
          .map((skill) => (
            <article className="management-item" key={skill.id}>
              <div>
                <strong>{skill.name}</strong>
                <p>{skill.description}</p>
                <p className="muted management-metadata">
                  Version {skill.version} · {skill.status} · used {skill.useCount} times
                  {skill.lastUsedAt && ` · last used ${date(skill.lastUsedAt)}`}
                </p>
                <details>
                  <summary>Read procedure</summary>
                  <div className="library-document">{skill.content}</div>
                </details>
                <div className="row">
                  <label className="management-check">
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      disabled={action.busy}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        void action.run(
                          () => patch(`${root}/${skill.id}`, { enabled }),
                          enabled ? 'Skill enabled' : 'Skill disabled'
                        );
                      }}
                    />
                    Enabled
                  </label>
                  <label className="management-check">
                    <input
                      type="checkbox"
                      checked={skill.pinned}
                      disabled={action.busy}
                      onChange={(event) => {
                        const pinned = event.target.checked;
                        void action.run(
                          () => patch(`${root}/${skill.id}`, { pinned }),
                          pinned ? 'Skill pinned' : 'Skill unpinned'
                        );
                      }}
                    />
                    Pinned
                  </label>
                  <Field label={`${skill.name} status`}>
                    <select
                      value={skill.status}
                      disabled={action.busy}
                      onChange={(event) => {
                        const status = event.target.value;
                        void action.run(
                          () => patch(`${root}/${skill.id}`, { status }),
                          'Skill status updated'
                        );
                      }}
                    >
                      <option value="active">Active</option>
                      <option value="stale">Stale</option>
                      <option value="archived">Archived</option>
                    </select>
                  </Field>
                </div>
              </div>
              <div className="row">
                <Button onClick={() => setEditing(skill)}>Edit</Button>
                <ConfirmButton
                  label="Delete"
                  description={`Delete saved skill “${skill.name}”. Its saved procedure will no longer be available.`}
                  action={async () => {
                    await del(`${root}/${skill.id}`);
                    skills.refresh();
                  }}
                />
              </div>
            </article>
          ))}
      </div>
      {skills.value?.length === 0 && (
        <p className="empty">Save a reliable procedure to use it again.</p>
      )}
      <ActionFeedback action={action} />
      {editing && (
        <Dialog
          title={editing === 'new' ? 'Create a skill' : `Edit ${editing.name}`}
          onClose={() => setEditing(null)}
          wide
        >
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void action.run(async () => {
                await post(root!, {
                  name: fieldValue(form, 'name'),
                  description: fieldValue(form, 'description'),
                  content: fieldValue(form, 'content')
                });
                setEditing(null);
              }, 'Skill saved');
            }}
          >
            <div className="management-grid">
              <Field label="Name" hint="Lowercase words separated by hyphens.">
                <input
                  name="name"
                  required
                  maxLength={64}
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  defaultValue={editing === 'new' ? '' : editing.name}
                  readOnly={editing !== 'new'}
                />
              </Field>
              <Field label="Description">
                <input
                  name="description"
                  required
                  maxLength={240}
                  defaultValue={editing === 'new' ? '' : editing.description}
                />
              </Field>
            </div>
            <Field
              label="Procedure"
              hint="Include When to use, Procedure, Pitfalls and Verification headings. Keep credentials out."
            >
              <textarea
                name="content"
                required
                rows={16}
                maxLength={24000}
                defaultValue={editing === 'new' ? outline : editing.content}
              />
            </Field>
            {editing !== 'new' && (
              <p className="management-note">
                Saving replaces this skill's content and creates its next version.
              </p>
            )}
            <Button type="submit" className="primary" busy={action.busy}>
              Save skill
            </Button>
            <ActionFeedback action={action} />
          </form>
        </Dialog>
      )}
    </Section>
  );
}
