import { useEffect, useRef, useState } from 'react';
import type { ProjectRetentionPreview, ProjectRevision } from '@garden/contracts';
import { post } from './client';
import { bytes } from './model';
import { Button, Dialog, ErrorNotice, Spinner } from './ui';

export default function ProjectVersionArchive({
  projectId,
  versions,
  onChanged,
  onClose
}: {
  projectId: string;
  versions: string[];
  onChanged: (revision: ProjectRevision) => void;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<ProjectRetentionPreview | null>(null);
  const [reading, setReading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [generation, setGeneration] = useState(0);
  const requestId = useRef(crypto.randomUUID());
  const active = useRef(true);
  const endpoint = `/v1/projects/${projectId}/retention`;
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    setReading(true);
    setError(null);
    setPreview(null);
    requestId.current = crypto.randomUUID();
    void post<ProjectRetentionPreview>(
      `${endpoint}/preview`,
      { versions },
      { signal: controller.signal }
    )
      .then((result) => {
        if (!controller.signal.aborted) setPreview(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted) setReading(false);
      });
    return () => {
      active.current = false;
      controller.abort();
    };
  }, [endpoint, versions, generation]);
  const apply = async () => {
    if (!preview || applying) return;
    setApplying(true);
    setError(null);
    try {
      const result = await post<{ revisions: ProjectRevision[] }>(
        `${endpoint}/archive`,
        {
          versions,
          digest: preview.digest,
          requestId: requestId.current
        },
        { idempotencyKey: requestId.current }
      );
      if (!active.current) return;
      for (const revision of result.revisions) onChanged(revision);
      onClose();
    } catch (cause) {
      if (active.current) setError(cause);
    } finally {
      if (active.current) setApplying(false);
    }
  };
  return (
    <Dialog
      title="Archive project versions"
      onClose={() => {
        if (!applying) onClose();
      }}
    >
      <div className="stack project-version-archive">
        <p>
          Archived files stay recoverable in this project. Their history remains visible, and you
          can restore them at any time. Archiving does not free disk space.
        </p>
        <ErrorNotice error={error} />
        {reading && <Spinner label="Checking selected versions and running work…" />}
        {preview && (
          <ul className="project-version-archive-preview">
            {preview.versions.map((version) => (
              <li key={version.id}>
                <strong>
                  Version {version.number} · {version.title}
                </strong>
                <span className="muted">{bytes(version.logicalBytes)} in files</span>
                {version.reasons.length ? (
                  <ul>
                    {version.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="muted">Ready to archive</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="row">
          <Button
            disabled={reading || applying}
            onClick={() => setGeneration((value) => value + 1)}
          >
            Refresh preview
          </Button>
          <Button disabled={applying} onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="primary"
            disabled={
              !preview ||
              reading ||
              applying ||
              preview.versions.some((version) => version.reasons.length)
            }
            busy={applying}
            onClick={() => void apply()}
          >
            Archive {versions.length} {versions.length === 1 ? 'version' : 'versions'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
