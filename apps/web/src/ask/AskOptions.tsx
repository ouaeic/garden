import { useEffect, useRef } from 'react';
import type { Task, TaskReasoningEffort } from '@garden/contracts';
import { Paperclip } from '../app/icons';
import type { Bootstrap } from '../model';
import { effortLabel } from '../reasoning-options';

type ModelRelease = Bootstrap['models'][number];

const KEYS: readonly [Task['securityMode'], string][] = [
  ['review', 'Ask about everything'],
  ['balanced', 'Ask first'],
  ['autonomous', 'May act as you']
];

export interface AskSettings {
  models: readonly ModelRelease[];
  modelId: string;
  automatic: boolean;
  efforts: readonly TaskReasoningEffort[];
  reasoningEffort: TaskReasoningEffort;
  cap: string;
  securityMode: Task['securityMode'];
  privacyRoute: 'external' | 'provider_zdr';
  privacyLocked: boolean;
  interrupt: boolean;
}

/** What the next send will use, in a line, when any of it differs from the defaults. */
export function settingsSummary(settings: AskSettings, defaultMode: Task['securityMode']): string {
  const model = settings.models.find((item) => item.id === settings.modelId);
  return [
    settings.automatic ? 'Model chosen for the work' : model?.displayName,
    settings.reasoningEffort !== 'auto' && `${effortLabel(settings.reasoningEffort)} effort`,
    settings.cap && `$${settings.cap} cap`,
    settings.securityMode !== defaultMode &&
      KEYS.find(([mode]) => mode === settings.securityMode)?.[1],
    settings.privacyRoute === 'external' && 'Providers may keep data'
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The few things worth choosing per message - the model, how hard it thinks, what it may spend,
 * which keys it holds - folded behind one button so the bar stays a single line.
 */
export default function AskOptions({
  settings,
  forTask,
  running,
  disabled,
  onModel,
  onEffort,
  onCap,
  onKeys,
  onPrivacy,
  onInterrupt,
  onAttach,
  onClose
}: {
  settings: AskSettings;
  forTask: boolean;
  running: boolean;
  disabled: boolean;
  onModel: (value: string) => void;
  onEffort: (value: TaskReasoningEffort) => void;
  onCap: (value: string) => void;
  onKeys: (value: Task['securityMode']) => void;
  onPrivacy: (value: 'external' | 'provider_zdr') => void;
  onInterrupt: (value: boolean) => void;
  /** Phones keep attaching here, so the bar has room to show what it is asking for. */
  onAttach?: (() => void) | undefined;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = panel.current;
    // The first control the owner can see: attaching sits here only on a phone.
    [...(element?.querySelectorAll<HTMLElement>('select, button, input') ?? [])]
      .find((control) => control.offsetParent !== null)
      ?.focus();
    const away = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!element?.contains(target) && !target?.closest('.ask-tune')) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    addEventListener('pointerdown', away);
    element?.addEventListener('keydown', escape);
    return () => {
      removeEventListener('pointerdown', away);
      element?.removeEventListener('keydown', escape);
    };
  }, [onClose]);
  return (
    <div
      ref={panel}
      id="ask-options"
      className="ask-options pane"
      role="dialog"
      aria-label="Options for this message"
    >
      {onAttach && (
        <button
          type="button"
          className="btn small ask-attach-row"
          disabled={disabled}
          onClick={onAttach}
        >
          <Paperclip /> Attach files
        </button>
      )}
      <label className="ask-option">
        <span>Model</span>
        <select
          value={settings.automatic ? '__automatic' : settings.modelId}
          disabled={disabled}
          onChange={(event) => onModel(event.target.value)}
        >
          <option value="">{forTask ? 'This goal’s model' : 'Your default model'}</option>
          {!forTask && <option value="__automatic">Chosen for the work</option>}
          {settings.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName}
            </option>
          ))}
        </select>
      </label>
      {settings.efforts.length > 1 && (
        <div className="ask-option">
          <span id="ask-effort">Effort</span>
          <div className="seg" role="group" aria-labelledby="ask-effort">
            {settings.efforts.map((effort) => (
              <button
                key={effort}
                type="button"
                aria-pressed={settings.reasoningEffort === effort}
                disabled={disabled}
                onClick={() => onEffort(effort)}
              >
                {effortLabel(effort)}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="ask-option">
        <span id="ask-keys">Keys</span>
        <div className="seg" role="group" aria-labelledby="ask-keys">
          {KEYS.map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={settings.securityMode === mode}
              disabled={disabled}
              onClick={() => onKeys(mode)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <label className="ask-option">
        <span>{forTask ? 'Extra it may spend' : 'It may spend up to'}</span>
        <span className="ask-money">
          $
          <input
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            value={settings.cap}
            placeholder={forTask ? 'nothing extra' : 'your default'}
            disabled={disabled}
            onChange={(event) => onCap(event.target.value)}
          />
        </span>
      </label>
      {forTask && running && (
        <div className="ask-option">
          <span id="ask-timing">Arrives</span>
          <div className="seg" role="group" aria-labelledby="ask-timing">
            <button
              type="button"
              aria-pressed={settings.interrupt}
              onClick={() => onInterrupt(true)}
            >
              Now, mid-step
            </button>
            <button
              type="button"
              aria-pressed={!settings.interrupt}
              onClick={() => onInterrupt(false)}
            >
              After this step
            </button>
          </div>
        </div>
      )}
      {!settings.privacyLocked && (
        <label className="ask-check">
          <input
            type="checkbox"
            checked={settings.privacyRoute === 'provider_zdr'}
            disabled={disabled}
            onChange={(event) => onPrivacy(event.target.checked ? 'provider_zdr' : 'external')}
          />
          Only providers that keep nothing
        </label>
      )}
    </div>
  );
}
