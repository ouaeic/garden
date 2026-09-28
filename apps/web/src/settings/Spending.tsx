import type { SpendLimits, SpendSummary } from '@garden/contracts';
import { put } from '../client.js';
import { Button, Field } from '../ui.js';
import {
  ActionFeedback,
  ResourceState,
  Section,
  fieldValue,
  numberOrNull,
  sensitive,
  useAction,
  useResource
} from '../management.js';
import { bytes, date, money } from '../model.js';
import { ToolUsageSettings } from './ToolUsage.js';
import {
  MAX_SPEND_CAP_USD,
  MAX_TASK_SPEND_USD,
  MAX_PRICE_CEILING_USD_PER_MILLION
} from '../usage-model.js';

interface Usage {
  period: { start: string; end: string };
  totals: { settled?: number; reserved?: number };
  storageBytes: number;
  storageLimitBytes: number;
  storageThreshold: string;
  history: unknown[];
}
export function SpendingSettings({ onChange }: { onChange: () => void }) {
  const limits = useResource<SpendLimits>('/v1/spend-limits');
  const spend = useResource<SpendSummary>('/v1/spend');
  const usage = useResource<Usage>('/v1/usage');
  const action = useAction(() => {
    limits.refresh();
    spend.refresh();
    usage.refresh();
    onChange();
  });
  return (
    <>
      <Section title="Spending" description="Provider costs are paid directly from your account.">
        <ResourceState resource={spend} />
        {spend.value && (
          <>
            <div className="management-stats">
              {spend.value.windows.map((window) => (
                <div className="management-stat" key={window.name}>
                  <strong>{money(window.spentUsd)}</strong>
                  <span>
                    {window.name} ·{' '}
                    {window.capUsd === null ? 'No cap' : `${money(window.capUsd)} cap`}
                  </span>
                  {window.capUsd !== null && (
                    <progress
                      aria-label={`${window.name} spending`}
                      max={window.capUsd || 1}
                      value={Math.min(window.projectedUsd, window.capUsd)}
                    />
                  )}
                  <p className="muted management-metadata">
                    {window.pendingUsd > 0 && `${money(window.pendingUsd)} reserved. `}
                    {window.state === 'exceeded'
                      ? 'Limit reached'
                      : window.state === 'warning'
                        ? 'Near your limit'
                        : 'Within your limits'}
                    {window.endsAt && ` · resets ${date(window.endsAt)}`}
                  </p>
                </div>
              ))}
            </div>
            {(['byDay', 'byModel', 'byTask'] as const).map((key) => (
              <details key={key}>
                <summary>
                  {key === 'byDay' ? 'Daily history' : key === 'byModel' ? 'By model' : 'By task'}
                </summary>
                {spend.value![key].length ? (
                  <div className="management-scroll">
                    <table className="management-table">
                      <thead>
                        <tr>
                          <th>{key === 'byDay' ? 'Day' : key === 'byModel' ? 'Model' : 'Task'}</th>
                          <th>Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {spend.value![key].map((bucket) => (
                          <tr key={bucket.key}>
                            <td>{bucket.key}</td>
                            <td>{money(bucket.costUsd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="muted">Nothing billed in this period.</p>
                )}
              </details>
            ))}
          </>
        )}
      </Section>
      <Section
        title="Your limits"
        description="Leave a money field empty for no cap. Raising an existing ceiling may require your passkey."
      >
        <ResourceState resource={limits} />
        {/*
         * Until this box has an answer it applies a monthly ceiling of its own, and the field below
         * shows that number with nothing to say it is not the owner's. An owner who reads their own
         * decision there finds out otherwise only when it stops a run - which is exactly how it was
         * found out. The stored row's `updatedAt` sits at the epoch until something is saved, which
         * is the same test the server uses to decide a loosening here needs no passkey.
         */}
        {limits.value && !(Date.parse(limits.value.updatedAt) > 0) && (
          <p className="muted">
            You have not set spending limits yet, so garden applies a{' '}
            {money(limits.value.monthlyCapUsd ?? 0)} monthly ceiling as a backstop — work stops
            there and asks you rather than spending past it. Saving this form, empty fields
            included, replaces it with your own answer.
          </p>
        )}
        {limits.value && (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void action.run(
                () =>
                  sensitive(() =>
                    put('/v1/spend-limits', {
                      dailyCapUsd: numberOrNull(form.get('daily')),
                      monthlyCapUsd: numberOrNull(form.get('monthly')),
                      defaultTaskCapUsd: numberOrNull(form.get('task')),
                      warnAtPercent: Number(form.get('warning')),
                      timeZone: fieldValue(form, 'timezone'),
                      maxInputUsdPerMillionTokens: numberOrNull(form.get('input')),
                      maxOutputUsdPerMillionTokens: numberOrNull(form.get('output'))
                    })
                  ),
                'Spending limits saved'
              );
            }}
          >
            <div className="management-grid">
              <Field label="Daily cap · USD">
                <input
                  name="daily"
                  type="number"
                  min="0.01"
                  step="any"
                  max={MAX_SPEND_CAP_USD}
                  defaultValue={limits.value.dailyCapUsd ?? ''}
                  placeholder="No cap"
                />
              </Field>
              <Field label="Monthly cap · USD">
                <input
                  name="monthly"
                  type="number"
                  min="0.01"
                  step="any"
                  max={MAX_SPEND_CAP_USD}
                  defaultValue={limits.value.monthlyCapUsd ?? ''}
                  placeholder="No cap"
                />
              </Field>
              <Field label="Default per-task cap · USD">
                <input
                  name="task"
                  type="number"
                  min="0.01"
                  step="any"
                  max={MAX_TASK_SPEND_USD}
                  defaultValue={limits.value.defaultTaskCapUsd ?? ''}
                  placeholder="No cap"
                />
              </Field>
              <Field label="Warn at percentage">
                <input
                  required
                  name="warning"
                  type="number"
                  min="1"
                  max="99"
                  defaultValue={limits.value.warnAtPercent}
                />
              </Field>
              <Field label="Spending timezone">
                <input
                  required
                  name="timezone"
                  defaultValue={limits.value.timeZone}
                  placeholder="Africa/Johannesburg"
                />
              </Field>
            </div>
            <details>
              <summary>Model price ceiling</summary>
              <p className="muted">
                These rates constrain automatic and named model selections. Existing work keeps its
                model until you change it. Unpublished prices cannot be checked against these rates;
                task and account spending caps still apply.
              </p>
              <div className="management-grid">
                <Field label="Maximum input price · USD per million tokens">
                  <input
                    name="input"
                    type="number"
                    min="0"
                    max={MAX_PRICE_CEILING_USD_PER_MILLION}
                    step="any"
                    defaultValue={limits.value.maxInputUsdPerMillionTokens ?? ''}
                    placeholder="No ceiling"
                  />
                </Field>
                <Field label="Maximum output price · USD per million tokens">
                  <input
                    name="output"
                    type="number"
                    min="0"
                    max={MAX_PRICE_CEILING_USD_PER_MILLION}
                    step="any"
                    defaultValue={limits.value.maxOutputUsdPerMillionTokens ?? ''}
                    placeholder="No ceiling"
                  />
                </Field>
              </div>
            </details>
            <Button type="submit" busy={action.busy} className="primary">
              Save limits
            </Button>
            <ActionFeedback action={action} />
          </form>
        )}
      </Section>
      <Section title="Computer usage">
        <ResourceState resource={usage} />
        {usage.value && (
          <>
            <div className="management-stats">
              <div className="management-stat">
                <strong>{bytes(usage.value.storageBytes)}</strong>
                <span>of {bytes(usage.value.storageLimitBytes)} available storage allocation</span>
              </div>
              <div className="management-stat">
                <strong>{(usage.value.totals.settled ?? 0).toLocaleString()}</strong>
                <span>Settled compute credits</span>
              </div>
              <div className="management-stat">
                <strong>{(usage.value.totals.reserved ?? 0).toLocaleString()}</strong>
                <span>Reserved compute credits</span>
              </div>
            </div>
            <p className="muted">
              Compute credits bound runaway work; they are separate from the provider's currency
              bill.
            </p>
          </>
        )}
      </Section>
      <ToolUsageSettings />
    </>
  );
}
