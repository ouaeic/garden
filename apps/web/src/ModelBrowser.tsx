import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Search, SlidersHorizontal } from './icons';
import { Button, Dialog, ErrorNotice } from './ui.js';
import type { ModelPickerProps, PickerModel } from './ModelPicker.js';
import { mediaRouteIsRetired } from './media-state.js';
import { get } from './client.js';
import { makerOf, providerOf, routeOf } from './model-makers.js';
import './model-choices.css';

const price = (value: number) =>
  `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
function details(model: PickerModel): string {
  return [
    model.contextTokens
      ? `${new Intl.NumberFormat(undefined, { notation: 'compact' }).format(model.contextTokens)} context`
      : '',
    model.modalities?.includes('image') ? 'Vision' : '',
    model.reasoning?.supportedEfforts?.length ? 'Adjustable reasoning' : '',
    model.inputUsdPerMillionTokens != null && model.outputUsdPerMillionTokens != null
      ? `${price(model.inputUsdPerMillionTokens)} in / ${price(model.outputUsdPerMillionTokens)} out per million tokens`
      : '',
    model.usdPerImage != null ? `${price(model.usdPerImage)} / image` : '',
    model.usdPerMinute != null ? `${price(model.usdPerMinute)} / minute` : '',
    model.usdPerSecond != null ? `From ${price(model.usdPerSecond)} / second` : '',
    model.usdPerMillionCharacters != null
      ? `${price(model.usdPerMillionCharacters)} / million characters`
      : ''
  ]
    .filter(Boolean)
    .join(' · ');
}
export default function ModelBrowser({
  label,
  value,
  models: providedModels,
  loadDetails = false,
  privacyRoute,
  shortcuts = [],
  disabled = false,
  embedded = false,
  onAdvanced,
  onChange,
  onClose
}: ModelPickerProps & { onClose: () => void; embedded?: boolean }) {
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const [active, setActive] = useState(0);
  const [catalogue, setCatalogue] = useState<PickerModel[]>([]);
  const [loading, setLoading] = useState(loadDetails);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!loadDetails) return;
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    const url = privacyRoute
      ? `/v1/models?purpose=main&privacyRoute=${privacyRoute}`
      : '/v1/models';
    void get<PickerModel[]>(url, { signal: controller.signal })
      .then((models) => {
        if (!controller.signal.aborted) setCatalogue(models);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [loadDetails, privacyRoute, attempt]);
  const models = useMemo(() => {
    if (loadDetails && !loading && !loadError) return catalogue;
    return providedModels;
  }, [providedModels, catalogue, loadDetails, loading, loadError]);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const providers = useMemo(() => [...new Set(models.map(providerOf))].sort(), [models]);
  const routes = useMemo(() => [...new Set(models.map(routeOf))].sort(), [models]);
  const rows = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (text: string) => words.every((word) => text.toLowerCase().includes(word));
    const inFilter = (model: PickerModel) => !provider || providerOf(model) === provider;
    const concrete = models
      .filter(
        (model) =>
          inFilter(model) &&
          matches(
            `${model.displayName} ${model.id} ${makerOf(model)} ${routeOf(model)} ${Array.isArray(model.capabilities) ? model.capabilities.join(' ') : ''}`
          )
      )
      .sort(
        (a, b) =>
          makerOf(a).localeCompare(makerOf(b)) ||
          a.displayName.localeCompare(b.displayName) ||
          routeOf(a).localeCompare(routeOf(b))
      )
      .map((model) => ({
        value: model.id,
        label: model.displayName,
        // The name the provider itself uses, which is what the owner would recognise or search for.
        identity: model.providerModelId ?? model.id,
        group: makerOf(model),
        route: routes.length > 1 ? routeOf(model) : '',
        detail: details(model),
        reason:
          (loading
            ? 'Checking availability and limits…'
            : loadError
              ? 'Availability could not be checked'
              : '') ||
          (mediaRouteIsRetired(model)
            ? 'This generation route has retired'
            : model.unavailableReason) ||
          (model.availability && model.availability !== 'available'
            ? model.availability.replaceAll('_', ' ')
            : '')
      }));
    return [
      ...shortcuts
        .filter((item) => !provider && matches(item.label))
        .map((item) => ({ ...item, identity: '', group: 'Selection', route: '', reason: '' })),
      ...(value &&
      !models.some((model) => model.id === value) &&
      !shortcuts.some((item) => item.value === value) &&
      !provider &&
      matches(value)
        ? [
            {
              value,
              label: value,
              identity: '',
              group: 'Saved choice',
              route: '',
              detail: '',
              reason: 'Unavailable in the connected catalogue'
            }
          ]
        : []),
      ...concrete
    ];
  }, [models, routes, shortcuts, query, provider, value, loading, loadError]);
  useEffect(() => {
    search.current?.focus();
  }, []);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const move = (direction: number) => {
    if (!rows.length) return;
    for (let step = 1; step <= rows.length; step++) {
      const next = (active + direction * step + rows.length) % rows.length;
      if (!rows[next]!.reason) {
        setActive(next);
        break;
      }
    }
  };
  const content = (
    <div
      className="model-browser"
      onKeyDownCapture={(event) => {
        if (embedded && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <ErrorNotice error={loadError} onRetry={() => setAttempt((value) => value + 1)} />
      <div className="model-browser-search">
        <Search size={18} aria-hidden="true" />
        <input
          ref={search}
          type="search"
          role="combobox"
          aria-label="Search models"
          placeholder="Search models, providers or capabilities…"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={id}
          aria-activedescendant={rows[active] ? `${id}-${active}` : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onClose();
              return;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              move(event.key === 'ArrowDown' ? 1 : -1);
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              if (!disabled && rows[active] && !rows[active].reason) onChange(rows[active].value);
            }
          }}
        />
      </div>
      <div className="model-browser-filter">
        <label>
          Provider{' '}
          <select
            aria-label="Filter models by provider"
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value);
              setActive(0);
            }}
          >
            <option value="">All providers</option>
            {providers.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <small className="muted" role="status">
          {rows.length} {rows.length === 1 ? 'choice' : 'choices'}
        </small>
      </div>
      <div ref={list} className="model-browser-list" role="listbox" id={id} aria-label={label}>
        {rows.map((row, index) => (
          <div key={row.value}>
            {rows[index - 1]?.group !== row.group && (
              <div className="model-browser-group" role="presentation">
                {row.group}
              </div>
            )}
            <button
              type="button"
              role="option"
              id={`${id}-${index}`}
              aria-selected={row.value === value}
              aria-disabled={disabled || Boolean(row.reason)}
              data-active={index === active}
              tabIndex={-1}
              className="model-browser-option"
              onMouseMove={() => setActive(index)}
              onClick={() => {
                if (!disabled && !row.reason) onChange(row.value);
              }}
            >
              <span>
                <strong>
                  {row.label}
                  {row.route && <em className="model-route">via {row.route}</em>}
                </strong>
                {row.identity && <small>{row.identity}</small>}
                {(row.reason || row.detail) && (
                  <small className={row.reason ? 'model-unavailable' : ''}>
                    {row.reason || row.detail}
                  </small>
                )}
              </span>
              {row.value === value && <Check size={17} aria-hidden="true" />}
            </button>
          </div>
        ))}
        {!rows.length && <p className="empty">No matching models. Try another name or provider.</p>}
      </div>
      <div className="model-browser-footer">
        <small className="muted">
          ↑ ↓ to browse · Enter to choose · Esc to {embedded ? 'go back' : 'close'}
        </small>
        {onAdvanced && (
          <Button onClick={onAdvanced}>
            <SlidersHorizontal size={15} />
            Model roles
          </Button>
        )}
      </div>
    </div>
  );
  return embedded ? (
    content
  ) : (
    <Dialog title={`Choose ${label.toLowerCase()}`} onClose={onClose} wide>
      {content}
    </Dialog>
  );
}
