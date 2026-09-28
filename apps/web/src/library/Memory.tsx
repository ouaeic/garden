import { useState } from 'react';
import type { MemoryItemBody, Workspace } from '@garden/contracts';
import { ApiError, del, get, patch, post, put } from '../client.js';
import { Button, Dialog, Field } from '../ui.js';
import {
  ActionFeedback,
  ConfirmButton,
  ResourceState,
  Section,
  fieldValue,
  rawFieldValue,
  useAction,
  useResource
} from '../management.js';
import { date } from '../model.js';

interface Memory {
  id: string;
  target: 'workspace' | 'user';
  scope: string;
  content: string;
  status: string;
  validFrom: string | null;
  validUntil: string | null;
  source: string;
  sourceTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}
interface OwnerBlock {
  text: string;
  bytes: number;
  limit: number;
  version: number;
  updatedAt: string | null;
}
interface MemoryItem {
  id: string;
  kind: string;
  status: string;
  excerpt: string;
  observedAt: string;
  trust: string;
  origin: string;
  taskId?: string | null;
  reason?: string;
  lastVerified?: string | null;
  validTo?: string | null;
  contradicts?: string[];
}
interface Proposal {
  id: string;
  sentence: string;
  sightings: number;
  firstSeen: string;
  lastSeen: string;
  needsAnotherDay: boolean;
}
interface Review {
  procedures: MemoryItem[];
  disputed: MemoryItem[];
  proposals: Proposal[];
}
const localDate = (value: string): string => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

export function MemoryLibrary({
  workspace,
  onOpenTask
}: {
  workspace: Workspace | null;
  onOpenTask: (id: string) => void;
}) {
  const root = workspace ? `/v1/workspaces/${workspace.id}` : null;
  const memories = useResource<Memory[]>(root ? `${root}/memories` : null);
  const block = useResource<OwnerBlock>('/v1/account/memory-block');
  const items = useResource<MemoryItem[]>(root ? `${root}/memory-items?limit=200` : null);
  const review = useResource<Review>(root ? `${root}/memory-review?limit=200` : null);
  const [editing, setEditing] = useState<Memory | 'new' | null>(null);
  const [opened, setOpened] = useState<MemoryItemBody | null>(null);
  const action = useAction();
  const refresh = () => {
    memories.refresh();
    review.refresh();
    items.refresh();
  };
  return (
    <>
      <Section
        title="Your own words"
        description="A compact block you control, carried across your work."
      >
        <ResourceState resource={block} />
        {block.value && (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void action.run(async () => {
                const saved = await put<OwnerBlock>('/v1/account/memory-block', {
                  text: rawFieldValue(form, 'text'),
                  expectedVersion: block.value!.version
                });
                block.setValue(saved);
              }, 'Your block was saved');
            }}
          >
            <Field
              label="What should your agent know about you?"
              hint={`${block.value.bytes.toLocaleString()} of ${block.value.limit.toLocaleString()} bytes used. Keep credentials out.`}
            >
              <textarea
                name="text"
                rows={7}
                defaultValue={block.value.text}
                key={block.value.version}
                placeholder="Preferences, context and ways of working that matter to you."
              />
            </Field>
            <Button type="submit" busy={action.busy} className="primary">
              Save my words
            </Button>
            <ActionFeedback action={action} />
            {action.error instanceof ApiError && action.error.code === 'owner_block_conflict' && (
              <div className="stack">
                <p className="muted">
                  Your draft is still here. Copy it before loading the words saved by your other
                  device.
                </p>
                <ConfirmButton
                  label="Load saved words"
                  description="Replace this unsaved draft with the latest saved block. Copy any words you want to keep first."
                  action={async () => block.refresh()}
                />
              </div>
            )}
          </form>
        )}
      </Section>
      {!workspace ? (
        <p className="empty">Select a workspace to review its memory.</p>
      ) : (
        <>
          <Section
            title="Remembered facts"
            description="Stated facts can belong to this workspace or follow you across workspaces."
          >
            <ResourceState resource={memories} />
            <Button onClick={() => setEditing('new')}>Add a fact</Button>
            <div className="management-list">
              {memories.value?.map((memory) => (
                <article key={memory.id} className="management-item">
                  <div className="library-memory">
                    <p className="library-instruction">{memory.content}</p>
                    <p className="muted">
                      {memory.target === 'user' ? 'About you' : 'This workspace'} · {memory.status}{' '}
                      · {memory.source}
                      {memory.validUntil && ` · expires ${date(memory.validUntil)}`}
                    </p>
                    {memory.sourceTaskId && (
                      <Button onClick={() => onOpenTask(memory.sourceTaskId!)}>
                        View source work
                      </Button>
                    )}
                  </div>
                  <div className="row">
                    <Button onClick={() => setEditing(memory)}>Edit</Button>
                    <ConfirmButton
                      label="Forget"
                      description="Remove this saved fact from memory. Future tasks will no longer recall it."
                      action={async () => {
                        await del(`${root}/memories/${memory.id}`);
                        memories.refresh();
                      }}
                    />
                  </div>
                </article>
              ))}
            </div>
            {memories.value?.length === 0 && (
              <p className="empty">Save the facts you want future work to build on.</p>
            )}
          </Section>
          <Section
            title="Worth a second look"
            description="Review disputed facts and procedures that may have gone stale."
          >
            <ResourceState resource={review} />
            {review.value && (
              <div className="library-review">
                {(['procedures', 'disputed'] as const).map((kind) => (
                  <div key={kind}>
                    <h4>{kind === 'procedures' ? 'Procedures to verify' : 'Disputed memories'}</h4>
                    {review.value![kind].length === 0 ? (
                      <p className="muted">Nothing waiting for review.</p>
                    ) : (
                      review.value![kind].map((item) => (
                        <article className="management-item" key={item.id}>
                          <div>
                            <p>{item.excerpt}</p>
                            <p className="muted management-metadata">
                              {item.reason || item.status} · {item.origin}
                              {item.lastVerified && ` · verified ${date(item.lastVerified)}`}
                            </p>
                            {item.taskId && (
                              <Button onClick={() => onOpenTask(item.taskId!)}>Source work</Button>
                            )}
                          </div>
                          <div className="row">
                            <Button
                              disabled={action.busy}
                              onClick={() =>
                                void action.run(
                                  async () =>
                                    setOpened(
                                      await get<MemoryItemBody>(`${root}/memory-items/${item.id}`)
                                    ),
                                  ''
                                )
                              }
                            >
                              Read
                            </Button>
                            {kind === 'procedures' && (
                              <Button
                                disabled={action.busy}
                                onClick={() =>
                                  void action.run(async () => {
                                    await post(`${root}/memory-items/${item.id}/verify`);
                                    refresh();
                                  }, 'Marked as still correct')
                                }
                              >
                                Still correct
                              </Button>
                            )}
                            <ConfirmButton
                              label="Retract"
                              description="Keep the historical record, but stop recalling this item as true."
                              action={async () => {
                                await post(`${root}/memory-items/${item.id}/retract`);
                                refresh();
                              }}
                            />
                            <ConfirmButton
                              label="Forget"
                              description="Delete this item from remembered knowledge."
                              action={async () => {
                                await del(`${root}/memory-items/${item.id}`);
                                refresh();
                              }}
                            />
                          </div>
                        </article>
                      ))
                    )}
                  </div>
                ))}
                <div>
                  <h4>Proposed facts</h4>
                  {review.value.proposals.length === 0 ? (
                    <p className="muted">No proposals waiting.</p>
                  ) : (
                    review.value.proposals.map((proposal) => (
                      <article className="management-item" key={proposal.id}>
                        <div>
                          <p>{proposal.sentence}</p>
                          <p className="muted management-metadata">
                            Observed {proposal.sightings} times · last seen{' '}
                            {date(proposal.lastSeen)}
                            {proposal.needsAnotherDay ? ' · needs evidence from another day' : ''}
                          </p>
                        </div>
                        <Button
                          disabled={action.busy}
                          onClick={() =>
                            void action.run(async () => {
                              await post(`${root}/memory-proposals/dismiss`, {
                                proposal: proposal.id
                              });
                              review.refresh();
                            }, 'Proposal dismissed')
                          }
                        >
                          Dismiss
                        </Button>
                      </article>
                    ))
                  )}
                </div>
              </div>
            )}
            <ActionFeedback action={action} />
          </Section>
          <Section
            title="Memory record"
            description="Inspect what the computer has retained, with its origin and status."
          >
            <ResourceState resource={items} />
            {items.value?.map((item) => (
              <article className="management-item" key={item.id}>
                <div>
                  <p>{item.excerpt}</p>
                  <p className="muted management-metadata">
                    {item.kind} · {item.status} · {item.origin} · {date(item.observedAt)}
                  </p>
                </div>
                <div className="row">
                  <Button
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        async () =>
                          setOpened(await get<MemoryItemBody>(`${root}/memory-items/${item.id}`)),
                        ''
                      )
                    }
                  >
                    Read full item
                  </Button>
                  <ConfirmButton
                    label="Forget"
                    description="Delete this item from remembered knowledge."
                    action={async () => {
                      await del(`${root}/memory-items/${item.id}`);
                      refresh();
                    }}
                  />
                </div>
              </article>
            ))}
            {items.value?.length === 0 && (
              <p className="empty">Memory records will appear as work produces useful knowledge.</p>
            )}
            <ActionFeedback action={action} />
          </Section>
        </>
      )}
      {editing && (
        <Dialog
          title={editing === 'new' ? 'Remember a fact' : 'Edit remembered fact'}
          onClose={() => setEditing(null)}
        >
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const expiry = fieldValue(form, 'expiry');
              const common = {
                content: fieldValue(form, 'content'),
                validUntil: expiry ? new Date(expiry).toISOString() : null
              };
              void action.run(async () => {
                if (editing === 'new')
                  await post(`${root}/memories`, {
                    target: fieldValue(form, 'target'),
                    content: common.content,
                    ...(common.validUntil ? { validUntil: common.validUntil } : {})
                  });
                else await patch(`${root}/memories/${editing.id}`, common);
                setEditing(null);
                refresh();
              }, 'Fact saved');
            }}
          >
            <Field label="Fact">
              <textarea
                required
                name="content"
                maxLength={4000}
                rows={6}
                defaultValue={editing === 'new' ? '' : editing.content}
              />
            </Field>
            {editing === 'new' && (
              <Field label="Where it belongs">
                <select name="target" defaultValue="workspace">
                  <option value="workspace">This workspace</option>
                  <option value="user">About me · all workspaces</option>
                </select>
              </Field>
            )}
            <Field label="Valid until · optional">
              <input
                type="datetime-local"
                name="expiry"
                defaultValue={
                  editing !== 'new' && editing.validUntil ? localDate(editing.validUntil) : ''
                }
              />
            </Field>
            <Button type="submit" className="primary" busy={action.busy}>
              Save fact
            </Button>
            <ActionFeedback action={action} />
          </form>
        </Dialog>
      )}
      {opened && (
        <Dialog title={opened.title || 'Memory record'} onClose={() => setOpened(null)} wide>
          {!opened.readable && (
            <p className="error" role="alert">
              This memory could not be decrypted.
            </p>
          )}
          <div className="library-document">{opened.body}</div>
        </Dialog>
      )}
    </>
  );
}
