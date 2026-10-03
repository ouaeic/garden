import type { DirectionContext, ResultNote } from '@garden/contracts';

/** The owner's comments on a result, as they read them, for the model to act on. */
export function notesPrompt(notes: readonly ResultNote[]): string {
  const lines = notes.map((note, index) => {
    const anchor = note.quote
      ? ` on "${note.quote.replace(/\s+/g, ' ').trim()}"`
      : note.region
        ? ` on the circled area${note.region.text ? ` around "${note.region.text.replace(/\s+/g, ' ').trim()}"` : ''} (${Math.round(note.region.x * 100)}% across, ${Math.round(note.region.y * 100)}% down)`
        : '';
    return `${index + 1}. ${note.on}${anchor}: ${note.note.trim() || '(see this)'}`;
  });
  return `My comments on the result:\n${lines.join('\n')}`;
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
