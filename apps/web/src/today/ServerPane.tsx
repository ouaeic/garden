import { useEffect, useState } from 'react';
import type { SpendLimits, Task } from '@garden/contracts';
import { get } from '../client';
import type { Bootstrap } from '../model';
import { useProcessFeed } from '../process-feed';
import { money } from '../app/derive';
import { go } from '../app/route';

/**
 * The machine as a place: how much room is left, what is running on it, and what today has cost.
 *
 * Room is said in work rather than in percentages, because the question behind it is "can I ask
 * for more now"; the gauges are there for anyone who wants the numbers.
 */
export function roomFor(cpu: number, memory: number): string {
  const load = Math.max(cpu, memory);
  if (load < 45) return 'Room for two more heavy jobs';
  if (load < 75) return 'Room for one more heavy job';
  return 'Busy. New work waits its turn';
}

function Gauge({ label, value }: { label: string; value: number | null }) {
  const c = 2 * Math.PI * 21;
  const shown = value === null ? null : Math.round(Math.min(100, Math.max(0, value)));
  return (
    <div className="gauge">
      <svg viewBox="0 0 52 52" aria-hidden="true">
        <circle className="gauge-track" cx="26" cy="26" r="21" />
        <circle
          className="gauge-fill"
          cx="26"
          cy="26"
          r="21"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - (shown ?? 0) / 100)}
        />
      </svg>
      <span className="gauge-value num">{shown === null ? '–' : `${shown}%`}</span>
      <span className="gauge-label">{label}</span>
    </div>
  );
}

export default function ServerPane({
  bootstrap,
  workspaceId,
  tasks
}: {
  bootstrap: Bootstrap;
  workspaceId: string | null;
  tasks: readonly Task[];
}) {
  const computer = bootstrap.computer;
  const cpu = computer?.cpuPercent ?? null;
  const memory = computer
    ? (computer.memoryUsedBytes / Math.max(1, computer.memoryTotalBytes)) * 100
    : null;
  const gpu = computer?.gpu?.devices[0]?.utilizationPercent ?? null;
  const usage = bootstrap.usage;
  const disk = (usage.storageBytes / Math.max(1, usage.storageLimitBytes)) * 100;
  const today = (usage.providerSpend as { windows?: { daily?: { used: number } } } | undefined)
    ?.windows?.daily?.used;
  const { list } = useProcessFeed(workspaceId ? `/v1/workspaces/${workspaceId}/processes` : null);
  const [limits, setLimits] = useState<SpendLimits | null>(null);
  useEffect(() => {
    void get<SpendLimits>('/v1/spend-limits').then(setLimits, () => undefined);
  }, []);
  const titles = new Map(tasks.map((task) => [task.id, task.title]));
  const running = (list?.processes ?? [])
    .filter((process) => process.status === 'running' && !process.archived)
    .sort((a, b) => (b.resources?.cpuPercent ?? 0) - (a.resources?.cpuPercent ?? 0))
    .slice(0, 4);
  const cores = list?.host?.logicalCpus ?? null;
  const cap = limits?.dailyCapUsd ?? null;
  return (
    <section className="pane server" aria-labelledby="server-title">
      <div className="pane-head">
        <h2 id="server-title">Your server</h2>
        <button type="button" className="count link" onClick={() => go({ view: 'computer' })}>
          {cores ? `${cores} cores · ` : ''}open
        </button>
      </div>
      <div className="server-body">
        <p className="server-room display">
          {cpu === null ? 'Waiting for the first reading' : roomFor(cpu, memory ?? 0)}.
        </p>
        <div className="gauges">
          <Gauge label="CPU" value={cpu} />
          <Gauge label="Memory" value={memory} />
          <Gauge label="GPU" value={computer?.gpu?.devices.length ? gpu : null} />
          <Gauge label="Disk" value={disk} />
        </div>
        {running.length > 0 && (
          <ul className="lanes">
            {running.map((process) => {
              const share = Math.min(
                1,
                (process.resources?.cpuPercent ?? 4) / (100 * (cores ?? 1))
              );
              const label = Array.isArray(process.command)
                ? process.command.join(' ')
                : process.command;
              return (
                <li key={process.sessionId} className="lane">
                  <span className="lane-who">
                    {(process.ownerTaskId && titles.get(process.ownerTaskId)) || 'computer'}
                  </span>
                  <span className="lane-bar">
                    <span className="lane-fill" style={{ width: `${Math.max(6, share * 100)}%` }} />
                    <span className="lane-label">
                      {process.service?.name ?? process.job?.name ?? label}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {today !== undefined && (
          <div className="spend-today">
            <div className="spend-row num">
              <span>Spent today</span>
              <span>
                {money(today)}
                {cap ? ` of ${money(cap)}` : ''}
              </span>
            </div>
            {cap ? (
              <div className="track" aria-hidden="true">
                <i style={{ width: `${Math.min(100, (today / cap) * 100)}%` }} />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
