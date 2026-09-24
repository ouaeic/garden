export type View =
  | 'work'
  | 'projects'
  | 'automations'
  | 'library'
  | 'computer'
  | 'settings'
  | 'attention';
export function initialNavigation() {
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  return {
    taskId: params.get('task'),
    projectId: params.get('project'),
    view: ([
      'work',
      'projects',
      'automations',
      'library',
      'computer',
      'settings',
      'attention'
    ].includes(view ?? '')
      ? view
      : 'work') as View
  };
}
