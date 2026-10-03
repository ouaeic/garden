import type { ComputerTool } from './computer-tools';
import { useEffect, useState } from 'react';
import { Command, FileText, Search } from './icons';
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
  onComputer,
  onNew,
  settings = []
}: {
  workspace: Workspace | null;
  tasks: Task[];
  onClose: () => void;
  onTask: (id: string) => void;
  onView: (view: View) => void;
  onComputer: (tool: ComputerTool) => void;
  onNew: () => void;
  /** Screen preferences that can be flipped without opening Settings. */
  settings?: { label: string; action: () => void }[];
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
  // Each entry leads with the name of the door it opens, then the words people search for.
  const commands = [
    { label: 'New project', action: onNew },
    { label: 'Home', action: () => onView('work') },
    { label: 'Projects', action: () => onView('projects') },
    { label: 'Needs you — questions and approvals', action: () => onView('attention') },
    { label: 'Runs — jobs, pipelines, apps and schedules', action: () => onComputer('runs') },
    { label: 'Results — everything the work produced', action: () => onComputer('results') },
    { label: 'Files — the computer’s files', action: () => onComputer('files') },
    { label: 'Terminal', action: () => onComputer('terminal') },
    { label: 'Machine — health, recovery and updates', action: () => onComputer('machine') },
    {
      label: 'Settings — models, spending, memory, skills, appearance, account',
      action: () => onView('settings')
    },
    ...settings
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
            <button key={command.label} className="cursor-row" onClick={command.action}>
              <Command size={15} />
              {command.label}
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
          <button key={result.taskId} className="cursor-row" onClick={() => onTask(result.taskId)}>
            <FileText size={17} />
            <span>
              {result.title}
              <small>{result.excerpt}</small>
            </span>
          </button>
        ))}
      </div>
      {loading && <Spinner label="Searching your work…" />}
      <ErrorNotice error={error} />
    </Dialog>
  );
}
