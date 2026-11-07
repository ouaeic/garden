import type { OwnerMove, Task } from '@garden/contracts';
import { kindOf } from '../app/kinds';
import type { Outcome } from './outcomes';

/**
 * The shape a result takes on the desk. Each one is drawn as what it is - a page, a site, a table,
 * an image, a short answer - so the owner can tell what came back before reading a word of it.
 */
export type Form =
  | 'answer'
  | 'document'
  | 'site'
  | 'data'
  | 'image'
  | 'slides'
  | 'code'
  | 'file'
  | 'message'
  | 'schedule';

export const FORM_WORD: Record<Form, string> = {
  answer: 'Answer',
  document: 'Document',
  site: 'Site',
  data: 'Data',
  image: 'Image',
  slides: 'Slides',
  code: 'Code',
  file: 'File',
  message: 'Message',
  schedule: 'Automation'
};

/** The file a result is best shown by: the first page, site, table or picture it made. */
export function primaryFile(outcome: Outcome | undefined) {
  const files = outcome?.files ?? [];
  const rank = (name: string, mime: string) => {
    const kind = kindOf(name, mime).id;
    return ['site', 'doc', 'slides', 'data', 'image', 'code', 'media', 'archive', 'other'].indexOf(
      kind
    );
  };
  return [...files].sort((a, b) => rank(a.name, a.mimeType) - rank(b.name, b.mimeType))[0];
}

/** An HTML page saved with no type still reads as a page when its name says so or nothing does. */
const looksLikePage = (name: string, mime: string) =>
  /\.html?$/i.test(name) ||
  mime === 'text/html' ||
  (!/\.[a-z0-9]{1,5}$/i.test(name) && /site|page|landing|one-pager|web/i.test(name));

/** What a finished result is, read from what it made first and from its words second. */
export function formOf(task: Task, outcome: Outcome | undefined): Form {
  const file = primaryFile(outcome);
  if (outcome?.previews.length) return 'site';
  if (file) {
    if (looksLikePage(file.name, file.mimeType)) return 'site';
    const kind = kindOf(file.name, file.mimeType).id;
    if (kind === 'doc') return 'document';
    if (kind === 'slides') return 'slides';
    if (kind === 'data') return 'data';
    if (kind === 'image' || kind === 'media') return 'image';
    if (kind === 'code') return 'code';
    if (kind === 'site') return 'site';
    return 'file';
  }
  if (task.scheduleId) return 'answer';
  return 'answer';
}

/**
 * What an ask will come back as, guessed from its words while it is still being typed, so the
 * owner sees the shape of the result before sending it. A guess, never a promise: the result is
 * drawn from what the work actually made.
 */
export function guessForm(text: string): Form | null {
  const words = text.trim().toLowerCase();
  if (words.split(/\s+/).length < 2) return null;
  if (
    /\b(every|each)\s+(day|weekday|morning|evening|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|month|hour)\b|\b(daily|weekly|monthly|hourly)\b|\bremind me\b/.test(
      words
    )
  )
    return 'schedule';
  if (
    /\b(website|web ?site|landing page|web ?app|\bapp\b|game|page for|portfolio site|dashboard)\b/.test(
      words
    )
  )
    return 'site';
  if (/\b(slides?|deck|presentation|keynote|pitch)\b/.test(words)) return 'slides';
  if (
    /\b(chart|graph|plot|analy[sz]e|analysis|spreadsheet|csv|dataset|data|table|statistics)\b/.test(
      words
    )
  )
    return 'data';
  if (/\b(image|picture|photo|illustration|logo|icon|poster|draw|render)\b/.test(words))
    return 'image';
  if (/\b(email|e-mail|reply|replies|inbox|message|dm|linkedin post|tweet)\b/.test(words))
    return 'message';
  if (
    /\b(code|bug|function|repo|repository|refactor|unit tests?|script|api|fix the|pull request)\b/.test(
      words
    )
  )
    return 'code';
  if (
    /\b(document|brief|report|essay|paper|letter|cv|resume|résumé|pdf|memo|proposal|article|blog|novel|chapter|write)\b/.test(
      words
    )
  )
    return 'document';
  return 'answer';
}

/** What the ghost says it will make, in a few words. */
export const GHOST_LINE: Record<Form, string> = {
  answer: 'An answer, here, in seconds',
  document: 'A document you can read, download and send',
  site: 'A site you can open and click through',
  data: 'A table and the numbers behind it',
  image: 'An image',
  slides: 'A slide deck',
  code: 'A change to your code, tested',
  file: 'A file',
  message: 'A draft for you to look over before anything is sent',
  schedule: 'An automation that runs on its own'
};

/** Which form a goal still at work is heading for, so it can be drawn assembling as that. */
export function formInProgress(task: Task, outcome: Outcome | undefined, hint?: Form | null): Form {
  if (outcome?.files.length || outcome?.previews.length) return formOf(task, outcome);
  return hint ?? guessForm(task.title) ?? 'answer';
}

/** A move that belongs on the desk as a decision, rather than as part of a result. */
export const decisionFor = (task: Task, moves: readonly OwnerMove[]) =>
  moves.find((move) => move.taskId === task.id);
