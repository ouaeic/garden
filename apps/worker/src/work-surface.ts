import { z } from 'zod';
import {
  WorkSurfaceInput,
  workSurfaceReferences,
  workEvidenceValue,
  type WorkSurfaceReport
} from '@garden/contracts';
import { GardenError, decryptJson } from '@garden/core';
import type { ToolContext } from './tool-dispatch.js';

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const payload = (value: unknown): Record<string, unknown> => {
  const envelope = record(value);
  return envelope.__gardenEventVersion === 1 ? record(envelope.payload) : envelope;
};
export function describeWorkSurface() {
  return {
    presentation: z.toJSONSchema(WorkSurfaceInput),
    guidance:
      'Use presentation to acknowledge the current direction and compose meaningful task-specific blocks. Sections/timelines suit itineraries or findings; tables compare; checklists show work; charts select finite numbers from actual tool results by toolCallId and JSON pointer. Evidence pointers are relative to the result, e.g. /sources/0. Result IDs must belong to this task. Text is your interpretation; citations link recorded evidence. Send steps with the first report or a new direction. Later reports may omit unchanged steps. Replace blocks when meaningful information changes, not after every tool. No HTML, scripts or invented links. Ordinary plan edits preserve the current report; a new owner direction requires a new report.'
  };
}

export async function validateWorkSurface(
  context: ToolContext,
  input: unknown,
  directionEventId: string
): Promise<WorkSurfaceReport> {
  const parsed = WorkSurfaceInput.safeParse(input);
  if (!parsed.success)
    throw new GardenError(
      'invalid_presentation',
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'presentation'}: ${issue.message}`)
        .join('; ')
    );
  const content = parsed.data;
  const references = workSurfaceReferences(content);
  const ids = [
    ...new Set(
      references.map((ref) => {
        const eventId = context.state.turnToolResults?.[ref.toolCallId]?.eventId;
        if (!eventId)
          throw new GardenError(
            'presentation_evidence_missing',
            `No recorded result for ${ref.toolCallId} in this turn. Use an actual completed tool call.`
          );
        return eventId;
      })
    )
  ];
  const receipts = ids.length
    ? await context.store.listTaskEvidenceByIds(context.task.id, ids)
    : [];
  const results = new Map<string, unknown>();
  for (const receipt of receipts) {
    if (
      receipt.taskId !== context.task.id ||
      receipt.kind !== 'tool_result' ||
      !receipt.payloadCiphertext
    )
      continue;
    const data = payload(
      decryptJson(receipt.payloadCiphertext, context.key, `task-event:${context.task.id}`)
    );
    if (typeof data.toolCallId === 'string') results.set(data.toolCallId, data.result);
  }
  for (const reference of references) {
    if (workEvidenceValue(results.get(reference.toolCallId), reference.pointer) === undefined)
      throw new GardenError(
        'presentation_evidence_missing',
        `The recorded result ${reference.toolCallId}${reference.pointer} is unavailable or too large. Select a valid value from a bounded tool result.`
      );
  }
  for (const block of content.blocks) {
    if (block.kind === 'chart')
      for (const point of block.points) {
        const value = workEvidenceValue(results.get(point.value.toolCallId), point.value.pointer);
        if (typeof value !== 'number' || !Number.isFinite(value))
          throw new GardenError(
            'presentation_chart_value',
            `Chart point ${point.label} must select a finite numeric result.`
          );
      }
    if (block.kind === 'result') {
      if (block.result.kind === 'artifact') {
        const artifact = await context.store.getArtifact(context.task.userId, block.result.id);
        if (!artifact || artifact.taskId !== context.task.id)
          throw new GardenError(
            'presentation_result_scope',
            'The artifact must belong to this task.'
          );
        if (artifact.workspaceId !== context.task.workspaceId) {
          const execution = await context.store.getProjectExecution(
            context.task.userId,
            context.task.id
          );
          if (
            execution?.status !== 'ready' ||
            execution.workspaceId !== context.task.workspaceId ||
            execution.sourceWorkspaceId !== artifact.workspaceId
          )
            throw new GardenError(
              'presentation_result_scope',
              'The artifact must belong to this task or its recorded source workspace.'
            );
        }
      } else {
        const receipts = await context.store.listTaskEvents(context.task.id, 0, {
          kind: 'preview',
          limit: 128
        });
        if (
          !receipts.some(
            (receipt) =>
              receipt.payloadCiphertext &&
              payload(
                decryptJson(receipt.payloadCiphertext, context.key, `task-event:${context.task.id}`)
              ).previewId === block.result.id
          )
        )
          throw new GardenError(
            'presentation_result_scope',
            'The preview must have been published by this task.'
          );
      }
    }
  }
  return { directionEventId, content };
}
