export { numberedWindow, renderNumbered, toLines } from './format.js';
export {
  displayedRanges,
  firstUnshownLine,
  forgetPath,
  forgetReads,
  readsOf,
  recordRead,
  recordWrite,
  SNAPSHOTS_PER_PATH,
  SNAPSHOT_HORIZON_MS,
  type LineChange,
  type LineRange,
  type Snapshot
} from './snapshots.js';
export { checkSyntax, type SyntaxFault } from './syntax.js';
