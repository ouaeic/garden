import { useSurfaceLocation } from './surface-location';
import type { Project, Task, Workspace } from '@garden/contracts';
import { ResultsLibrary } from './library/Results.js';
import { MemoryLibrary } from './library/Memory.js';
import { SkillsLibrary } from './library/Skills.js';
import './settings.css';
import './library.css';

export interface LibraryProps {
  workspace: Workspace | null;
  projects: Project[];
  knownTasks: Task[];
  onOpenTask: (id: string) => void;
  onChange: () => void;
  onTaskDeleted: (id: string) => void;
}
const sections = ['Results', 'Memory', 'Skills'] as const;
export function Library({
  workspace,
  projects,
  knownTasks,
  onOpenTask,
  onChange,
  onTaskDeleted
}: LibraryProps) {
  const [selected, setSection] = useSurfaceLocation('section', 'Results');
  const section = sections.includes(selected as (typeof sections)[number]) ? selected : 'Results';
  return (
    <div className="management-page library-page">
      <header className="management-heading">
        <p className="eyebrow">A place for what lasts</p>
        <h1>Library</h1>
        <p className="muted">Results worth keeping. Context worth remembering.</p>
      </header>
      <nav className="management-tabs" aria-label="Library sections">
        {sections.map((item) => (
          <button
            type="button"
            key={item}
            aria-current={section === item ? 'page' : undefined}
            onClick={() => setSection(item)}
          >
            {item}
          </button>
        ))}
      </nav>
      <div className="management-content" key={`${section}:${workspace?.id ?? ''}`}>
        {section === 'Results' && (
          <ResultsLibrary
            workspace={workspace}
            projects={projects}
            knownTasks={knownTasks}
            onOpenTask={onOpenTask}
            onChange={onChange}
            onTaskDeleted={onTaskDeleted}
          />
        )}
        {section === 'Memory' && (
          <MemoryLibrary workspace={workspace} projects={projects} onOpenTask={onOpenTask} />
        )}
        {section === 'Skills' && <SkillsLibrary workspace={workspace} />}
      </div>
    </div>
  );
}
export default Library;
