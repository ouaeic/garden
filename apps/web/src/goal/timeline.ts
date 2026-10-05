import type { TaskEvent } from '@garden/contracts';

/** The first words of every prompt that carries agreed terms; owned by `packages/contracts/src/deal.ts`. */
export const AGREED_DEAL_MARKER = 'Deal agreed.';

/**
 * The goal's notes: what a colleague would mention, read out of the record.
 *
 * The model's words written beside its tool calls are its notes; its last words before the turn
 * ends are the answer, which belongs to the work, not here. Plans, questions, approvals, results
 * and checks are the other things worth a line. Tool calls themselves are not notes - they live in
 * Inspect, for anyone who wants them.
 */
export type NoteKind =
  | 'note'
  | 'you'
  | 'plan'
  | 'asked'
  | 'deal'
  | 'approval'
  | 'result'
  | 'checked'
  | 'problem';

export interface Note {
  id: string;
  at: string;
  kind: NoteKind;
  title: string;
  body?: string;
}

export const NOTE_LABEL: Record<NoteKind, string> = {
  note: 'Note',
  you: 'You',
  plan: 'Plan',
  asked: 'Asked you',
  deal: 'Deal',
  approval: 'Asked first',
  result: 'Result',
  checked: 'Checked',
  problem: 'Problem'
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const words = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Assistant words followed by more work in the same turn: a note, not the answer. */
function spokenBesideWork(events: readonly TaskEvent[], index: number): boolean {
  for (let next = index + 1; next < events.length; next++) {
    const kind = events[next]!.kind;
    if (kind === 'tool_started' || kind === 'plan') return true;
    if (kind === 'user_message' || kind === 'completed' || kind === 'assistant_message')
      return false;
  }
  return false;
}

export function notesFrom(events: readonly TaskEvent[]): Note[] {
  const notes: Note[] = [];
  let planned = 0;
  events.forEach((event, index) => {
    const payload = record(event.payload);
    const base = { id: event.id, at: event.createdAt };
    switch (event.kind) {
      case 'user_message': {
        const text = words(payload.markdown);
        if (text.startsWith(AGREED_DEAL_MARKER))
          notes.push({
            ...base,
            kind: 'deal',
            title: 'Deal agreed',
            body: text.split('\n')[1] ?? ''
          });
        else if (text.trim()) notes.push({ ...base, kind: 'you', title: text.trim() });
        break;
      }
      case 'assistant_message':
        if (payload.channel !== 'final' && spokenBesideWork(events, index)) {
          const text = words(payload.markdown).trim() || event.summary;
          if (text) notes.push({ ...base, kind: 'note', title: text });
        }
        break;
      case 'plan': {
        const steps = Array.isArray(payload.steps) ? payload.steps.length : 0;
        planned += 1;
        notes.push({
          ...base,
          kind: 'plan',
          title:
            planned === 1
              ? `Planned ${steps} step${steps === 1 ? '' : 's'}`
              : `Changed the plan: ${steps} steps`
        });
        break;
      }
      case 'question_asked':
        notes.push({
          ...base,
          kind: payload.deal ? 'deal' : 'asked',
          title: payload.deal ? 'Proposed a deal' : words(payload.question) || event.summary,
          ...(payload.why ? { body: words(payload.why) } : {})
        });
        break;
      case 'approval_requested':
        notes.push({
          ...base,
          kind: 'approval',
          title: event.summary,
          body: words(payload.preview)
        });
        break;
      case 'approval_resolved':
        notes.push({ ...base, kind: 'approval', title: event.summary });
        break;
      case 'artifact':
      case 'preview':
        notes.push({ ...base, kind: 'result', title: event.summary });
        break;
      case 'completed': {
        const status = words(record(payload.verification).status);
        notes.push({
          ...base,
          kind: status === 'verified' ? 'checked' : 'result',
          title:
            status === 'verified'
              ? 'Checked: every declared check passed'
              : status === 'checks_failed'
                ? 'Finished, but its checks failed'
                : 'Finished',
          ...(words(payload.summary) ? { body: words(payload.summary) } : {})
        });
        break;
      }
      case 'warning':
      case 'error':
        if (event.kind === 'error' || payload.owner === true)
          notes.push({ ...base, kind: 'problem', title: event.summary });
        break;
      case 'notice':
        notes.push({ ...base, kind: 'note', title: words(payload.headline) || event.summary });
        break;
      default:
        break;
    }
  });
  return notes.reverse();
}

/** "Done when", in the words the owner agreed to, when the goal was planted from a deal. */
export function doneWhen(events: readonly TaskEvent[]): string | null {
  for (const event of events) {
    if (event.kind !== 'user_message') continue;
    const text = words(record(event.payload).markdown);
    if (!text.startsWith(AGREED_DEAL_MARKER)) continue;
    const line = text.split('\n').find((row) => row.startsWith('Done when: '));
    if (line) return line.slice('Done when: '.length);
  }
  return null;
}
