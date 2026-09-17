import { useMemo, useState } from 'react';
import { readAnalysisRecord } from './analysis-record';
import AnalysisRunPreview from './AnalysisRunPreview';

export default function AnalysisJsonPreview({ content }: { content: string }) {
  const record = useMemo(() => readAnalysisRecord(content), [content]);
  const [source, setSource] = useState(false);
  if (!record) return <pre className="computer-log">{content}</pre>;
  return (
    <div className="stack">
      <div className="row" role="group" aria-label="Run display">
        <button className="button" aria-pressed={!source} onClick={() => setSource(false)}>
          Run overview
        </button>
        <button className="button" aria-pressed={source} onClick={() => setSource(true)}>
          Source JSON
        </button>
      </div>
      {source ? (
        <pre className="computer-log">{content}</pre>
      ) : (
        <AnalysisRunPreview key={record.id} record={record} />
      )}
    </div>
  );
}
