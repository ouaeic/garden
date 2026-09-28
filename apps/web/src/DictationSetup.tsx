import { useEffect, useState } from 'react';
import type { DictationOptions } from '@garden/contracts';
import { Mic } from './icons';
import { get } from './client';
import { money } from './model';
import { Button, Dialog, ErrorNotice, Field, Spinner } from './ui';
import { authorizeDictation, DICTATION_MAX_COST_USD } from './dictation-preflight';
import type { DictationConsent } from './dictation-preflight';

export default function DictationSetup({
  onClose,
  onStart
}: {
  onClose: () => void;
  onStart: (consent: DictationConsent, maxSeconds: number) => void;
}) {
  const [options, setOptions] = useState<DictationOptions | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cap, setCap] = useState('');
  const [consent, setConsent] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void get<DictationOptions>('/v1/audio/transcriptions/options', {
      signal: controller.signal
    }).then(
      (result) => {
        if (!controller.signal.aborted) setOptions(result);
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setError(cause);
      }
    );
    return () => controller.abort();
  }, []);
  const external = options?.requiresExternalConsent || options?.defaultPrivacyRoute === 'external';
  return (
    <Dialog title="Dictate a direction" onClose={onClose}>
      <div className="stack garden-dictation-setup">
        <p>Your recording becomes editable text. Review it before sending your direction.</p>
        {!options && !error && <Spinner label="Checking dictation options…" />}
        {options && (
          <>
            <div className="garden-audio-route">
              <strong>{options.displayName || 'No transcription model configured'}</strong>
              {options.provider && <span className="muted">{options.provider}</span>}
              {options.modelId && <small>{options.modelId}</small>}
            </div>
            {!options.available && <p role="status">{options.reason}</p>}
            {options.available && (
              <>
                <p className="muted">
                  Up to{' '}
                  {options.maxDurationSeconds < 60
                    ? `${options.maxDurationSeconds} seconds`
                    : `${Math.floor(options.maxDurationSeconds / 60)} minutes`}{' '}
                  per recording.
                  {options.usdPerMinute !== null
                    ? ` Up to ${money(options.usdPerMinute)} per minute is held before submission. The provider receipt determines the final charge. Your account limits also apply.`
                    : options.reservationUsd !== null
                      ? ` ${money(options.reservationUsd)} is reserved for the full model request bound. Actual usage replaces it when the provider returns its receipt.`
                      : ' A verified cost bound is required before this route can record.'}
                </p>
                <Field
                  label={
                    options.requiresMaxCostUsd
                      ? 'Maximum transcription cost (USD)'
                      : 'Maximum transcription cost (USD, optional)'
                  }
                  hint="garden reserves the quoted cost within this limit before submitting the recording."
                >
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    max={DICTATION_MAX_COST_USD}
                    step="any"
                    value={cap}
                    onChange={(event) => setCap(event.target.value)}
                    placeholder={
                      options.requiresMaxCostUsd ? 'Choose a limit' : 'Use account limits'
                    }
                  />
                </Field>
                {external ? (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={(event) => setConsent(event.target.checked)}
                    />
                    <span>
                      I agree to send this recording under the provider’s retention terms. Zero data
                      retention is not guaranteed.
                    </span>
                  </label>
                ) : (
                  <p className="muted">This route requires provider zero data retention.</p>
                )}
                <Button
                  className="primary"
                  disabled={
                    (Boolean(external) && !consent) || (options.requiresMaxCostUsd && !cap.trim())
                  }
                  onClick={() => {
                    try {
                      onStart(
                        authorizeDictation(options, cap, consent),
                        options.maxDurationSeconds
                      );
                    } catch (cause) {
                      setError(cause);
                    }
                  }}
                >
                  <Mic size={17} /> Start recording
                </Button>
              </>
            )}
          </>
        )}
        <ErrorNotice error={error} />
      </div>
    </Dialog>
  );
}
