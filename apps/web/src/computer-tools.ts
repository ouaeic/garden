export const COMPUTER_TOOLS = [
  'runs',
  'results',
  'files',
  'terminal',
  'browser',
  'desktop',
  'machine'
] as const;
export type ComputerTool = (typeof COMPUTER_TOOLS)[number];

/** A tool named by a link, including the names the tabs had before they were merged. */
export const computerTool = (value: string | null | undefined): ComputerTool =>
  value === 'processes' || value === 'previews'
    ? 'runs'
    : value === 'checkpoints'
      ? 'machine'
      : (COMPUTER_TOOLS as readonly string[]).includes(value ?? '')
        ? (value as ComputerTool)
        : 'runs';
