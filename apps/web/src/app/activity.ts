/**
 * What a run is doing, in the owner's words rather than a tool's name. A line the record wrote as
 * "Running parallel_web_read" reads as "Reading pages"; anything else is left as it was written.
 */
const DOING: Record<string, string> = {
  shell: 'Running a command',
  process: 'Managing a running job',
  files_list: 'Looking through files',
  file_read: 'Reading a file',
  document_read: 'Reading a document',
  document_search: 'Searching documents',
  code_search: 'Searching the code',
  repo_overview: 'Getting to know the project',
  code_diagnostics: 'Checking the code',
  coding_agent: 'Handing code work to a specialist',
  file_patch: 'Editing a file',
  file_write: 'Writing a file',
  session_search: 'Looking back through earlier work',
  memory_recall: 'Remembering',
  memory: 'Updating what it remembers',
  web_search: 'Searching the web',
  parallel_web_read: 'Reading pages',
  browser_snapshot: 'Looking at the browser',
  read_elements: 'Reading the page',
  browser_action: 'Using the browser',
  desktop_observe: 'Looking at the desktop',
  desktop_launch: 'Opening an app',
  desktop_action: 'Using the desktop',
  image_read: 'Looking at an image',
  audio_read: 'Listening to audio',
  generate_media: 'Making media',
  publish_artifact: 'Saving what it made',
  publish_preview: 'Publishing a preview',
  print_pdf: 'Making a PDF',
  set_plan: 'Planning',
  set_acceptance: 'Setting its checks',
  project_update: 'Updating the project',
  propose_deal: 'Writing a plan for you',
  schedule: 'Setting a schedule',
  delegate: 'Handing part of it to a specialist',
  skill: 'Using a saved skill',
  notify: 'Letting you know',
  ask: 'Asking you something',
  connector_action: 'Working in a connected service',
  connector_list: 'Checking connected services'
};

export function doingText(summary: string): string {
  const bare = DOING[summary.trim()];
  if (bare) return bare;
  const named = /^Running ([a-z_]+)\b(.*)$/.exec(summary.trim());
  if (!named) return summary;
  const words = DOING[named[1]!];
  return words ? `${words}${named[2]?.trim() ? ` ${named[2].trim()}` : ''}` : summary;
}
