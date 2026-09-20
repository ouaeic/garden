export const APPROVAL_NOTE_MAX_CHARS = 600;

/** Policy detail stays inspectable; a script is not a useful card introduction. */
export const approvalIntroduction = (tool: string, action: string, detail: string): string => {
  if (tool === 'shell' && /Allow this command to|Review network access for/.test(action))
    return 'Garden could not verify this command’s network effects. Approval allows the command to run.';
  if (tool === 'shell' && /Allow internet access for/.test(action))
    return 'Your approval setting asks before commands access the internet.';
  const first = detail.split(/\n\s*\n/)[0]?.trim() ?? '';
  return first.length > 280 ? `${first.slice(0, 279).trimEnd()}…` : first;
};

export const approvalToolPhrases: Record<string, string> = {
  audio_read: 'Read audio',
  decide: 'Use decision inference',
  browser_action: 'Use the browser',
  coding_agent: 'Start a coding tool',
  code_diagnostics: 'Run code analysis',
  connector_action: 'Use a connected service',
  desktop_action: 'Use the desktop',
  desktop_launch: 'Open an application',
  file_patch: 'Apply a file change',
  file_write: 'Write a file',
  generate_media: 'Generate media',
  memory: 'Update memory',
  parallel_web_read: 'Read web sources',
  print_pdf: 'Print a PDF',
  process: 'Resume a checkpoint command',
  publish_artifact: 'Publish a file',
  publish_preview: 'Publish a preview',
  schedule: 'Schedule work',
  shell: 'Run a command',
  skill: 'Update a skill'
};
