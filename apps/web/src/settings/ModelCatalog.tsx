import { useState } from 'react';
import type { ModelRelease } from '@athanor/contracts';
import { Button, Field } from '../ui.js';
import { money } from '../model.js';

const pageSize = 50;

export default function ModelCatalog({ models }: { models: ModelRelease[] }) {
  const [query, setQuery] = useState('');
  const [availableOnly, setAvailableOnly] = useState(false);
  const [page, setPage] = useState(0);
  const search = query.trim().toLocaleLowerCase();
  const matches = models.filter(
    (model) =>
      (!availableOnly || model.availability === 'available') &&
      `${model.displayName} ${model.id} ${model.provider}`.toLocaleLowerCase().includes(search)
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matches.length / pageSize) - 1));
  const first = currentPage * pageSize;
  const shown = matches.slice(first, first + pageSize);
  return (
    <>
      <Field label="Find a model">
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
        />
      </Field>
      <label className="management-check">
        <input
          type="checkbox"
          checked={availableOnly}
          onChange={(event) => {
            setAvailableOnly(event.target.checked);
            setPage(0);
          }}
        />
        Available models only
      </label>
      {matches.length > 0 ? (
        <>
          <div className="row between">
            <p className="muted" role="status">
              Showing {first + 1}–{first + shown.length} of {matches.length}{' '}
              {matches.length === 1 ? 'model' : 'models'}
            </p>
            {matches.length > pageSize && (
              <div className="row" aria-label="Model catalog pages">
                <Button
                  type="button"
                  disabled={currentPage === 0}
                  onClick={() => setPage(currentPage - 1)}
                >
                  Previous models
                </Button>
                <Button
                  type="button"
                  disabled={first + shown.length >= matches.length}
                  onClick={() => setPage(currentPage + 1)}
                >
                  Next models
                </Button>
              </div>
            )}
          </div>
          <div
            className="management-scroll"
            role="region"
            aria-label="Model catalog results"
            // Keyboard users need focus here to scroll columns beyond a narrow viewport.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
          >
            <table className="management-table model-catalog-table" aria-label="Model catalog">
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Availability</th>
                  <th scope="col">Inputs</th>
                  <th scope="col">Context</th>
                  <th scope="col">Input / output per million</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((model) => (
                  <tr key={model.id}>
                    <td>
                      <strong>{model.displayName}</strong>
                      <br />
                      <span className="muted">
                        {model.privacyRoute === 'provider_zdr'
                          ? 'Zero retention'
                          : 'External route'}{' '}
                        · {model.provider}
                      </span>
                    </td>
                    <td>{model.availability}</td>
                    <td>
                      {(model.modalities ?? ['text']).join(' · ')}
                      {(['audio', 'video'] as const)
                        .filter((kind) => model.modalities?.includes(kind))
                        .map((kind) => {
                          const price =
                            kind === 'audio'
                              ? model.nativeInputPricing?.audioUsdPerMillionTokens
                              : model.nativeInputPricing?.videoUsdPerMillionTokens;
                          return (
                            <small className="muted" key={kind} style={{ display: 'block' }}>
                              {kind === 'audio' ? 'Audio' : 'Video'}:{' '}
                              {price == null
                                ? 'native input price unavailable'
                                : `${money(price)} per million input tokens`}
                            </small>
                          );
                        })}
                    </td>
                    <td>{model.contextTokens.toLocaleString()}</td>
                    <td>
                      {model.inputUsdPerMillionTokens == null
                        ? 'Unknown'
                        : money(model.inputUsdPerMillionTokens)}{' '}
                      /{' '}
                      {model.outputUsdPerMillionTokens == null
                        ? 'Unknown'
                        : money(model.outputUsdPerMillionTokens)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="empty" role="status">
          {models.length
            ? 'No models match these filters.'
            : 'No models are available from this connection.'}
        </p>
      )}
    </>
  );
}
