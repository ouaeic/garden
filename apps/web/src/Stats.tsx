import { useEffect, useId, useRef, useState } from 'react';
import { Gauge, HardDrive, MemoryStick } from './icons';
import type { Workspace } from '@garden/contracts';
import type { Bootstrap } from './model';
import { bytes, dollarsLeft, money } from './model';
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
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const pressAt = useRef({ x: 0, y: 0 });
  const cancelHold = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
  };
  useEffect(() => cancelHold, []);
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
        title="Stats · tap or press and hold"
        onPointerDown={(event) => {
          if (event.pointerType === 'mouse') return;
          cancelHold();
          held.current = false;
          pressAt.current = { x: event.clientX, y: event.clientY };
          hold.current = setTimeout(() => {
            held.current = true;
            pinned.current = true;
            setOpen(true);
          }, 450);
        }}
        onPointerMove={(event) => {
          if (Math.hypot(event.clientX - pressAt.current.x, event.clientY - pressAt.current.y) > 10)
            cancelHold();
        }}
        onPointerUp={cancelHold}
        onPointerCancel={cancelHold}
        onPointerLeave={cancelHold}
        onContextMenu={(event) => event.preventDefault()}
        onClick={(event) => {
          if (held.current && event.detail !== 0) {
            held.current = false;
            return;
          }
          pinned.current = !pinned.current;
          setOpen(pinned.current);
        }}
      >
        <Gauge size={14} />
        <span>Stats</span>
      </Button>
      {open && (
        <div className="garden-health-popover" id={id} role="region" aria-label="Usage statistics">
          <div className="garden-health-panel">
            <StatsContent bootstrap={bootstrap} workspace={workspace} />
            {onComputer && (
              <Button
                onClick={() => {
                  pinned.current = false;
                  setOpen(false);
                  onComputer();
                }}
              >
                All computer work
              </Button>
            )}
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
        {computer?.gpu?.devices.map((gpu) => (
          <p
            key={gpu.id}
            title={`Server GPU · sampled ${new Date(computer.gpu!.sampledAt).toLocaleTimeString()}`}
          >
            {gpu.name} · GPU{' '}
            {gpu.utilizationPercent === null ? 'unavailable' : `${gpu.utilizationPercent}%`}
            {gpu.memoryUsedBytes !== null &&
              gpu.memoryTotalBytes !== null &&
              ` · VRAM ${bytes(gpu.memoryUsedBytes)} / ${bytes(gpu.memoryTotalBytes)}`}
            {gpu.temperatureC !== null && ` · ${gpu.temperatureC}°C`}
          </p>
        ))}
        {computer?.gpu && !computer.gpu.devices.length && (
          <p className="muted">GPU metrics unavailable on this server.</p>
        )}
        {!computer && !disk && <p className="muted">Resource usage unavailable.</p>}
      </section>
      {Boolean(plan?.windows.length) && (
        <section aria-label="Limits and credits">
          <h3>Limits &amp; credits</h3>
          <div className="garden-computer-status">
            {plan?.windows.map((window, index) => {
              const remaining = dollarsLeft(window);
              const label = window.label.startsWith('Session')
                ? 'Session'
                : window.label.startsWith('Weekly')
                  ? 'Week'
                  : window.label === 'Credit balance'
                    ? 'Balance'
                    : window.label === 'Key limit'
                      ? 'Key'
                      : window.label;
              const named = window.connection
                ? `${window.connection} ${label.toLowerCase()}`
                : label;
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
                  ? window.used === null && remaining !== null
                    ? `${window.connection ? `${window.connection} ` : ''}${window.label}: ${money(remaining)} left`
                    : `${window.label}: ${window.used === null ? 'spend unavailable' : `${money(window.used)} used`}${window.limit === null ? ', no limit set' : ` of ${money(window.limit)}`}`
                  : `${window.label}: ${window.used === null ? 'unavailable' : `${Math.round(window.used * 100)}% of plan`}${window.resetsAt ? `, resets at ${new Date(window.resetsAt).toLocaleString()}` : ''}`;
              return (
                <span key={`${window.label}-${index}`} title={detail}>
                  <Gauge size={13} />
                  {named} {shown}
                </span>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}
