import { useEffect, useState } from 'react';
import { ArrowUpRight, Command, FileText, Search } from './icons';
import type { Task, Workspace } from '@garden/contracts';
import { get } from './client';
import { taskStatusLabel } from './model';
import { Dialog, ErrorNotice, Spinner } from './ui';
import type { View } from './navigation';

export default function SearchDialog({
  workspace,
  tasks,
  onClose,
  onTask,
  onView,
  onNew
}: {
  workspace: Workspace | null;
  tasks: Task[];
  onClose: () => void;
  onTask: (id: string) => void;
  onView: (view: View) => void;
  onNew: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{ taskId: string; title: string; excerpt: string }>>(
    []
  );
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      void get<Array<{ taskId: string; title: string; excerpt: string }>>(
        `/v1/search?q=${encodeURIComponent(query)}${workspace ? `&workspaceId=${workspace.id}` : ''}`,
        { signal: controller.signal }
      )
        .then(setResults)
        .catch((err: unknown) => {
          if (!controller.signal.aborted) setError(err);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, workspace?.id]);
  const commands = [
    { label: 'Start new work', action: onNew },
    { label: 'Home', action: () => onView('work') },
    { label: 'Projects', action: () => onView('projects') },
    { label: 'Automations and schedules', action: () => onView('automations') },
    {
      label: 'All computer work: files, terminal, browser and desktop',
      action: () => onView('computer')
    },
    { label: 'Library: results, memory and skills', action: () => onView('library') },
    { label: 'Models, access and settings', action: () => onView('settings') },
    { label: 'Decisions and attention', action: () => onView('attention') }
  ];
  return (
    <Dialog title="Find anything" onClose={onClose}>
      <div className="command-input">
        <Search size={19} />
        <input
          aria-label="Search work and tools"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Work, a tool, or a thought…"
        />
        <kbd>esc</kbd>
      </div>
      <div className="command-results">
        {commands
          .filter((command) => command.label.toLowerCase().includes(query.toLowerCase()))
          .map((command) => (
            <button key={command.label} onClick={command.action}>
              <Command size={15} />
              {command.label}
              <ArrowUpRight size={15} />
            </button>
          ))}
        {(query
          ? results
          : tasks.slice(0, 8).map((task) => ({
              taskId: task.id,
              title: task.title,
              excerpt: taskStatusLabel(task)
            }))
        ).map((result) => (
          <button key={result.taskId} onClick={() => onTask(result.taskId)}>
            <FileText size={17} />
            <span>
              {result.title}
              <small>{result.excerpt}</small>
            </span>
            <ArrowUpRight size={15} />
          </button>
        ))}
      </div>
      {loading && <Spinner label="Searching your work…" />}
      <ErrorNotice error={error} />
    </Dialog>
  );
}
