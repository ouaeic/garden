import type { AnalysisRunFile, AnalysisRunRecord } from '@garden/contracts/analysis-run';
import { readAnalysisRecord } from './analysis-record';
import type { WorkspaceTextFile } from './workspace-file';

/** Check the current record against the exact relationship retained by its downstream run. */
export function checkedProducer(
  file: WorkspaceTextFile,
  input: AnalysisRunFile
): AnalysisRunRecord {
  const expected = input.producer;
  if (!expected) throw new Error('This input has no recorded producer.');
  if (file.truncated || file.binary)
    throw new Error(
      'The producer cannot be checked as a complete text record. Download it for inspection.'
    );
  if (!file.sha || file.sha !== expected.sha256)
    throw new Error(
      'The producer record has changed or its checksum is unavailable. It has not been opened as the recorded producer.'
    );
  const record = readAnalysisRecord(file.original);
  if (!record || record.id !== expected.runId)
    throw new Error('The producer record does not match the recorded run identity.');
  const outputs = record.outputs?.filter((output) => output.path === expected.output) ?? [];
  if (
    record.status !== 'completed' ||
    record.exitCode !== 0 ||
    record.dependenciesUnchanged !== true ||
    record.outputsMatchPrevious === false ||
    !record.spec.outputs.includes(expected.output) ||
    outputs.length !== 1 ||
    outputs[0]!.sha256 !== input.sha256 ||
    outputs[0]!.bytes !== input.bytes
  )
    throw new Error('The producer does not record a successful matching output for this input.');
  return record;
}
