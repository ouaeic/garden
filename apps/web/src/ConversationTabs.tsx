import { useEffect, useRef, useState } from 'react';
import type { Task } from '@athanor/contracts';

const reveal = (strip: HTMLElement, tab: HTMLElement) => {
  const viewport = strip.getBoundingClientRect(),
    box = tab.getBoundingClientRect();
  if (box.left < viewport.left) strip.scrollLeft += box.left - viewport.left;
  else if (box.right > viewport.right) strip.scrollLeft += box.right - viewport.right;
};

export default function ConversationTabs({
  tasks,
  selected,
  prefix,
  onOverview,
  onTask
}: {
  tasks: Task[];
  selected: string | undefined;
  prefix: string;
  onOverview: () => void;
  onTask: (id: string) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(selected ?? 'overview');
  const entries = [
    { id: 'overview', title: 'Overview' },
    ...tasks
      .slice()
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id)
      )
  ];
  const focusId = entries.some((entry) => entry.id === focused)
    ? focused
    : (selected ?? 'overview');
  useEffect(() => {
    setFocused(selected ?? 'overview');
  }, [selected]);
  useEffect(() => {
    const active = strip.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    const focusedTab = document.activeElement;
    if (strip.current && focusedTab instanceof HTMLElement && strip.current.contains(focusedTab))
      reveal(strip.current, focusedTab);
    else if (active && strip.current) reveal(strip.current, active);
  }, [selected, tasks.length]);
  return (
    <nav aria-label="Project conversations">
      <div
        ref={strip}
        role="tablist"
        tabIndex={-1}
        aria-label="Conversations"
        className="project-conversation-tabs"
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
          const index = tabs.indexOf(event.target as HTMLButtonElement);
          if (index < 0) return;
          const next =
            event.key === 'ArrowRight'
              ? (index + 1) % tabs.length
              : event.key === 'ArrowLeft'
                ? (index + tabs.length - 1) % tabs.length
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : null;
          if (next === null) return;
          event.preventDefault();
          const tab = tabs[next]!;
          tab.focus({ preventScroll: true });
          reveal(event.currentTarget, tab);
        }}
      >
        {entries.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            id={`${prefix}-tab-${entry.id}`}
            aria-controls={`${prefix}-panel`}
            aria-selected={entry.id === (selected ?? 'overview')}
            aria-current={entry.id === (selected ?? 'overview') ? 'page' : undefined}
            tabIndex={entry.id === focusId ? 0 : -1}
            onFocus={() => setFocused(entry.id)}
            onClick={() => (entry.id === 'overview' ? onOverview() : onTask(entry.id))}
            title={entry.title}
          >
            {entry.title}
          </button>
        ))}
      </div>
    </nav>
  );
}
