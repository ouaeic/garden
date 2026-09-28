import { useState } from 'react';
import type { MediaSettings, ModelRelease, OwnerPreferences } from '@garden/contracts';
import { del, put } from '../client.js';
import { Button, Field } from '../ui.js';
import {
  ActionFeedback,
  ConfirmButton,
  ResourceState,
  Section,
  fieldValue,
  sensitive,
  useAction,
  useResource
} from '../management.js';
import { money } from '../model.js';
import { mediaRouteIsRetired, mediaRetirementDate } from '../media-state.js';
import AudioReceipts from '../AudioReceipts';
import DefaultModels from './DefaultModels.js';
import ModelCatalog from './ModelCatalog.js';
import ModelPicker from '../ModelPicker.js';

interface Vendor {
  id: string;
  label: string;
  maker: string;
  baseUrl: string;
  keyUrl: string;
  contextTokens: number;
}
/** What each listed company's models are known as, so the owner finds the one they came for. */
const KNOWN_AS: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'GPT and o-series, the models behind ChatGPT',
  google: 'Gemini',
  xai: 'Grok',
  mistral: 'Mistral and Codestral',
  deepseek: 'DeepSeek',
  groq: 'fast open models',
  together: 'open models',
  fireworks: 'open models',
  cerebras: 'fast open models',
  moonshot: 'Kimi',
  qwen: 'Qwen'
};
interface Provider {
  configured: boolean;
  vendor?: string | null;
  vendors?: Vendor[];
  connectionId?: string;
  label?: string | null;
  connections?: Provider[];
  source: string;
  provider: string;
  baseUrl: string;
  modelId: string | null;
  hasApiKey: boolean;
  enforceZeroDataRetention: boolean;
  contextTokens?: number;
  capabilities?: string[];
  modalities?: string[];
}
export function ProviderSettings({ onChange }: { onChange: () => void }) {
  const provider = useResource<Provider>('/v1/providers');
  const models = useResource<ModelRelease[]>('/v1/models');
  const media = useResource<MediaSettings>('/v1/media/models');
  const preferences = useResource<{ preferences: OwnerPreferences }>('/v1/account/preferences');
  const [connectionRevision, setConnectionRevision] = useState(0);
  const action = useAction(() => {
    setConnectionRevision((value) => value + 1);
    provider.refresh();
    models.refresh();
    media.refresh();
    preferences.refresh();
    onChange();
  });
  const [choice, setChoice] = useState('');
  const [vendorChoice, setVendorChoice] = useState('');
  const [mediaSelections, setMediaSelections] = useState<Record<string, string>>({});
  const mediaAction = useAction(() => onChange());
  const selected =
    choice || provider.value?.connectionId || provider.value?.provider || 'openrouter';
  const saved =
    provider.value?.connections?.find(
      (entry) => (entry.connectionId ?? entry.provider) === selected
    ) ??
    ((provider.value?.connectionId ?? provider.value?.provider) === selected
      ? provider.value
      : undefined);
  const selectedProvider =
    saved?.provider ?? (selected.startsWith('openai-compatible:') ? 'openai-compatible' : selected);
  const vendors = provider.value?.vendors ?? [];
  const vendor = vendors.find((entry) => entry.id === (saved ? saved.vendor : vendorChoice));
  const connectionName = (entry: Provider) =>
    entry.label ??
    vendors.find((known) => known.id === entry.vendor)?.label ??
    (entry.provider === 'openrouter'
      ? 'OpenRouter'
      : entry.provider === 'ollama-cloud'
        ? 'Ollama Cloud'
        : 'Compatible endpoint');
  const pick = (value: string) => {
    if (value.startsWith('vendor:')) {
      setVendorChoice(value.slice('vendor:'.length));
      setChoice(`openai-compatible:${crypto.randomUUID()}`);
      return;
    }
    setVendorChoice('');
    setChoice(value);
  };
  return (
    <>
      <Section
        title="Model defaults"
        description="Choose the main agent and the models behind its specialist work. New projects inherit these defaults."
      >
        <DefaultModels connectionRevision={connectionRevision} onChange={onChange} />
      </Section>
      <details className="settings-disclosure">
        <summary>Audio generation history</summary>
        <AudioReceipts />
      </details>
      <Section
        title="Model connections"
        description="Bring your own provider. Your computer uses your credentials directly."
      >
        <ResourceState resource={provider} />
        <p className="connection-summary">
          {provider.value?.configured
            ? 'Connected · Your provider credentials are stored on your computer.'
            : 'Connect a provider to start working.'}
        </p>
        <details className="settings-disclosure" open={provider.value?.configured === false}>
          <summary>Manage model connections</summary>
          {Boolean(provider.value?.connections?.length) && (
            <div className="row model-connection-tabs" aria-label="Saved model connections">
              {provider.value?.connections?.map((entry) => (
                <Button
                  key={entry.connectionId ?? entry.provider}
                  type="button"
                  aria-pressed={selected === (entry.connectionId ?? entry.provider)}
                  onClick={() => {
                    setVendorChoice('');
                    setChoice(entry.connectionId ?? entry.provider);
                  }}
                >
                  {connectionName(entry)}
                </Button>
              ))}
            </div>
          )}
          <Button
            type="button"
            onClick={() => {
              setVendorChoice('');
              setChoice(`openai-compatible:${crypto.randomUUID()}`);
            }}
          >
            Add a provider
          </Button>
          {provider.value && preferences.value && (
            <form
              className="stack"
              key={selected + (vendor?.id ?? '') + (saved?.baseUrl ?? '') + (saved?.modelId ?? '')}
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                const apiKey = fieldValue(form, 'apiKey');
                void action.run(async () => {
                  await sensitive(() =>
                    put('/v1/providers', {
                      provider: selectedProvider,
                      connectionId: selected,
                      ...(selectedProvider === 'openai-compatible'
                        ? { label: fieldValue(form, 'label') }
                        : {}),
                      ...(apiKey ? { apiKey } : {}),
                      ...(selectedProvider === 'openai-compatible'
                        ? {
                            ...(vendor
                              ? { vendor: vendor.id }
                              : { baseUrl: fieldValue(form, 'baseUrl') }),
                            ...(fieldValue(form, 'modelId')
                              ? { modelId: fieldValue(form, 'modelId') }
                              : {}),
                            contextTokens: Number(form.get('contextTokens')),
                            capabilities: [
                              'chat',
                              'tools',
                              ...(form.has('vision') ? ['vision'] : []),
                              ...(form.has('reasoning') ? ['reasoning'] : [])
                            ],
                            modalities: ['text', ...(form.has('vision') ? ['image'] : [])]
                          }
                        : {}),
                      enforceZeroDataRetention: form.has('zdr')
                    })
                  );
                  if (selectedProvider === 'openrouter') {
                    try {
                      await put('/v1/account/preferences', {
                        providerRouting: {
                          objective: fieldValue(form, 'routingObjective'),
                          throughputFloorPercent: Number(form.get('throughputFloorPercent') ?? 40),
                          ignoredProviders: fieldValue(form, 'ignoredProviders')
                            .split(',')
                            .map((name) => name.trim())
                            .filter(Boolean)
                        }
                      });
                    } catch (cause) {
                      throw new Error(
                        'Connection saved, but operator routing was not saved. Retry Verify and save.',
                        { cause }
                      );
                    }
                  }
                }, 'Connection and routing verified and saved');
              }}
            >
              <div className="management-note">
                {saved && saved.configured !== false
                  ? `Connected through ${saved?.source === 'server_environment' ? 'server configuration' : 'your saved settings'}. ${saved?.hasApiKey ? 'A key is securely stored.' : 'This endpoint uses no saved key.'}`
                  : 'Add this provider alongside your other connections. Every connected provider’s models appear together when you choose one.'}
              </div>
              <div className="management-grid">
                <Field label="Provider">
                  <select
                    value={vendor ? `vendor:${vendor.id}` : selectedProvider}
                    disabled={Boolean(saved) && selected !== selectedProvider}
                    onChange={(event) => pick(event.target.value)}
                  >
                    <option value="openrouter">OpenRouter · every maker with one key</option>
                    {vendors.length > 0 && (
                      <optgroup label="Direct from the maker">
                        {vendors.map((entry) => (
                          <option key={entry.id} value={`vendor:${entry.id}`}>
                            {entry.label}
                            {KNOWN_AS[entry.id] ? ` · ${KNOWN_AS[entry.id]}` : ''}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <option value="ollama-cloud">Ollama Cloud</option>
                    <option value="openai-compatible">Compatible endpoint</option>
                  </select>
                </Field>
                <Field
                  label="API key"
                  hint="Leave empty to keep this connection’s key. Changing its endpoint requires a new key."
                >
                  <input
                    name="apiKey"
                    type="password"
                    autoComplete="new-password"
                    placeholder={saved?.hasApiKey ? 'Stored securely' : 'Paste your key'}
                    required={Boolean(vendor) && !saved?.hasApiKey}
                  />
                </Field>
                {vendor && (
                  <p className="management-note">
                    <a href={vendor.keyUrl} target="_blank" rel="noreferrer">
                      Get a key from {vendor.label}
                    </a>{' '}
                    and paste it here. Every model the key can use is listed, and requests go
                    straight to {vendor.label}.
                    {(vendor.id === 'anthropic' || vendor.id === 'openai') &&
                      ` A ${vendor.id === 'anthropic' ? 'Claude' : 'ChatGPT'} chat subscription does not include API access; the key is billed separately.`}
                  </p>
                )}
                {selectedProvider === 'openai-compatible' && (
                  <>
                    <Field
                      label="Connection name"
                      hint={
                        vendor
                          ? `Optional. Name a second ${vendor.label} key to tell them apart.`
                          : 'Optional. A named connection uses its endpoint hostname by default.'
                      }
                    >
                      <input
                        name="label"
                        maxLength={80}
                        defaultValue={saved?.label ?? ''}
                        placeholder={vendor?.label ?? 'Work models'}
                      />
                    </Field>
                    {!vendor && (
                      <Field label="Endpoint URL">
                        <input
                          required
                          name="baseUrl"
                          type="url"
                          defaultValue={saved?.baseUrl ?? ''}
                          placeholder="https://provider.example/v1"
                        />
                      </Field>
                    )}
                    <Field
                      label="Restrict to model ID"
                      hint="Optional. Leave empty to discover every model this endpoint offers."
                    >
                      <input name="modelId" defaultValue={saved?.modelId ?? ''} />
                    </Field>
                    <Field label="Context window in tokens">
                      <input
                        name="contextTokens"
                        type="number"
                        min={4096}
                        max={10000000}
                        defaultValue={saved?.contextTokens ?? vendor?.contextTokens ?? 128000}
                        required
                      />
                    </Field>
                    <div className="stack">
                      <label className="management-check">
                        <input
                          name="vision"
                          type="checkbox"
                          defaultChecked={
                            saved?.capabilities?.includes('vision') ?? Boolean(vendor)
                          }
                        />
                        Accepts images
                      </label>
                      <label className="management-check">
                        <input
                          name="reasoning"
                          type="checkbox"
                          defaultChecked={saved?.capabilities?.includes('reasoning') ?? true}
                        />
                        Supports reasoning
                      </label>
                    </div>
                  </>
                )}
              </div>
              {selectedProvider === 'openrouter' && (
                /*
                 * Which operator serves a model, when several do.
                 *
                 * The aggregator lists a handful for most models at different prices and wildly
                 * different speeds, and given no preference it picks among the cheapest weighted by
                 * the inverse square of price - so a model whose fastest operator runs at 142 tokens
                 * a second and whose cheapest runs at 3 lands on the second one most of the time. For
                 * a chat box that is a slower reply; for an agent it is a task that takes a day
                 * instead of twenty minutes, because a turn is dozens of sequential calls.
                 *
                 * Behind a disclosure because the defaults are the right answer for almost everyone,
                 * and open to be edited because the trade is the owner's to make.
                 */
                <details className="stack">
                  <summary>Which operator serves a model</summary>
                  <p className="muted">
                    Several companies serve most models, at different prices and very different
                    speeds, and left alone OpenRouter picks among the cheapest — which for agent
                    work is usually the slowest. Your computer asks for the cheapest company that
                    still reaches a share of the fastest one's speed on that model. Both comparisons
                    are OpenRouter's own, across every request it serves. Companies that log or
                    retain your data are already excluded by the zero-data-retention setting.
                  </p>
                  <div className="management-grid">
                    <Field label="Choose">
                      <select
                        name="routingObjective"
                        defaultValue={
                          preferences.value?.preferences.providerRouting?.objective ??
                          'cheapest_fast_enough'
                        }
                      >
                        <option value="cheapest_fast_enough">
                          The cheapest that is fast enough
                        </option>
                        <option value="fastest">The fastest, whatever it costs</option>
                        <option value="cheapest">The cheapest, however slow</option>
                      </select>
                    </Field>
                    <Field
                      label="Fast enough means"
                      hint="Percentage of the speed the quickest company reaches on that model, so it scales with what the model can actually do."
                    >
                      <input
                        name="throughputFloorPercent"
                        type="number"
                        min={0}
                        max={100}
                        defaultValue={
                          preferences.value?.preferences.providerRouting?.throughputFloorPercent ??
                          40
                        }
                      />
                    </Field>
                    <Field label="Never use" hint="Operator names, separated by commas.">
                      <input
                        name="ignoredProviders"
                        placeholder="e.g. Together, Chutes"
                        defaultValue={(
                          preferences.value?.preferences.providerRouting?.ignoredProviders ?? []
                        ).join(', ')}
                      />
                    </Field>
                  </div>
                </details>
              )}
              <label className="management-check">
                <input
                  name="zdr"
                  type="checkbox"
                  defaultChecked={saved?.enforceZeroDataRetention ?? true}
                />
                <span>
                  Require zero data retention
                  <small className="muted">
                    Use only the provider route approved for this privacy choice.
                  </small>
                </span>
              </label>
              <div className="row">
                <Button type="submit" className="primary" busy={action.busy}>
                  Verify and save
                </Button>
                {saved?.source === 'encrypted_database' && (
                  <ConfirmButton
                    label="Remove saved connection"
                    description="Remove this saved connection. Tasks that need it will wait until it is connected again. Other saved providers remain available."
                    action={async () => {
                      await sensitive(() =>
                        del(`/v1/providers?connectionId=${encodeURIComponent(selected)}`)
                      );
                      provider.refresh();
                      models.refresh();
                      onChange();
                    }}
                  />
                )}
              </div>
              <ActionFeedback action={action} />
            </form>
          )}
        </details>
      </Section>
      <Section
        title="Images, video, voice and transcription"
        description="Choose from the generation routes your provider makes available."
      >
        <ResourceState resource={media} />
        {media.value && (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void mediaAction.run(async () => {
                const choices = Object.fromEntries(
                  media.value!.modalities.flatMap((item) => {
                    if (!item.available) return [[item.modality, item.choice]];
                    const modelId =
                      mediaSelections[item.modality] ??
                      (item.choice.automatic ? '' : item.choice.modelId);
                    const option = item.options.find((candidate) => candidate.id === modelId);
                    if (mediaRouteIsRetired(option) || option?.unavailableReason) {
                      if (!item.choice.automatic && modelId === item.choice.modelId)
                        return [[item.modality, item.choice]];
                      throw new Error(
                        option?.unavailableReason ??
                          'This generation route has retired. Choose an available model.'
                      );
                    }
                    return [
                      [
                        item.modality,
                        {
                          automatic: modelId === '',
                          preference: fieldValue(form, `${item.modality}-preference`),
                          modelId
                        }
                      ]
                    ];
                  })
                );
                const saved = await put<MediaSettings>('/v1/media/models', choices);
                media.setValue(saved);
                setMediaSelections({});
              }, 'Generation choices saved');
            }}
          >
            <div className="stack">
              {media.value.modalities.map((item) => {
                const modelId =
                  mediaSelections[item.modality] ??
                  (item.choice.automatic ? '' : item.choice.modelId);
                const selectedOption = modelId
                  ? item.options.find((option) => option.id === modelId)
                  : item.effective;
                return (
                  <div key={item.modality}>
                    <h4>{item.modality[0]!.toUpperCase() + item.modality.slice(1)}</h4>
                    {selectedOption?.retirementAt && (
                      <p className="muted span-all" role="status">
                        {mediaRouteIsRetired(selectedOption) ? 'Retired' : 'Scheduled to retire'} on{' '}
                        {mediaRetirementDate(selectedOption.retirementAt)} (UTC). Existing job
                        records and recovery controls remain available. No replacement is selected
                        automatically.
                      </p>
                    )}
                    {selectedOption?.unavailableReason && (
                      <p className="muted span-all">{selectedOption.unavailableReason}</p>
                    )}

                    {!item.available ? (
                      <p className="muted">{item.reason ?? 'No compatible route is available.'}</p>
                    ) : (
                      <div className="management-grid">
                        <div className="field">
                          <span>{item.modality} model</span>
                          <ModelPicker
                            label={`${item.modality} model`}
                            value={modelId}
                            models={item.options}
                            disabled={mediaAction.busy}
                            shortcuts={[{ value: '', label: 'Automatic' }]}
                            onChange={(value) =>
                              setMediaSelections((values) => ({
                                ...values,
                                [item.modality]: value
                              }))
                            }
                          />
                        </div>
                        <Field label={`${item.modality} preference`}>
                          <select
                            name={`${item.modality}-preference`}
                            defaultValue={item.choice.preference}
                          >
                            <option value="balanced">Balanced</option>
                            <option value="fast">Faster</option>
                            <option value="best">Higher quality</option>
                          </select>
                        </Field>
                        <p className="muted span-all">
                          {selectedOption
                            ? `${selectedOption.displayName}. ${selectedOption.usdPerImage !== null ? `${money(selectedOption.usdPerImage)} per image.` : selectedOption.usdPerSecond != null ? `From ${money(selectedOption.usdPerSecond)} per second.` : selectedOption.usdPerMinute !== null ? `${money(selectedOption.usdPerMinute)} per minute.` : selectedOption.usdPerMillionCharacters !== null ? `${money(selectedOption.usdPerMillionCharacters)} per million characters.` : 'Pricing depends on the request.'}`
                            : 'No effective route selected.'}
                        </p>
                        {selectedOption?.requiresRetentionApproval && (
                          <p className="muted span-all">
                            Each video job asks before temporary retention at the provider, and
                            shows the quoted cost before generation.
                          </p>
                        )}
                        {selectedOption?.capabilities &&
                          Object.keys(selectedOption.capabilities.parameters).length > 0 && (
                            <details className="span-all">
                              <summary>Available controls for {selectedOption.displayName}</summary>
                              <dl className="garden-provider-controls">
                                {Object.entries(selectedOption.capabilities.parameters).map(
                                  ([name, parameter]) => (
                                    <div key={name}>
                                      <dt>{name.replaceAll('_', ' ')}</dt>
                                      <dd>
                                        {parameter.type === 'enum'
                                          ? parameter.values.join(' · ')
                                          : parameter.type === 'range'
                                            ? `${parameter.min}–${parameter.max}`
                                            : 'On / off'}
                                      </dd>
                                    </div>
                                  )
                                )}
                              </dl>
                            </details>
                          )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="muted">
              Further generation asks for approval after the conversation reaches{' '}
              {money(media.value.approvalThresholdUsd)} in generation costs.
            </p>
            <Button type="submit" busy={mediaAction.busy}>
              Save generation choices
            </Button>
            <ActionFeedback action={mediaAction} />
          </form>
        )}
      </Section>
      <details className="settings-disclosure">
        <summary>Explore the full model catalog</summary>{' '}
        <Section
          title="Model catalog"
          description="Availability, context and pricing from the connected catalog."
        >
          <ResourceState resource={models} />
          {models.value && <ModelCatalog models={models.value} />}
        </Section>
      </details>
    </>
  );
}
