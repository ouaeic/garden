import type { RecordEntry } from '@garden/contracts';
import { Key, Lock, Speak } from '../app/icons';
import { openGoal } from '../app/route';
import './record.css';

const VERDICT: Record<RecordEntry['verdict'], string> = {
  waiting: 'Waiting for you',
  approved: 'Approved',
  denied: 'You declined',
  expired: 'Lapsed unanswered',
  succeeded: 'Done',
  failed: 'Failed',
  refused: 'Refused'
};

const SOURCE: Record<RecordEntry['source'], string> = {
  card: 'You were asked',
  key: 'A lent key allowed it',
  connector: 'A connected service'
};

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

/** A connected service's operation name, said as what it did: "mail:message.send" is "Sent an email". */
const SAID: [RegExp, string][] = [
  [/^mail:message\.send/, 'Sent an email'],
  [/^mail:draft/, 'Saved an email draft'],
  [/^mail:message\.(delete|trash)/, 'Removed an email'],
  [/^calendar:events?\.create/, 'Added a calendar event'],
  [/^calendar:events?\.update/, 'Changed a calendar event'],
  [/^calendar:events?\.delete/, 'Removed a calendar event'],
  [/^github:/, 'Changed something on GitHub'],
  [/^webdav:files\.delete/, 'Removed a file from your storage'],
  [/^webdav:/, 'Wrote to your storage']
];
const said = (entry: RecordEntry) =>
  entry.source === 'connector'
    ? (SAID.find(([pattern]) => pattern.test(entry.action))?.[1] ??
      entry.action.replace(/[:._]/g, ' '))
    : entry.action;

/** One thing that left the computer, with what allowed it and how it ended. */
export function RecordRow({ entry, showGoal = false }: { entry: RecordEntry; showGoal?: boolean }) {
  const Icon = entry.source === 'key' ? Speak : entry.source === 'connector' ? Key : Lock;
  return (
    <li className="record-row" data-verdict={entry.verdict}>
      <time dateTime={entry.at}>{when(entry.at)}</time>
      <div className="record-what">
        <p>{said(entry)}</p>
        {entry.detail && <small>{entry.detail}</small>}
        <div className="record-tags">
          {showGoal && entry.taskId && entry.taskTitle && (
            <button
              type="button"
              className="kchip"
              onClick={() => openGoal(entry.taskId!, 'inspect')}
            >
              {entry.taskTitle}
            </button>
          )}
          <span className="kchip">
            <Icon /> {SOURCE[entry.source]}
          </span>
        </div>
      </div>
      <span className="verdict">{VERDICT[entry.verdict]}</span>
    </li>
  );
}
