import { useState } from 'react';
import type { AnalysisRunFile, AnalysisRunRecord } from '@athanor/contracts/analysis-run';
import { apiUrl } from '../client';
import { analysisFilePath } from './analysis-record';
import { bytes } from './format';
import './analysis-run.css';

export type AnalysisLocation = { workspaceId: string; manifestPath: string };
export type ProducerSelection = { path: string; input: AnalysisRunFile };

function FileGroup({
  title,
  declared,
  files,
  location,
  directory,
  onInspectProducer
}: {
  title: string;
  declared: string[];
  files: AnalysisRunFile[] | undefined;
  location: AnalysisLocation | undefined;
  directory: string | undefined;
  onInspectProducer?: ((selection: ProducerSelection) => void) | undefined;
}) {
  const [limit, setLimit] = useState(20);
  if (!declared.length) return null;
  const recorded = new Map(files?.map((file) => [file.path, file]));
  return (
    <details className="analysis-run-group" open={title === 'Outputs'}>
      <summary>
        {title} <span className="muted">({declared.length})</span>
      </summary>
      <ul className="analysis-run-files">
        {declared.slice(0, limit).map((name) => {
          const file = recorded.get(name);
          const resolved = location && analysisFilePath(location.manifestPath, directory, name);
          const producer = file?.producer;
          const producerPath =
            producer &&
            location &&
            analysisFilePath(location.manifestPath, directory, producer.manifest);
          return (
            <li key={name}>
              <div className="row between">
                <code>{name}</code>
                {resolved && location && (
                  <a
                    href={apiUrl(
                      `/v1/workspaces/${location.workspaceId}/download?${new URLSearchParams({ path: resolved })}`
                    )}
                    download={name.split('/').at(-1)}
                    aria-label={`Download current ${name}`}
                  >
                    Download current file
                  </a>
                )}
              </div>
              {file ? (
                <>
                  <span className="muted">{bytes(file.bytes)} recorded</span>
                  <details>
                    <summary>SHA-256{file.declaredSourceUrl ? ' and declared source' : ''}</summary>
                    <code className="analysis-run-hash">{file.sha256}</code>
                    {file.declaredSourceUrl && (
                      <p className="analysis-run-path">Declared source: {file.declaredSourceUrl}</p>
                    )}
                  </details>
                  {producer && (
                    <details className="analysis-run-producer">
                      <summary>Recorded producer · {producer.name || producer.runId}</summary>
                      <p className="analysis-run-path">
                        This input matched <code>{producer.output}</code> from that run when
                        checked.
                      </p>
                      <p className="analysis-run-path">Run: {producer.runId}</p>
                      <p className="analysis-run-path">
                        Record: <code>{producer.manifest}</code>
                      </p>
                      <p>Recorded SHA-256:</p>
                      <code className="analysis-run-hash">{producer.sha256}</code>
                      {producerPath && file && onInspectProducer && (
                        <button
                          className="button"
                          onClick={() => onInspectProducer({ path: producerPath, input: file })}
                        >
                          Inspect producer
                        </button>
                      )}
                      {producerPath && location && (
                        <a
                          href={apiUrl(
                            `/v1/workspaces/${location.workspaceId}/download?${new URLSearchParams({ path: producerPath })}`
                          )}
                          download={producer.manifest.split('/').at(-1)}
                        >
                          Download current producer record
                        </a>
                      )}
                      <p className="muted">
                        A checksum links the recorded bytes; it does not independently establish
                        origin or scientific validity. The current record may have changed.
                      </p>
                    </details>
                  )}
                </>
              ) : (
                <span className="muted">No file checksum recorded</span>
              )}
            </li>
          );
        })}
      </ul>
      {limit < declared.length && (
        <button className="button" onClick={() => setLimit((value) => value + 20)}>
          Show more {title.toLowerCase()}
        </button>
      )}
    </details>
  );
}

export default function AnalysisRunPreview({
  record,
  location,
  onInspectProducer
}: {
  record: AnalysisRunRecord;
  location?: AnalysisLocation;
  onInspectProducer?: (selection: ProducerSelection) => void;
}) {
  const end = record.commandFinishedAt;
  const setups =
    record.environmentSetups ?? (record.environmentSetup ? [record.environmentSetup] : []);
  const elapsed =
    record.startedAt && end
      ? Math.max(0, (Date.parse(end) - Date.parse(record.startedAt)) / 1000)
      : null;
  const check = (value: boolean | undefined, success: string, failure: string) =>
    value === undefined ? 'Not recorded' : value ? success : failure;
  return (
    <section className="analysis-run stack" aria-label="Analysis run record">
      <header className="stack">
        <div className="row between">
          <h3>{record.spec.name || 'Analysis run'}</h3>
          <span className={`analysis-run-status ${record.status}`}>Recorded: {record.status}</span>
        </div>
        <p className="muted">
          Recorded{' '}
          {new Date(
            record.finishedAt ?? record.commandFinishedAt ?? record.startedAt ?? record.createdAt
          ).toLocaleString()}
          . This file is a snapshot, not live process status.
        </p>
      </header>
      {record.error && <p className="error analysis-run-path">{record.error}</p>}
      <dl className="analysis-run-facts">
        <div>
          <dt>Command duration</dt>
          <dd>
            {elapsed === null
              ? 'Not recorded'
              : elapsed >= 3600
                ? `${(elapsed / 3600).toFixed(1)} hours`
                : elapsed >= 60
                  ? `${(elapsed / 60).toFixed(1)} minutes`
                  : `${elapsed.toFixed(1)} seconds`}
          </dd>
        </div>
        <div>
          <dt>Exit code</dt>
          <dd>{record.exitCode ?? 'Not recorded'}</dd>
        </div>
        <div>
          <dt>Declared dependencies after execution</dt>
          <dd>{check(record.dependenciesUnchanged, 'Unchanged', 'Changed')}</dd>
        </div>
        {setups.map((setup) => (
          <div key={setup.kind}>
            <dt>
              {setup.kind === 'r_archives'
                ? 'R library'
                : setup.kind === 'conda_packages'
                  ? 'Native environment'
                  : 'Python environment'}
            </dt>
            <dd>
              {setup.status === 'ready'
                ? 'Rebuilt from verified local packages'
                : 'Preparation incomplete'}
            </dd>
          </div>
        ))}
        {record.replayedFrom && (
          <div>
            <dt>Output comparison with original</dt>
            <dd>
              {check(record.outputsMatchPrevious, 'Exact checksum match', 'Different checksums')}
            </dd>
          </div>
        )}
      </dl>
      <FileGroup
        title="Outputs"
        declared={record.spec.outputs}
        files={record.outputs}
        location={location}
        directory={record.directoryFromManifest}
      />
      <FileGroup
        title="Inputs"
        declared={record.spec.inputs.map((file) => file.path)}
        files={record.before?.inputs}
        location={location}
        directory={record.directoryFromManifest}
        onInspectProducer={onInspectProducer}
      />
      <FileGroup
        title="Scripts"
        declared={record.spec.sources}
        files={record.before?.sources}
        location={location}
        directory={record.directoryFromManifest}
      />
      <FileGroup
        title="Dependency locks"
        declared={record.spec.environment.lockFiles}
        files={record.before?.locks}
        location={location}
        directory={record.directoryFromManifest}
      />
      <details className="analysis-run-group">
        <summary>Environment and command</summary>
        <p className="muted">Command arguments, in execution order:</p>
        <pre>{JSON.stringify(record.spec.command, null, 2)}</pre>
        {record.before && <p>{Object.values(record.before.platform).join(' · ')}</p>}
        {record.spec.environment.runtimeOnly && <p>Declared as using the standard library only.</p>}
        {record.spec.environment.python && (
          <p className="analysis-run-path">
            Rebuild directory: <code>{record.spec.environment.python.directory}</code>. Only the
            recorded local packages are installed; the rebuild does not download dependencies.
          </p>
        )}
        {record.spec.environment.r && (
          <p className="analysis-run-path">
            R library: <code>{record.spec.environment.r.directory}</code>. Local package archives
            are installed in their declared order.
          </p>
        )}
        {record.spec.environment.conda && (
          <p className="analysis-run-path">
            Native environment: <code>{record.spec.environment.conda.directory}</code>. The saved
            manager and archives are verified, then the full dependency set is checked offline.
          </p>
        )}
        {[
          ...record.spec.environment.probes,
          ...(record.before?.probes.filter(
            (observed) =>
              !record.spec.environment.probes.some((probe) => probe.name === observed.name)
          ) ?? [])
        ].map((probe) => {
          const observed = record.before?.probes.find((item) => item.name === probe.name);
          return (
            <details key={probe.name}>
              <summary>{probe.name}</summary>
              <pre>{JSON.stringify(probe.command)}</pre>
              {observed ? (
                <>
                  <pre>{observed.output}</pre>
                  <code className="analysis-run-hash">SHA-256: {observed.sha256}</code>
                </>
              ) : (
                <p>No probe result recorded.</p>
              )}
            </details>
          );
        })}
        {record.spec.seeds && Object.keys(record.spec.seeds).length > 0 && (
          <>
            <h4>Declared seeds</h4>
            <pre>{JSON.stringify(record.spec.seeds, null, 2)}</pre>
            <p className="muted">The analysis script must apply these seeds.</p>
          </>
        )}
      </details>
      <details className="analysis-run-group">
        <summary>Record identity and scope</summary>
        <p className="analysis-run-path">Run: {record.id}</p>
        {record.replayedFrom && (
          <p className="analysis-run-path">Reproduces run: {record.replayedFrom}</p>
        )}
        <p>
          Checks cover declared files and environment probes. They do not establish scientific
          validity or capture undeclared dependencies.
        </p>
        {location && record.directoryFromManifest !== undefined && (
          <p>
            Downloads open the current project files. Their contents may have changed since these
            checksums were recorded.
          </p>
        )}
      </details>
    </section>
  );
}
