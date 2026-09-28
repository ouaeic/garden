import { AnalysisRunRecord } from '@garden/contracts/analysis-run';

export function readAnalysisRecord(text: string): AnalysisRunRecord | null {
  if (text.length > 262144 || !text.includes('garden-analysis-run-1')) return null;
  try {
    const result = AnalysisRunRecord.safeParse(JSON.parse(text) as unknown);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Resolve declared files only when the run recorded its location relative to this manifest. */
export function analysisFilePath(
  manifestPath: string,
  directory: string | undefined,
  file: string
): string | null {
  if (
    directory === undefined ||
    !manifestPath.startsWith('workspace/') ||
    /[\\\0]/.test(manifestPath) ||
    manifestPath.split('/').some((part) => !part || part === '.' || part === '..')
  )
    return null;
  if (!file || file.startsWith('/') || /[\\\0]/.test(file) || file.split('/').includes('..'))
    return null;
  const parts = manifestPath.split('/');
  parts.pop();
  for (const value of [directory, file]) {
    if (value.startsWith('/') || /[\\\0]/.test(value)) return null;
    for (const part of value.split('/')) {
      if (part === '..') {
        if (parts.length <= 1) return null;
        parts.pop();
      } else if (part && part !== '.') parts.push(part);
    }
  }
  return parts[0] === 'workspace' && parts.length > 1 ? parts.join('/') : null;
}
