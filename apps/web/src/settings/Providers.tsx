import { useId, useState } from 'react';
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
import { dollarsLeft, money, type Bootstrap } from '../model.js';
import { Plus } from '../icons';
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
type Usage = NonNullable<Bootstrap['usage']['plan']>;
interface Provider {
  configured: boolean;
  /** The name the server gives this connection, the same one the usage strip uses. */
  name?: string;
  /** What the provider's own account endpoint says is left, where it says. */
  usage?: Usage | null;
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
  localEndpoint?: boolean;
  enforceZeroDataRetention: boolean;
  contextTokens?: number;
  capabilities?: string[];
  modalities?: string[];
}
/** Which saved connection a catalogue row travels through. */
const routeOfModel = (model: ModelRelease): string =>
  model.connectionId ??
  (model.provider === 'openrouter'
    ? 'openrouter'
    : // Read defensively: a thin row from an older server may carry no tags at all.
      (Array.isArray(model.recommendationTags) ? model.recommendationTags : []).includes(
          'Ollama Cloud'
        )
      ? 'ollama-cloud'
      : model.provider === 'custom'
        ? 'openai-compatible'
        : model.provider);

/** A connection's balance in a few words, or null when its provider publishes none. */
const balanceText = (usage: Usage | null | undefined): string | null => {
  const windows = usage?.windows ?? [];
  const dollars = windows
    .map((window) => dollarsLeft(window))
    .filter((left): left is number => left !== null);
  if (dollars.length) return `${money(Math.min(...dollars))} left`;
  const share = windows.find((window) => window.unit === 'fraction' && window.used !== null);
  return share ? `${Math.round(share.used! * 100)}% of ${share.label.toLowerCase()} used` : null;
};

export function ProviderSettings({ onChange }: { onChange: () => void }) {
  const rowId = useId();
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
  /** The connection whose settings are open, or '' when none is. */
  const [choice, setChoice] = useState('');
  const [vendorChoice, setVendorChoice] = useState('');
  const [adding, setAdding] = useState(false);
  const [addingLocal, setAddingLocal] = useState(false);
  const [mediaSelections, setMediaSelections] = useState<Record<string, string>>({});
  const mediaAction = useAction(() => onChange());
  const connections = provider.value?.connections ?? [];
  const selected = choice;
  const saved = connections.find((entry) => (entry.connectionId ?? entry.provider) === selected);
  const localEndpoint = saved?.localEndpoint ?? addingLocal;
  const selectedProvider =
    saved?.provider ?? (selected.startsWith('openai-compatible:') ? 'openai-compatible' : selected);
  const vendors = provider.value?.vendors ?? [];
  const vendor = vendors.find((entry) => entry.id === (saved ? saved.vendor : vendorChoice));
  const connectionName = (entry: Provider) =>
    entry.name?.trim() ||
    entry.label?.trim() ||
    vendors.find((known) => known.id === entry.vendor)?.label ||
    (entry.provider === 'openrouter'
      ? 'OpenRouter'
      : entry.provider === 'ollama-cloud'
        ? 'Ollama Cloud'
        : 'Compatible endpoint');
  /** Open one connection's settings, or start a new one of the kind picked from the tiles. */
  const open = (value: string) => {
    setAdding(false);
    setAddingLocal(value === 'local');
    if (value.startsWith('vendor:')) {
      setVendorChoice(value.slice('vendor:'.length));
      setChoice(`openai-compatible:${crypto.randomUUID()}`);
      return;
    }
    setVendorChoice('');
    setChoice(
      value === 'custom' || value === 'local' ? `openai-compatible:${crypto.randomUUID()}` : value
    );
  };
  const close = () => {
    setChoice('');
    setVendorChoice('');
  };
  // With nothing connected yet, the choice of provider is the first thing on the screen.
  const picking = adding || (!selected && provider.value !== undefined && !connections.length);
  const modelCount = (id: string) =>
    (models.value ?? []).filter((model) => routeOfModel(model) === id).length;
  const heading = saved
    ? connectionName(saved)
    : vendor
      ? `Connect ${vendor.label}`
      : selectedProvider === 'openrouter'
        ? 'Connect OpenRouter'
        : selectedProvider === 'ollama-cloud'
          ? 'Connect Ollama Cloud'
          : localEndpoint
            ? 'Connect local models'
            : 'Connect an endpoint';
  const keyUrl =
    vendor?.keyUrl ??
    (selectedProvider === 'openrouter'
      ? 'https://openrouter.ai/settings/keys'
      : selectedProvider === 'ollama-cloud'
        ? 'https://ollama.com/settings/keys'
        : null);
  const keyHolder =
    vendor?.label ??
    (selectedProvider === 'openrouter'
      ? 'OpenRouter'
      : selectedProvider === 'ollama-cloud'
        ? 'Ollama'
        : null);
  // A listed company's address, window and capabilities are known, so they wait behind Advanced;
  // an endpoint of the owner's own needs them said.
  const technical = (
    <>
      <Field
        label="Restrict to model ID"
        hint="Optional. Leave empty to discover every model this endpoint offers."
      >
        <input name="modelId" defaultValue={saved?.modelId ?? ''} />
      </Field>
      <Field
        label="Context window in tokens"
        {...(localEndpoint
          ? {
              hint: 'Match the context size configured in your inference server. Garden does not change it. Choose a model with tool calling support.'
            }
          : {})}
      >
        <input
          name="contextTokens"
          type="number"
          min={4096}
          max={10000000}
          defaultValue={
            saved?.contextTokens ?? vendor?.contextTokens ?? (localEndpoint ? 32768 : 128000)
          }
          required
        />
      </Field>
      <div className="stack">
        <label className="management-check">
          <input
            name="vision"
            type="checkbox"
            defaultChecked={saved?.capabilities?.includes('vision') ?? Boolean(vendor)}
          />
          Accepts images
        </label>
        <label className="management-check">
          <input
            name="reasoning"
            type="checkbox"
            defaultChecked={saved?.capabilities?.includes('reasoning') ?? !localEndpoint}
          />
          Supports reasoning
        </label>
      </div>
    </>
  );
  return (
    <>
      <Section
        title="Model connections"
        description="Your providers and local model servers, connected directly by your computer. Every connected provider's models appear together when you choose one."
      >
        <ResourceState resource={provider} />
        {connections.length > 0 && (
          <ul className="connection-list" aria-label="Connected providers">
            {connections.map((entry, index) => {
              const id = entry.connectionId ?? entry.provider;
              const count = modelCount(id);
              const balance = balanceText(entry.usage);
              const what = entry.vendor
                ? KNOWN_AS[entry.vendor]
                : entry.provider === 'openrouter'
                  ? 'every maker, one key'
                  : entry.provider === 'ollama-cloud'
                    ? 'open models on a plan'
                    : entry.baseUrl.replace(/^https?:\/\//, '');
              const detail = [
                what,
                count ? `${count} ${count === 1 ? 'model' : 'models'}` : null,
                balance ??
                  (entry.source === 'server_environment'
                    ? 'from server configuration'
                    : entry.hasApiKey
                      ? 'key stored'
                      : 'no key')
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <li key={id}>
                  <button
                    type="button"
                    className="connection-row cursor-row"
                    aria-label={connectionName(entry)}
                    aria-describedby={`${rowId}-row-${index}`}
                    aria-pressed={selected === id}
                    onClick={() => open(id)}
                  >
                    <strong>{connectionName(entry)}</strong>
                    <small id={`${rowId}-row-${index}`}>{detail}</small>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {!picking && (
          <Button
            type="button"
            onClick={() => {
              close();
              setAdding(true);
            }}
          >
            <Plus size={15} /> Add a provider
          </Button>
        )}
        {picking && (
          <div className="stack">
            <p className="muted">
              {connections.length
                ? 'Choose a provider to add alongside the others.'
                : 'Choose a provider to start. You can add more at any time.'}
            </p>
            <div className="provider-tiles" role="group" aria-label="Providers">
              {[
                {
                  value: 'openrouter',
                  label: 'OpenRouter',
                  note: 'every maker, one key'
                },
                ...vendors.map((entry) => ({
                  value: `vendor:${entry.id}`,
                  label: entry.label,
                  note: KNOWN_AS[entry.id] ?? ''
                })),
                { value: 'ollama-cloud', label: 'Ollama Cloud', note: 'open models on a plan' },
                {
                  value: 'local',
                  label: 'Local models',
                  note: 'Ollama or a compatible local server'
                },
                { value: 'custom', label: 'Other endpoint', note: 'any OpenAI-compatible address' }
              ].map((tile, index) => (
                <button
                  key={tile.value}
                  type="button"
                  className="provider-tile"
                  aria-label={tile.label}
                  aria-describedby={`${rowId}-tile-${index}`}
                  onClick={() => open(tile.value)}
                >
                  <strong>{tile.label}</strong>
                  <small id={`${rowId}-tile-${index}`}>{tile.note}</small>
                </button>
              ))}
            </div>
            {connections.length > 0 && (
              <Button type="button" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            )}
          </div>
        )}
        {selected && provider.value && preferences.value && (
          <form
            className="stack connection-form"
            aria-label={heading}
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
                    localEndpoint,
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
            <h3>{heading}</h3>
            {localEndpoint && (
              <p className="management-note">
                Run Ollama on your Garden server, or enter the private IP of another computer on its
                network. The address is reached from the Garden server; localhost means that server.
                Install a tool-capable model first. No API key is needed for a standard Ollama
                installation.
              </p>
            )}
            {saved && saved.configured !== false && (
              <p className="management-note">
                {`Connected through ${saved.source === 'server_environment' ? 'server configuration' : 'your saved settings'}. ${saved.hasApiKey ? 'A key is securely stored.' : 'This endpoint uses no saved key.'}`}
              </p>
            )}
            <div className="management-grid">
              <Field
                label="API key"
                {...(saved?.hasApiKey
                  ? {
                      hint: 'Leave empty to keep this connection’s key. Changing its endpoint requires a new key.'
                    }
                  : {})}
              >
                <input
                  name="apiKey"
                  type="password"
                  autoComplete="new-password"
                  placeholder={saved?.hasApiKey ? 'Stored securely' : 'Paste your key'}
                  required={Boolean(vendor) && !saved?.hasApiKey}
                />
              </Field>
              {keyUrl && keyHolder && (
                <p className="management-note">
                  <a href={keyUrl} target="_blank" rel="noreferrer">
                    Get a key from {keyHolder}
                  </a>{' '}
                  and paste it here. Every model the key can use is listed, and requests go straight
                  to {keyHolder}.
                  {(vendor?.id === 'anthropic' || vendor?.id === 'openai') &&
                    ` A ${vendor.id === 'anthropic' ? 'Claude' : 'ChatGPT'} plan is not an API key: to put your plan to work, ask garden to set up ${vendor.id === 'anthropic' ? 'Claude Code' : 'Codex'} and sign in from the Terminal, and it will hand coding work to it.`}
                </p>
              )}
              {selectedProvider === 'openai-compatible' && (
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
                    defaultValue={saved?.label ?? (localEndpoint ? 'Local Ollama' : '')}
                    placeholder={vendor?.label ?? 'Work models'}
                  />
                </Field>
              )}
              {selectedProvider === 'openai-compatible' && !vendor && (
                <>
                  <Field label="Endpoint URL">
                    <input
                      required
                      name="baseUrl"
                      type="url"
                      defaultValue={
                        saved?.baseUrl ?? (localEndpoint ? 'http://127.0.0.1:11434/v1' : '')
                      }
                      placeholder="https://provider.example/v1"
                    />
                  </Field>
                  {technical}
                </>
              )}
            </div>
            {selectedProvider === 'openai-compatible' && vendor && (
              <details className="stack">
                <summary>Advanced</summary>
                <div className="management-grid">{technical}</div>
              </details>
            )}
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
                  speeds, and left alone OpenRouter picks among the cheapest — which for agent work
                  is usually the slowest. Your computer asks for the cheapest company that still
                  reaches a share of the fastest one's speed on that model. Both comparisons are
                  OpenRouter's own, across every request it serves. Companies that log or retain
                  your data are already excluded by the zero-data-retention setting.
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
                      <option value="cheapest_fast_enough">The cheapest that is fast enough</option>
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
                        preferences.value?.preferences.providerRouting?.throughputFloorPercent ?? 40
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
                    close();
                    provider.refresh();
                    models.refresh();
                    onChange();
                  }}
                />
              )}
              <Button type="button" onClick={close}>
                {saved ? 'Close' : 'Cancel'}
              </Button>
            </div>
            <ActionFeedback action={action} />
          </form>
        )}
      </Section>
      <Section
        title="Model defaults"
        description="Choose the main agent and the models behind its specialist work. New projects inherit these defaults."
      >
        <DefaultModels connectionRevision={connectionRevision} onChange={onChange} />
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
        <summary>Audio generation history</summary>
        <AudioReceipts />
      </details>
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
