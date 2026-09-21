import { apiUrl, request } from '../client';
import { NOTEBOOK_PREVIEW_BYTES, readNotebookResponse } from './notebook';
import { editableNotebook, type NotebookFile } from './notebook-edit';

export async function loadNotebookFile(workspaceId: string, path: string, signal: AbortSignal) {
  const response = await fetch(
    apiUrl(
      `/v1/workspaces/${workspaceId}/file?${new URLSearchParams({ path, maxBytes: String(NOTEBOOK_PREVIEW_BYTES) })}`
    ),
    {
      credentials: 'include',
      redirect: 'error',
      signal
    }
  );
  const content = await readNotebookResponse(response);
  const sha = response.headers.get('x-content-sha256');
  if (response.headers.get('x-truncated') === 'true' || !sha || !/^[a-f0-9]{64}$/.test(sha))
    throw Error(
      'A complete notebook with a verified file version is required for editing. Download the original to work with a larger notebook.'
    );
  return { document: editableNotebook(content), sha };
}

export function serializeNotebook(document: NotebookFile): string {
  const content = JSON.stringify(document, null, 1) + '\n';
  if (new TextEncoder().encode(content).byteLength > NOTEBOOK_PREVIEW_BYTES)
    throw Error(
      'This notebook is too large to edit here. Undo the last change or download the original to continue in a notebook application.'
    );
  return content;
}

export async function saveNotebookFile(
  workspaceId: string,
  path: string,
  sha: string,
  document: NotebookFile
): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(sha)) throw Error('Reload the notebook before saving.');
  const content = serializeNotebook(document);
  const result = await request<{ sha256: string }>(
    `/v1/workspaces/${workspaceId}/file?${new URLSearchParams({ path, expectSha256: sha })}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new TextEncoder().encode(content)
    }
  );
  if (!/^[a-f0-9]{64}$/.test(result.sha256))
    throw Error(
      'The saved file version could not be confirmed. Keep your edits and reload before saving again.'
    );
  return result.sha256;
}
