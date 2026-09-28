import { useEffect, useId, useRef, useState } from 'react';
import { Gauge, HardDrive, MemoryStick } from './icons';
import type { Workspace } from '@garden/contracts';
import type { Bootstrap } from './model';
import { bytes, money } from './model';
import { Button } from './ui';

export default function Stats({
  bootstrap,
  workspace,
  onComputer
}: {
  onComputer?: () => void;
  bootstrap: Bootstrap;
  workspace: Workspace | null;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const hovered = useRef(false);
  const pinned = useRef(false);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const close = () => {
      pinned.current = false;
      setOpen(false);
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (root.current?.contains(document.activeElement)) trigger.current?.focus();
      close();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <div
      className="garden-health"
      ref={root}
      onPointerEnter={(event) => {
        if (event.pointerType !== 'mouse') return;
        hovered.current = true;
        setOpen(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'mouse') return;
        hovered.current = false;
        if (!pinned.current && !event.currentTarget.contains(document.activeElement))
          setOpen(false);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !hovered.current) {
          pinned.current = false;
          setOpen(false);
        }
      }}
    >
      <Button
        ref={trigger}
        className="garden-stats-trigger"
        aria-label="Stats"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          pinned.current = !pinned.current;
          setOpen(pinned.current);
        }}
      >
        <Gauge size={14} />
        Stats
      </Button>
      {open && (
        <div className="garden-health-popover" id={id} role="region" aria-label="Usage statistics">
          <div className="garden-health-panel">
            <StatsContent bootstrap={bootstrap} workspace={workspace} />
            {onComputer && <Button onClick={onComputer}>All computer work</Button>}
          </div>
        </div>
      )}
    </div>
  );
}
function StatsContent({
  bootstrap,
  workspace
}: {
  bootstrap: Bootstrap;
  workspace: Workspace | null;
}) {
  const computer = bootstrap.computer;
  const plan = bootstrap.usage.plan;
  const disk =
    workspace?.hostStorageTotalBytes && workspace.hostStorageAvailableBytes !== undefined
      ? `${Math.round((1 - workspace.hostStorageAvailableBytes / workspace.hostStorageTotalBytes) * 100)}%`
      : null;
  return (
    <>
      <section aria-label="Computer resources">
        <h3>Computer</h3>
        <p className="muted">
          {workspace?.name ?? 'Your computer'} · {workspace?.status ?? 'Unavailable'}
        </p>
        <div className="garden-computer-status">
          {computer && (
            <span title={`CPU load: ${computer.cpuPercent}%`}>
              <Gauge size={13} />
              CPU {computer.cpuPercent}%
            </span>
          )}
          {computer && (
            <span
              title={`${bytes(computer.memoryUsedBytes)} of ${bytes(computer.memoryTotalBytes)} memory used`}
            >
              <MemoryStick size={13} />
              RAM{' '}
              {Math.round(
                (computer.memoryUsedBytes / Math.max(1, computer.memoryTotalBytes)) * 100
              )}
              %
            </span>
          )}
          {disk && (
            <span title={`${bytes(workspace!.hostStorageAvailableBytes!)} free on host disk`}>
              <HardDrive size={13} />
              Disk {disk}
            </span>
          )}
        </div>
        {!computer && !disk && <p className="muted">Resource usage unavailable.</p>}
      </section>
      {Boolean(plan?.windows.length) && (
        <section aria-label="Limits and credits">
          <h3>Limits &amp; credits</h3>
          <div className="garden-computer-status">
            {plan?.windows.map((window, index) => {
              const remaining =
                window.limit !== null && window.used !== null ? window.limit - window.used : null;
              const label = window.label.startsWith('Session')
                ? 'Session'
                : window.label.startsWith('Weekly')
                  ? 'Week'
                  : window.label === 'Credit balance'
                    ? 'Balance'
                    : window.label === 'Key limit'
                      ? 'Key'
                      : window.label;
              const shown =
                window.unit === 'usd'
                  ? remaining === null
                    ? window.used === null
                      ? '—'
                      : `${money(window.used)} used`
                    : `${money(remaining)} left`
                  : window.used === null
                    ? '—'
                    : `${Math.round(window.used * 100)}%`;
              const detail =
                window.unit === 'usd'
                  ? `${window.label}: ${window.used === null ? 'spend unavailable' : `${money(window.used)} used`}${window.limit === null ? ', no limit set' : ` of ${money(window.limit)}`}`
                  : `${window.label}: ${window.used === null ? 'unavailable' : `${Math.round(window.used * 100)}% of plan`}${window.resetsAt ? `, resets at ${new Date(window.resetsAt).toLocaleString()}` : ''}`;
              return (
                <span key={`${window.label}-${index}`} title={detail}>
                  <Gauge size={13} />
                  {label} {shown}
                </span>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}
