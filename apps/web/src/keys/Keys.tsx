import { useEffect, useMemo, useState } from 'react';
import type { SpendLimits, Task } from '@garden/contracts';
import { ApiError, get, patch, put } from '../client';
import { stepUp } from '../auth';
import { setTaskKeys, taskAction } from '../app/actions';
import { growth, money } from '../app/derive';
import HoldButton from '../app/HoldButton';
import { Check, Lock, Publish, Remove, Rules, Speak, Spend } from '../app/icons';
import { openGoal } from '../app/route';
import { primaryWorkspace, refreshSoon, useGarden } from '../app/store';
import { toast } from '../app/toast';
import './keys.css';

interface Approval {
  status: string;
  sideEffect: string;
  createdAt: string;
}

const KEYS = [
  {
    id: 'spend',
    name: 'Spend',
    icon: Spend,
    what: 'Money, up to each goal’s cap and your daily and monthly caps'
  },
  {
    id: 'act',
    name: 'Act as you',
    icon: Speak,
    what: 'Send, submit and book in your browser, mail and calendar'
  },
  {
    id: 'publish',
    name: 'Publish',
    icon: Publish,
    what: 'Public links to your apps',
    locked: true
  },
  {
    id: 'remove',
    name: 'Remove',
    icon: Remove,
    what: 'Delete anything outside an undo point',
    locked: true
  },
  {
    id: 'rules',
    name: 'Rules',
    icon: Rules,
    what: 'Schedules, memory, services and connections',
    locked: true
  },
  {
    id: 'accounts',
    name: 'Accounts',
    icon: Lock,
    what: 'Passwords, codes and signatures',
    locked: true
  }
] as const;

/** How many consequential cards in a row the owner approved unchanged before the offer is made. */
const EARNED_AFTER = 10;

/**
 * The keys: what garden may do without asking, said in six words, lent by the goal or by default,
 * and earned rather than assumed. And one control that always works: stop everything.
 */
export default function Keys() {
  const { bootstrap, moves } = useGarden();
  const workspace = primaryWorkspace(bootstrap);
  const [limits, setLimits] = useState<SpendLimits | null>(null);
  const [history, setHistory] = useState<Approval[] | null>(null);
  const [declined, setDeclined] = useState(false);
  useEffect(() => {
    void get<SpendLimits>('/v1/spend-limits').then(setLimits, () => undefined);
    void Promise.all([
      get<Approval[]>('/v1/approvals?status=approved&limit=60'),
      get<Approval[]>('/v1/approvals?status=denied&limit=20')
    ]).then(
      ([approved, denied]) => setHistory([...approved, ...denied]),
      () => setHistory([])
    );
  }, []);
  const tasks = bootstrap?.tasks ?? [];
  const lent = tasks.filter(
    (task) =>
      task.securityMode === 'autonomous' &&
      !['completed', 'failed', 'cancelled'].includes(task.status) &&
      !task.archivedAt
  );
  const standing = workspace?.securityMode ?? 'balanced';
  const streak = useMemo(() => {
    if (!history) return 0;
    let count = 0;
    for (const item of [...history].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
    )) {
      if (item.sideEffect !== 'external_consequential') continue;
      if (item.status !== 'approved') break;
      count += 1;
    }
    return count;
  }, [history]);
  const growing = tasks.filter((task) => growth(task, moves) === 'working');

  const setStanding = async (mode: 'review' | 'balanced' | 'autonomous') => {
    if (!workspace) return;
    try {
      await patch(`/v1/workspaces/${workspace.id}/security-mode`, { securityMode: mode });
      refreshSoon(0);
      toast(
        mode === 'autonomous'
          ? 'New goals may act as you unless their deal says otherwise.'
          : mode === 'review'
            ? 'New goals will ask about everything.'
            : 'New goals will ask before acting as you.'
      );
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'That did not change.');
    }
  };
  const saveLimits = async (next: Partial<SpendLimits>) => {
    const body = { ...next };
    const send = () => put<SpendLimits>('/v1/spend-limits', body);
    try {
      setLimits(
        await send().catch(async (error: unknown) => {
          if (error instanceof ApiError && error.code.includes('step_up')) {
            await stepUp();
            return send();
          }
          throw error;
        })
      );
      toast('Saved.');
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'That did not save.');
    }
  };
  const stopAll = async () => {
    const results = await Promise.allSettled(
      tasks
        .filter((task) =>
          ['queued', 'planning', 'running', 'awaiting_resource'].includes(task.status)
        )
        .map((task) => taskAction(task.id, 'pause'))
    );
    toast(
      `Stopped ${results.filter((result) => result.status === 'fulfilled').length} at their next safe point. Nothing restarts until you say so.`
    );
  };

  const R = 168;
  const nodes = KEYS.map((key, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / KEYS.length;
    const isLent =
      key.id === 'spend' || (key.id === 'act' && (standing === 'autonomous' || lent.length > 0));
    return { key, x: 250 + R * Math.cos(angle), y: 250 + R * Math.sin(angle), isLent };
  });

  return (
    <div className="keys-view">
      <div className="ring-wrap" aria-hidden="true">
        <svg className="ring" viewBox="0 0 500 500">
          <g className="ring-spin">
            <circle className="ring-orbit" cx="250" cy="250" r={R} />
          </g>
          {nodes
            .filter((node) => node.isLent)
            .map((node) => (
              <line
                key={node.key.id}
                className="ring-tether"
                x1="250"
                y1="250"
                x2={node.x}
                y2={node.y}
              />
            ))}
          <text className="ring-title" x="250" y="246">
            Your keys
          </text>
          <text className="ring-sub" x="250" y="272">
            {nodes.filter((node) => node.isLent).length} lent ·{' '}
            {nodes.filter((node) => !node.isLent).length} with you
          </text>
          {nodes.map(({ key, x, y, isLent }) => (
            <g
              key={key.id}
              className={`ring-key ${isLent ? 'is-lent' : ''}`}
              transform={`translate(${x.toFixed(1)},${y.toFixed(1)})`}
            >
              <circle className="ring-halo" r="46" />
              <circle className="ring-base" r="31" />
              <g transform="translate(-11,-11)">
                <key.icon width={22} height={22} className="ring-icon" />
              </g>
              <text y="52">{key.name}</text>
              <text className="ring-note" y="68">
                {key.id === 'spend'
                  ? limits?.defaultTaskCapUsd
                    ? `${money(limits.defaultTaskCapUsd)} a goal`
                    : 'by the goal'
                  : key.id === 'act'
                    ? standing === 'autonomous'
                      ? 'by default'
                      : lent.length
                        ? `${lent.length} goal${lent.length === 1 ? '' : 's'}`
                        : 'with you'
                    : 'always you'}
              </text>
            </g>
          ))}
        </svg>
      </div>

      <div className="keys-side scroll">
        <header className="keys-head rise">
          <h1 className="display">
            What it may do <em>without you.</em>
          </h1>
          <p className="muted">
            Everything on your computer can be undone, so only the outside world needs a key. A deal
            lends keys to one goal; what you set here is the default for new goals.
          </p>
        </header>

        {standing === 'balanced' && streak >= EARNED_AFTER && !declined && (
          <section className="offer rise">
            <div className="eyebrow">Earned, not assumed</div>
            <h2 className="display">
              You approved the last {streak} sends and submissions without a change.{' '}
              <em>Lend “Act as you” by default?</em>
            </h2>
            <div className="offer-track" aria-hidden="true">
              {Array.from({ length: Math.min(streak, 30) }, (_, i) => (
                <i key={i} />
              ))}
            </div>
            <p className="muted">Take it back any time. Each deal can still keep it.</p>
            <div className="offer-acts">
              <button
                type="button"
                className="btn leaf"
                onClick={() => void setStanding('autonomous')}
              >
                Lend it
              </button>
              <button type="button" className="btn ghost" onClick={() => setDeclined(true)}>
                Not yet
              </button>
            </div>
          </section>
        )}

        <section className="key-rows" aria-label="Standing keys">
          <article className="key-row">
            <span className="key-icon">
              <Spend />
            </span>
            <div>
              <div className="key-row-top">
                <b>Spend</b>
              </div>
              <p className="faint">{KEYS[0].what}</p>
              {limits && (
                <div className="caps">
                  <CapField
                    label="Each new goal"
                    value={limits.defaultTaskCapUsd}
                    onSave={(value) => void saveLimits({ defaultTaskCapUsd: value })}
                  />
                  <CapField
                    label="Each day"
                    value={limits.dailyCapUsd}
                    onSave={(value) => void saveLimits({ dailyCapUsd: value })}
                  />
                  <CapField
                    label="Each month"
                    value={limits.monthlyCapUsd}
                    onSave={(value) => void saveLimits({ monthlyCapUsd: value })}
                  />
                </div>
              )}
            </div>
          </article>
          <article className="key-row">
            <span className="key-icon">
              <Speak />
            </span>
            <div>
              <div className="key-row-top">
                <b>Act as you</b>
                <div className="seg" role="group" aria-label="Act as you, for new goals">
                  <button
                    type="button"
                    aria-pressed={standing === 'review'}
                    onClick={() => void setStanding('review')}
                  >
                    Ask about everything
                  </button>
                  <button
                    type="button"
                    aria-pressed={standing === 'balanced'}
                    onClick={() => void setStanding('balanced')}
                  >
                    Ask first
                  </button>
                  <button
                    type="button"
                    aria-pressed={standing === 'autonomous'}
                    onClick={() => void setStanding('autonomous')}
                  >
                    Lent by default
                  </button>
                </div>
              </div>
              <p className="faint">{KEYS[1].what}</p>
              {lent.length > 0 && (
                <ul className="loans">
                  {lent.map((task: Task) => (
                    <li key={task.id}>
                      <button type="button" className="loan" onClick={() => openGoal(task.id)}>
                        <Check /> Lent to {task.title}
                      </button>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() =>
                          void setTaskKeys(task.id, false).then(() => toast('Taken back.'))
                        }
                      >
                        Take back
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </article>
          {KEYS.slice(2).map((key) => (
            <article key={key.id} className="key-row is-locked">
              <span className="key-icon">
                <key.icon />
              </span>
              <div>
                <div className="key-row-top">
                  <b>{key.name}</b>
                  <span className="lock-line">
                    <Lock /> Always asks you
                  </span>
                </div>
                <p className="faint">{key.what}</p>
              </div>
            </article>
          ))}
        </section>

        <section className="stop-card">
          <div className="eyebrow">The stop that always works</div>
          <p>
            Every goal stops at its next safe point,{' '}
            {growing.length ? `${growing.length} of them growing now` : 'nothing is growing now'}.
            Nothing restarts until you say so.
          </p>
          <HoldButton className="btn danger big" onHeld={() => void stopAll()}>
            Hold to stop everything
          </HoldButton>
        </section>
      </div>
    </div>
  );
}

function CapField({
  label,
  value,
  onSave
}: {
  label: string;
  value: number | null;
  onSave: (value: number | null) => void;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => setText(value === null ? '' : String(value)), [value]);
  return (
    <label className="cap-field">
      <span>{label}</span>
      <span className="cap-input">
        $
        <input
          inputMode="decimal"
          value={text}
          placeholder="none"
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            const next = text.trim() === '' ? null : Number(text);
            if (next !== value && (next === null || Number.isFinite(next))) onSave(next);
          }}
        />
      </span>
    </label>
  );
}
