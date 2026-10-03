export type View = 'work' | 'projects' | 'computer' | 'settings' | 'attention';
const views: readonly string[] = ['work', 'projects', 'computer', 'settings', 'attention'];
/** Places that became tabs of the Computer page, and the tab each one opens. */
const computerTabs: Record<string, string> = { automations: 'runs', library: 'results' };

export function initialNavigation() {
  const params = new URLSearchParams(location.search);
  const view = params.get('view') ?? '';
  return {
    taskId: params.get('task'),
    projectId: params.get('project'),
    view: (computerTabs[view] ? 'computer' : views.includes(view) ? view : 'work') as View
  };
}

/** The Computer tab a link names, including links to the places that became tabs. */
export function initialComputerTool(): string | null {
  const params = new URLSearchParams(location.search);
  return computerTabs[params.get('view') ?? ''] ?? params.get('tool');
}
