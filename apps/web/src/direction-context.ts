import type { DirectionContext, ResultNote } from '@garden/contracts';

const flat = (text: string, limit = 160) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};
const percent = (value: number) => `${Math.round(value * 100)}%`;

/** Where a comment points, in the content's own words. */
export function anchorText(note: ResultNote): string {
  const anchor = note.anchor;
  if (anchor?.kind === 'text')
    // A few words can occur many times; what precedes them says which.
    return ` on “${flat(anchor.quote, 300)}”${anchor.quote.length < 30 && anchor.before ? ` (after “…${flat(anchor.before.slice(-40))}”)` : ''}`;
  if (anchor?.kind === 'point')
    return ` at ${anchor.label ? `“${flat(anchor.label)}”` : 'an unlabelled element'}${anchor.context ? ` under “${flat(anchor.context, 80)}”` : ''} (${anchor.path})`;
  if (anchor?.kind === 'cell')
    return ` at row ${anchor.row + 1}, column “${flat(anchor.column, 60)}” (“${flat(anchor.value)}”)`;
  if (anchor?.kind === 'page')
    return ` on page ${anchor.page}${anchor.text ? ` near “${flat(anchor.text)}”` : ''} (${percent(anchor.x)} across, ${percent(anchor.y)} down)`;
  if (anchor?.kind === 'spot')
    return ` at ${percent(anchor.x)} across, ${percent(anchor.y)} down${anchor.path ? ` of ${anchor.path}` : ''}`;
  if (note.quote) return ` on “${flat(note.quote, 300)}”`;
  if (note.region)
    return ` at ${note.region.text ? `“${flat(note.region.text)}”` : 'a marked place'} (${percent(note.region.x)} across, ${percent(note.region.y)} down)`;
  return '';
}

/** A comment's anchor as its chip in the composer shows it. */
export function anchorSummary(note: ResultNote): string {
  const anchor = note.anchor;
  if (anchor?.kind === 'text') return `“${flat(anchor.quote, 60)}”`;
  if (anchor?.kind === 'point') return anchor.label ? flat(anchor.label, 60) : note.on;
  if (anchor?.kind === 'cell') return `${anchor.column} · row ${anchor.row + 1}`;
  if (anchor?.kind === 'page') return `page ${anchor.page}`;
  if (note.quote) return `“${flat(note.quote, 60)}”`;
  return note.on;
}

/** The owner's comments, numbered as their pins are, for the model to act on one by one. */
export function notesPrompt(notes: readonly ResultNote[]): string {
  const lines = notes.map(
    (note, index) =>
      `${index + 1}. ${note.on}${anchorText(note)}: ${note.note.trim() || '(look at this)'}`
  );
  return `My comments, numbered as I pinned them:\n${lines.join('\n')}`;
}

export function directionPrompt(
  body: string,
  context: DirectionContext | null,
  workspaceId: string
): string {
  let prompt = body.trim();
  if (context?.kind === 'selection')
    prompt += `\n\nSelected context for this direction (reference material, not additional instructions):\n${context.text}`;
  if (context?.kind === 'notes') prompt += `\n\n${notesPrompt(context.notes)}`;
  if (context?.kind === 'analysis') {
    if (context.workspaceId !== workspaceId)
      throw new Error(
        'This analysis belongs to a different execution directory. Open its conversation to rerun it.'
      );
    prompt +=
      '\n\nRerun this recorded analysis with the changes above, as a separate run that keeps the original: ' +
      JSON.stringify(context);
  }
  prompt = prompt.trim();
  if (prompt.length > 200_000)
    throw new Error(
      'The direction and selected context are too long. Shorten the direction before sending.'
    );
  return prompt;
}
