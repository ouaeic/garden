import { primaryWorkspace, useGarden } from '../app/store';
import { useDraftText } from './draft';
import { GHOST_LINE, guessForm, type Form } from './forms';

/**
 * The shape of the result, drawn faintly under the ask while it is typed: a page for a document,
 * a frame for a site, bars for data. The owner sees what they will get before they send it, and
 * the shape becomes the real thing on the desk when they do.
 */
export default function Ghost() {
  const text = useDraftText();
  const form = guessForm(text);
  const { bootstrap } = useGarden();
  const asleep = primaryWorkspace(bootstrap)?.status !== 'running';
  return (
    <div className={`ghost ${form ? 'is-shown' : ''}`} aria-live="polite">
      {form && (
        <>
          <span className={`ghost-shape is-${form}`} aria-hidden="true">
            <Shape form={form} />
          </span>
          <span className="ghost-line">
            {GHOST_LINE[form]}
            {asleep ? ' · your computer is asleep, so it starts when it wakes' : ''}
          </span>
        </>
      )}
    </div>
  );
}

function Shape({ form }: { form: Form }) {
  switch (form) {
    case 'site':
      return (
        <>
          <b />
          <i />
          <i />
        </>
      );
    case 'data':
      return (
        <>
          {[0.5, 0.8, 0.35, 0.95, 0.6].map((height, index) => (
            <i key={index} style={{ '--h': height } as React.CSSProperties} />
          ))}
        </>
      );
    case 'schedule':
      return (
        <>
          {[0, 1, 2, 3, 4].map((index) => (
            <i key={index} />
          ))}
        </>
      );
    default:
      return (
        <>
          <i />
          <i />
          <i />
        </>
      );
  }
}
