import { useSyncExternalStore, type ReactNode } from 'react';

/** Short confirmations at the top of the screen, said once and gone. */
interface Toast {
  id: number;
  body: ReactNode;
  action?: { label: string; run: () => void };
  leaving?: boolean;
}

let toasts: Toast[] = [];
let next = 1;
const listeners = new Set<() => void>();
const publish = (list: Toast[]) => {
  toasts = list;
  listeners.forEach((listener) => listener());
};

export function toast(body: ReactNode, options: { action?: Toast['action']; ms?: number } = {}) {
  const id = next++;
  publish(
    [{ id, body, ...(options.action ? { action: options.action } : {}) }, ...toasts].slice(0, 3)
  );
  setTimeout(() => dismiss(id), options.ms ?? 4200);
}

function dismiss(id: number) {
  if (!toasts.some((item) => item.id === id && !item.leaving)) return;
  publish(toasts.map((item) => (item.id === id ? { ...item, leaving: true } : item)));
  setTimeout(() => publish(toasts.filter((item) => item.id !== id)), 450);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function Toasts() {
  const list = useSyncExternalStore(subscribe, () => toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((item) => (
        <div key={item.id} className={`toast ${item.leaving ? 'is-leaving' : ''}`}>
          <div>{item.body}</div>
          {item.action && (
            <button
              type="button"
              className="btn small"
              onClick={() => {
                item.action!.run();
                dismiss(item.id);
              }}
            >
              {item.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
