import type {
  ModelPurpose,
  ProjectModelChoices,
  ProjectModelPreferences,
  PurposeModelChoice
} from '@athanor/contracts';
import ModelPicker from './ModelPicker.js';
import { Field } from './ui.js';
import './model-choices.css';

export const purposeLabels: Record<ModelPurpose, string> = {
  main: 'Main agent',
  specialist: 'Research specialists',
  coding: 'Coding agents',
  decisions: 'Decisions',
  image: 'Images',
  audio: 'Speech',
  transcription: 'Transcription',
  video: 'Video',
  summarise: 'Condensing long work',
  title: 'Naming a conversation'
};
export const automaticChoice: PurposeModelChoice = {
  automatic: true,
  preference: 'balanced',
  modelId: ''
};
export const textPurposes = [
  'main',
  'specialist',
  'coding',
  'decisions',
  'summarise',
  'title'
] as const;
const descriptions: Record<ModelPurpose, string> = {
  main: 'Leads the work and brings the results together.',
  specialist: 'Researches and reviews delegated work.',
  coding: 'Makes and verifies code changes.',
  decisions: 'Resolves focused choices quickly as the work unfolds.',
  summarise: 'Keeps the working context concise.',
  title: 'Names your conversations.',
  image: 'Generates and edits images.',
  audio: 'Turns text into speech.',
  transcription: 'Turns recorded speech into text.',
  video: 'Generates video.'
};
export default function ModelChoiceFields({
  purposes,
  choices,
  onChange,
  disabled,
  inherit = true,
  inheritLabel = 'Use global choice',
  inheritDetail = 'Follow your defaults in Settings.'
}: {
  purposes: ProjectModelPreferences['purposes'];
  choices: ProjectModelChoices;
  onChange: (choices: ProjectModelChoices) => void;
  disabled?: boolean | undefined;
  inherit?: boolean;
  inheritLabel?: string;
  inheritDetail?: string;
}) {
  const change = (purpose: ModelPurpose, choice: PurposeModelChoice | undefined) => {
    const next = { ...choices };
    if (choice) next[purpose] = choice;
    else delete next[purpose];
    onChange(next);
  };
  return (
    <div className="model-choice-grid">
      {purposes.map((item) => {
        const selected = choices[item.purpose];
        const value = !selected
          ? inherit
            ? 'inherit'
            : 'automatic'
          : selected.automatic
            ? 'automatic'
            : selected.modelId;
        const same = JSON.stringify(selected ?? automaticChoice) === JSON.stringify(item.choice);
        const effective =
          value === 'inherit'
            ? item.source !== 'project'
              ? item.effective
              : null
            : value === 'automatic'
              ? same
                ? item.effective
                : null
              : item.options.find((option) => option.id === value);
        return (
          <section
            className="model-choice-card"
            key={item.purpose}
            aria-label={purposeLabels[item.purpose]}
          >
            <div>
              <h3>{purposeLabels[item.purpose]}</h3>
              <p className="muted">{descriptions[item.purpose]}</p>
            </div>
            <ModelPicker
              label={purposeLabels[item.purpose]}
              value={value}
              models={item.options}
              disabled={disabled}
              shortcuts={[
                ...(inherit
                  ? [
                      {
                        value: 'inherit',
                        label: inheritLabel,
                        detail: inheritDetail
                      }
                    ]
                  : []),
                {
                  value: 'automatic',
                  label: 'Automatic',
                  detail: 'Choose an available model for this purpose.'
                }
              ]}
              onChange={(next) =>
                change(
                  item.purpose,
                  next === 'inherit'
                    ? undefined
                    : {
                        automatic: next === 'automatic',
                        modelId: next === 'automatic' ? '' : next,
                        preference: selected?.preference ?? item.choice.preference
                      }
                )
              }
            />
            {value === 'automatic' &&
              item.purpose !== 'summarise' &&
              item.purpose !== 'title' &&
              item.purpose !== 'decisions' && (
                <Field label={`${purposeLabels[item.purpose]} preference`}>
                  <select
                    value={selected?.preference ?? 'balanced'}
                    disabled={disabled}
                    onChange={(event) =>
                      change(item.purpose, {
                        ...automaticChoice,
                        preference: event.target.value as PurposeModelChoice['preference']
                      })
                    }
                  >
                    <option value="balanced">Balanced</option>
                    <option value="fast">Faster</option>
                    <option value="best">Higher quality</option>
                  </select>
                </Field>
              )}
            <p className="model-choice-resolution muted">
              {effective
                ? `${value === 'inherit' ? 'Inherits' : value === 'automatic' ? 'Currently' : 'Selected'}: ${effective.displayName}`
                : value === 'inherit'
                  ? inheritDetail
                  : value === 'automatic' && !same
                    ? 'Resolves when applied.'
                    : (item.reason ?? 'This saved model is unavailable.')}
            </p>
            {effective && 'unavailableReason' in effective && effective.unavailableReason && (
              <p className="model-unavailable">{effective.unavailableReason}</p>
            )}
            {effective &&
              'requiresRetentionApproval' in effective &&
              effective.requiresRetentionApproval && (
                <p className="muted">Each request asks before temporary provider retention.</p>
              )}
          </section>
        );
      })}
    </div>
  );
}
