import ModelPicker from '../ModelPicker';
import { useState } from 'react';
import type { ModelRelease, TaskSchedule, TaskScheduleSpec, Workspace } from '@garden/contracts';
import { del, patch, post } from '../client.js';
import { Button, Dialog, Field } from '../ui.js';
import {
  ActionFeedback,
  ConfirmButton,
  ResourceState,
  Section,
  SecretResult,
  useAction,
  useResource
} from '../management.js';
import { date, money } from '../model.js';
import { MAX_TASK_SPEND_USD } from '../usage-model.js';
import { watchInput } from './watch-input.js';

function describe(spec: TaskScheduleSpec): string {
  if (spec.kind === 'once') return `Once · ${date(spec.runAt)}`;
  if (spec.kind === 'interval') return `Every ${spec.everyMinutes} minutes`;
  if (spec.kind === 'cron') return `${spec.expression} · ${spec.timeZone}`;
  if (spec.kind === 'daily') return `Daily at ${spec.localTime} · ${spec.timeZone}`;
  return `${spec.weekdays.map((day) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]).join(', ')} at ${spec.localTime} · ${spec.timeZone}`;
}
const localDate = (value: string): string => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

export function WatchesLibrary({
  workspace,
  onOpenTask,
  onChange
}: {
  workspace: Workspace | null;
  onOpenTask: (id: string) => void;
  onChange: () => void;
}) {
  const watches = useResource<TaskSchedule[]>('/v1/schedules');
  const models = useResource<ModelRelease[]>('/v1/models');
  const [editing, setEditing] = useState<TaskSchedule | 'new' | null>(null);
  const [secret, setSecret] = useState<{ url: string; secret: string } | null>(null);
  const action = useAction(() => {
    watches.refresh();
    onChange();
  });
  return (
    <>
      <Section
        title="Things in motion"
        description="Standing instructions that run while you are away."
      >
        <Button disabled={!workspace} onClick={() => setEditing('new')}>
          New automation
        </Button>
        <ResourceState resource={watches} />
        <div className="stack management-filter">
          {watches.value?.map((watch) => (
            <article className="library-schedule" key={watch.id}>
              <div className="management-item">
                <div>
                  <h4>{watch.title}</h4>
                  <p className="muted">
                    {watch.enabled ? 'Active' : 'Paused'} · {describe(watch.spec)}
                  </p>
                </div>
                <span className="library-status">
                  {watch.nextRunAt ? `Next ${date(watch.nextRunAt)}` : 'No run scheduled'}
                </span>
              </div>
              <p className="library-instruction">
                {watch.prompt ||
                  'The saved instruction could not be decrypted. Edit the automation to replace it.'}
              </p>
              <p className="muted management-metadata">
                {watch.maxSpendUsd === null
                  ? 'Account spending limits apply'
                  : `${money(watch.maxSpendUsd)} per-run ceiling`}
                {watch.lastRunAt && ` · last run ${date(watch.lastRunAt)}`}
              </p>
              {watch.lastErrorCode && (
                <p className="error">Last run: {watch.lastErrorCode.replaceAll('_', ' ')}</p>
              )}
              {watch.trigger && (
                <details>
                  <summary>Inbound trigger</summary>
                  <p className="muted">
                    Signed deliveries may start a run, at most once every{' '}
                    {watch.trigger.minGapMinutes} minutes. This automation also retains its clock
                    schedule.
                  </p>
                  {watch.triggerUrlPath && (
                    <SecretResult
                      label="Trigger endpoint"
                      value={new URL(watch.triggerUrlPath, window.location.origin).toString()}
                    />
                  )}
                  <p className="muted">
                    The signing secret was shown when this automation was created. Recreate the
                    automation to replace its trigger secret.
                  </p>
                </details>
              )}
              <div className="management-actions">
                <Button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() => post(`/v1/schedules/${watch.id}/run`), 'Run requested')
                  }
                >
                  Run now
                </Button>
                <Button
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(
                      () => post(`/v1/schedules/${watch.id}/${watch.enabled ? 'pause' : 'resume'}`),
                      watch.enabled ? 'Automation paused' : 'Automation resumed'
                    )
                  }
                >
                  {watch.enabled ? 'Pause' : 'Resume'}
                </Button>
                <Button onClick={() => setEditing(watch)}>Edit</Button>
                {watch.lastTaskId && (
                  <Button onClick={() => onOpenTask(watch.lastTaskId!)}>Latest work</Button>
                )}
                <ConfirmButton
                  label="Delete automation"
                  description={`Delete “${watch.title}” and its future timing${watch.trigger ? ' and inbound trigger' : ''}. Work it has already produced remains available.`}
                  action={async () => {
                    await del(`/v1/schedules/${watch.id}`);
                    watches.refresh();
                    onChange();
                  }}
                />
              </div>
            </article>
          ))}
        </div>
        {watches.value?.length === 0 && (
          <p className="empty">
            A daily briefing, a recurring check, a reminder with useful work attached.
          </p>
        )}
        <ActionFeedback action={action} />
        {secret && (
          <div className="stack">
            <h4>Inbound trigger ready</h4>
            <SecretResult label="Endpoint" value={secret.url} />
            <SecretResult label="Signing secret · shown once" value={secret.secret} />
            <p className="muted">
              Save the secret now. Deliveries need X-Garden-Timestamp and X-Garden-Signature, signed
              as HMAC-SHA256 of v1:timestamp: followed by the raw request body.
            </p>
            <Button onClick={() => setSecret(null)}>I have saved the secret</Button>
          </div>
        )}
      </Section>
      {editing && (
        <WatchEditor
          watch={editing === 'new' ? null : editing}
          workspace={workspace}
          models={models.value ?? []}
          onClose={() => setEditing(null)}
          onSaved={(watch) => {
            if (watch.triggerSecret && watch.triggerUrlPath)
              setSecret({
                url: new URL(watch.triggerUrlPath, window.location.origin).toString(),
                secret: watch.triggerSecret
              });
            watches.refresh();
            onChange();
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function WatchEditor({
  watch,
  workspace,
  models,
  onClose,
  onSaved
}: {
  watch: TaskSchedule | null;
  workspace: Workspace | null;
  models: ModelRelease[];
  onClose: () => void;
  onSaved: (watch: TaskSchedule & { triggerSecret?: string }) => void;
}) {
  const [modelId, setModelId] = useState('');
  const [kind, setKind] = useState<TaskScheduleSpec['kind']>(watch?.spec.kind ?? 'daily');
  const action = useAction();
  const source = watch?.spec;
  const timezone =
    source && 'timeZone' in source
      ? source.timeZone
      : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [privacy, setPrivacy] = useState(
    watch?.privacyRoute ??
      (models.some(
        (model) => model.privacyRoute === 'provider_zdr' && model.availability === 'available'
      )
        ? 'provider_zdr'
        : 'external')
  );
  return (
    <Dialog title={watch ? 'Edit automation' : 'New automation'} onClose={onClose} wide>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void action.run(async () => {
            const input = watchInput(form, kind, workspace?.id ?? '', Boolean(watch));
            const saved = watch
              ? await patch<TaskSchedule>(`/v1/schedules/${watch.id}`, input)
              : await post<TaskSchedule & { triggerSecret?: string }>('/v1/schedules', input);
            onSaved(saved);
          }, 'Automation saved');
        }}
      >
        <Field label="Name">
          <input
            name="title"
            required
            maxLength={160}
            defaultValue={watch?.title ?? ''}
            placeholder="A useful name for this automation"
          />
        </Field>
        <Field label="Standing instruction">
          <textarea
            name="prompt"
            required
            maxLength={200000}
            rows={7}
            defaultValue={watch?.prompt ?? ''}
            placeholder="What should happen, what would be useful to learn, and when should you be told?"
          />
        </Field>
        <div className="management-grid">
          <Field label="Timing">
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as TaskScheduleSpec['kind'])}
            >
              <option value="once" disabled={Boolean(watch?.trigger)}>
                Once
              </option>
              <option value="interval">At an interval</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="cron">Cron expression</option>
            </select>
          </Field>
          {kind === 'once' ? (
            <Field label="Run at · your device's local time">
              <input
                type="datetime-local"
                name="runAt"
                required
                defaultValue={source?.kind === 'once' ? localDate(source.runAt) : ''}
              />
            </Field>
          ) : kind === 'interval' ? (
            <Field label="Every · minutes">
              <input
                type="number"
                name="everyMinutes"
                required
                min="15"
                max="10080"
                defaultValue={source?.kind === 'interval' ? source.everyMinutes : 60}
              />
            </Field>
          ) : (
            <>
              <Field label="Timezone">
                <input required name="timezone" defaultValue={timezone} />
              </Field>
              {kind === 'cron' ? (
                <Field label="Cron expression">
                  <input
                    required
                    name="expression"
                    defaultValue={source?.kind === 'cron' ? source.expression : '0 9 * * *'}
                  />
                </Field>
              ) : (
                <Field label="Local time">
                  <input
                    required
                    type="time"
                    name="time"
                    defaultValue={source && 'localTime' in source ? source.localTime : '09:00'}
                  />
                </Field>
              )}
            </>
          )}
        </div>
        {kind === 'weekly' && (
          <fieldset>
            <legend>Weekdays</legend>
            <div className="library-weekdays">
              {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
                (day, index) => (
                  <label className="management-check" key={day}>
                    <input
                      name="weekday"
                      type="checkbox"
                      value={index}
                      defaultChecked={
                        source?.kind === 'weekly' ? source.weekdays.includes(index) : index === 1
                      }
                    />
                    {day.slice(0, 3)}
                  </label>
                )
              )}
            </div>
          </fieldset>
        )}
        {!watch && (
          <div className="management-grid">
            <input type="hidden" name="modelId" value={modelId} />
            <Field label="Model">
              <ModelPicker
                label="Automation model"
                value={modelId}
                models={models.filter((model) => model.privacyRoute === privacy)}
                privacyRoute={privacy}
                shortcuts={[{ value: '', label: 'Automatic for this instruction' }]}
                onChange={setModelId}
              />
            </Field>
            <Field label="Privacy route">
              <select
                name="privacyRoute"
                value={privacy}
                onChange={(event) => {
                  setPrivacy(event.target.value as typeof privacy);
                  setModelId('');
                }}
              >
                <option value="provider_zdr">Zero retention</option>
                <option value="external">External provider route</option>
              </select>
            </Field>
          </div>
        )}
        {watch && (
          <p className="management-note">
            This automation retains{' '}
            {models.find((model) => model.id === watch.modelId)?.displayName ?? watch.modelId} and
            its {watch.privacyRoute === 'provider_zdr' ? 'zero-retention' : 'external'} route.
            Create a new automation to change its model.
          </p>
        )}
        <details>
          <summary>Budgets and inbound trigger</summary>
          <div className="management-grid management-filter">
            <Field
              label="Per-run spending cap · USD"
              hint={watch ? 'Empty uses account limits.' : 'Empty uses your account default.'}
            >
              <input
                type="number"
                name="spend"
                min="0.01"
                max={MAX_TASK_SPEND_USD}
                step="any"
                defaultValue={watch?.maxSpendUsd ?? ''}
              />
            </Field>
            <Field label="Compute budget">
              <input
                required
                name="credits"
                type="number"
                min="0.01"
                max="10000"
                step="any"
                defaultValue={watch?.maxComputeCredits ?? 1}
              />
            </Field>
          </div>
          {!watch && kind !== 'once' && (
            <>
              <label className="management-check">
                <input type="checkbox" name="trigger" />
                Also accept signed inbound deliveries
              </label>
              <Field label="Minimum gap between triggered runs · minutes">
                <input type="number" name="minGap" min="15" max="10080" defaultValue={15} />
              </Field>
              <p className="muted">
                The clock still runs. The trigger URL and signing secret are created when you save.
              </p>
            </>
          )}
        </details>
        <Button type="submit" busy={action.busy} className="primary">
          {watch ? 'Save automation' : 'Create automation'}
        </Button>
        <ActionFeedback action={action} />
      </form>
    </Dialog>
  );
}
