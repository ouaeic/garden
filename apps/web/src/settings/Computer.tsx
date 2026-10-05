import { useId, useState } from 'react';
import type { SecurityMode, Workspace, WorkspaceSnapshot } from '@garden/contracts';
import { permissionModeSummary } from '../asking-rules.js';
import { del, patch, post, put } from '../client.js';
import { Button, Field } from '../ui.js';
import {
  ActionFeedback,
  ConfirmButton,
  ResourceState,
  Section,
  download,
  fieldValue,
  rawFieldValue,
  sensitive,
  useAction,
  useResource
} from '../management.js';
import { bytes, date } from '../model.js';
import { refresh, useGarden } from '../app/store';

const MODE_WORDS: readonly [SecurityMode, string][] = [
  ['review', 'Ask about everything'],
  ['balanced', 'Ask first'],
  ['autonomous', 'May act as you']
];

export function ComputerSettings({
  workspace,
  onChange
}: {
  workspace: Workspace | null;
  onChange: () => void;
}) {
  const newPermissionHelpId = useId();
  const [newReviewMode, setNewReviewMode] = useState<SecurityMode>('balanced');
  const root = workspace ? `/v1/workspaces/${workspace.id}` : null;
  const snapshots = useResource<WorkspaceSnapshot[]>(root ? `${root}/snapshots` : null);
  const brief = useResource<{ markdown: string; path: string }>(root ? `${root}/brief` : null);
  const briefAction = useAction(() => brief.refresh());
  const snapshotAction = useAction(() => snapshots.refresh());
  const createAction = useAction(onChange);
  const switchAction = useAction();
  const computers = useGarden().bootstrap?.workspaces ?? [];
  const action = useAction(() => {
    snapshots.refresh();
    onChange();
  });
  return (
    <>
      {workspace ? (
        <>
          <Section title={workspace.name} description="The persistent computer behind your work.">
            <div className="management-stats">
              <div className="management-stat">
                <strong>{workspace.status}</strong>
                <span>Computer status</span>
              </div>
              <div className="management-stat">
                <strong>{bytes(workspace.storageBytes)}</strong>
                <span>of {bytes(workspace.storageLimitBytes)} allocation</span>
              </div>
              {workspace.hostStorageAvailableBytes !== undefined && (
                <div className="management-stat">
                  <strong>{bytes(workspace.hostStorageAvailableBytes)}</strong>
                  <span>Free on host disk</span>
                </div>
              )}
            </div>
            <div className="row">
              <Button
                disabled={action.busy || !['running', 'hibernated'].includes(workspace.status)}
                onClick={() =>
                  void action.run(
                    () =>
                      post(`${root}/${workspace.status === 'hibernated' ? 'resume' : 'hibernate'}`),
                    workspace.status === 'hibernated' ? 'Computer resumed' : 'Computer put to sleep'
                  )
                }
              >
                {workspace.status === 'hibernated' ? 'Wake computer' : 'Put to sleep'}
              </Button>
              <Button
                disabled={action.busy}
                onClick={() =>
                  void action.run(
                    () => download(`${root}/export`, `${workspace.name}.tar.gz`, true),
                    'Workspace downloaded'
                  )
                }
              >
                Download workspace
              </Button>
            </div>
            <ActionFeedback action={action} />
            <details>
              <summary>Storage allocation</summary>
              <form
                className="stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  void action.run(
                    () =>
                      sensitive(() =>
                        patch(root!, {
                          storageLimitBytes: Math.round(Number(form.get('storage')) * 1e9)
                        })
                      ),
                    'Storage allocation updated'
                  );
                }}
              >
                <Field label="Allocation in GB">
                  <input
                    required
                    type="number"
                    min="10"
                    max="100000"
                    step="1"
                    name="storage"
                    defaultValue={workspace.storageLimitBytes / 1e9}
                  />
                </Field>
                <Button type="submit" busy={action.busy}>
                  Resize allocation
                </Button>
              </form>
            </details>
          </Section>
          <Section
            title="Workspace brief"
            description="Standing context for work on this computer."
          >
            <ResourceState resource={brief} />
            {brief.value && (
              <form
                className="stack"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  void briefAction.run(
                    () => put(`${root}/brief`, { markdown: rawFieldValue(form, 'markdown') }),
                    'Workspace brief saved'
                  );
                }}
              >
                <Field label="Brief">
                  <textarea
                    name="markdown"
                    rows={10}
                    maxLength={50000}
                    defaultValue={brief.value.markdown}
                    placeholder="What should the agent know about work on this computer?"
                  />
                </Field>
                <Button type="submit" busy={briefAction.busy}>
                  Save brief
                </Button>
                <ActionFeedback action={briefAction} />
              </form>
            )}
          </Section>
          <Section
            title="Recovery points"
            description="Save workspace files and the browser profile. Goal history, account settings and mounted bulk storage are separate."
          >
            <ResourceState resource={snapshots} />
            <form
              className="row"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const values = new FormData(form);
                void snapshotAction
                  .run(
                    () =>
                      sensitive(() =>
                        post(`${root}/snapshots`, { name: fieldValue(values, 'name') })
                      ),
                    'Recovery point created'
                  )
                  .then((ok) => {
                    if (ok) form.reset();
                  });
              }}
            >
              <Field label="Recovery point name">
                <input required name="name" maxLength={80} placeholder="Before a major change" />
              </Field>
              <Button type="submit" busy={snapshotAction.busy}>
                Create recovery point
              </Button>
            </form>
            <ActionFeedback action={snapshotAction} />
            <div className="management-list">
              {snapshots.value?.map((snapshot) => (
                <article key={snapshot.id} className="management-item">
                  <div>
                    <strong>{snapshot.name}</strong>
                    <p className="muted">
                      {snapshot.status} · {bytes(snapshot.sizeBytes)} · {date(snapshot.createdAt)}
                    </p>
                  </div>
                  <div className="row">
                    <ConfirmButton
                      label="Restore"
                      title={`Restore ${snapshot.name}`}
                      disabled={snapshot.status !== 'ready'}
                      confirmText={workspace.name}
                      description="This restores the workspace files and browser profile. A safety recovery point is created first. Pause active work before restoring. Goal and result records stay current, so check file-backed results afterwards."
                      action={async () => {
                        await sensitive(() =>
                          post(`${root}/snapshots/${snapshot.id}/restore`, {
                            confirmName: workspace.name
                          })
                        );
                        snapshots.refresh();
                        onChange();
                      }}
                    />
                    <ConfirmButton
                      label="Delete"
                      description={`Delete recovery point “${snapshot.name}”. The saved recovery copy cannot be recovered.`}
                      action={async () => {
                        await sensitive(() => del(`${root}/snapshots/${snapshot.id}`));
                        snapshots.refresh();
                      }}
                    />
                  </div>
                </article>
              ))}
            </div>
            {snapshots.value?.length === 0 && (
              <p className="empty">Your recovery points will live here.</p>
            )}
          </Section>
          <Section title="Remove this computer">
            <p className="muted">
              Delete its files, browser profile and application key record. Download anything you
              want to keep first.
            </p>
            <ConfirmButton
              label="Delete computer"
              confirmText={workspace.name}
              description="Permanently delete this workspace and request deletion of its files. Existing deployment backups expire according to their retention policy."
              action={async () => {
                await sensitive(() => del(root!, { confirmName: workspace.name }));
                onChange();
              }}
            />
          </Section>
        </>
      ) : (
        <p className="empty">Create a computer to begin.</p>
      )}
      {computers.length > 1 && (
        <Section
          title="Your computers"
          description="Each has its own files, browser and brief. New goals start on the one you work on."
        >
          <div className="management-list">
            {computers.map((computer) => (
              <article key={computer.id} className="management-item">
                <div>
                  <strong>{computer.name}</strong>
                  <p className="muted">
                    {computer.status} · {bytes(computer.storageBytes)} of{' '}
                    {bytes(computer.storageLimitBytes)}
                  </p>
                </div>
                {computer.id === workspace?.id ? (
                  <span className="muted">Working here</span>
                ) : (
                  <Button
                    busy={switchAction.busy}
                    onClick={() =>
                      void switchAction.run(async () => {
                        await put('/v1/account/preferences', {
                          place: { workspaceId: computer.id, taskId: null }
                        });
                        await refresh();
                      }, `Working on ${computer.name}`)
                    }
                  >
                    Work here
                  </Button>
                )}
              </article>
            ))}
          </div>
          <ActionFeedback action={switchAction} />
        </Section>
      )}
      <Section
        title="Another computer"
        description="A separate computer on the same server, with its own files, browser and brief."
      >
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const values = new FormData(form);
            void createAction
              .run(
                () =>
                  post('/v1/workspaces', {
                    name: fieldValue(values, 'name'),
                    storageLimitBytes: Math.round(Number(values.get('storage')) * 1e9),
                    securityMode: fieldValue(values, 'securityMode')
                  }),
                'Computer created'
              )
              .then((ok) => {
                if (ok) {
                  form.reset();
                  setNewReviewMode('balanced');
                }
              });
          }}
        >
          <div className="management-grid">
            <Field label="Name">
              <input required name="name" maxLength={80} />
            </Field>
            <Field label="Storage allocation · GB">
              <input
                required
                name="storage"
                type="number"
                min="10"
                max="100000"
                defaultValue={50}
              />
            </Field>
            <Field label="Acting as you">
              <select
                name="securityMode"
                value={newReviewMode}
                aria-describedby={newPermissionHelpId}
                onChange={(event) => setNewReviewMode(event.target.value as SecurityMode)}
              >
                {MODE_WORDS.map(([mode, words]) => (
                  <option key={mode} value={mode}>
                    {words}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <details>
            <summary>What this mode allows</summary>
            <p id={newPermissionHelpId}>{permissionModeSummary(newReviewMode)}</p>
          </details>
          <Button type="submit" busy={createAction.busy}>
            Create computer
          </Button>
          <ActionFeedback action={createAction} />
        </form>
      </Section>
    </>
  );
}
