import type { DirectionContext } from '@garden/contracts';
import type { AnalysisRunRecord } from '@garden/contracts/analysis-run';
import { readAnalysisRecord } from './analysis-record';
import { readWorkspaceFile } from './workspace-file';

export type AnalysisSelection = Extract<DirectionContext, { kind: 'analysis' }>;
export const canRerunAnalysis = (record: AnalysisRunRecord): boolean =>
  record.status === 'completed' &&
  record.exitCode === 0 &&
  record.dependenciesUnchanged === true &&
  record.outputsMatchPrevious !== false;

export async function checkAnalysisSelection(selection: AnalysisSelection): Promise<void> {
  const file = await readWorkspaceFile(selection.workspaceId, selection.manifestPath, {
    windowed: true
  });
  const record =
    !file.truncated && !file.binary && file.sha === selection.sha256
      ? readAnalysisRecord(file.original)
      : null;
  if (!record || record.id !== selection.runId || !canRerunAnalysis(record))
    throw new Error(
      'The selected analysis record has changed or cannot be checked. Reopen it and select Rerun with changes again.'
    );
}
