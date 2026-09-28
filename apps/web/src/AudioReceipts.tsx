import { useEffect, useRef, useState } from 'react';
import type { DictationReceipt, VoicePendingReceipt, VoiceSession } from '@garden/contracts';
import { get, post } from './client';
import { money, date } from './model';
import { Button, ErrorNotice, Field } from './ui';

// Checked against the API contract without importing its runtime schemas.
export const AUDIO_RECEIPT_REFERENCE_MAX_LENGTH = 256;

function Receipt({
  id,
  reservedUsd,
  createdAt,
  label,
  onReconcile
}: {
  id: string;
  reservedUsd: number;
  createdAt: string;
  label: string;
  onReconcile: (id: string, costUsd: number, providerReceiptRef: string) => Promise<void>;
}) {
  const [cost, setCost] = useState('');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submitting = useRef(false);
  return (
    <details className="garden-media-recovery">
      <summary>
        {label} · {money(reservedUsd)} pending
      </summary>
      <p className="muted">
        {date(createdAt)}. The provider’s final usage was not confirmed. Enter its actual charge and
        receipt reference to settle the amount held.
      </p>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (submitting.current) return;
          const amount = Number(cost);
          if (!cost.trim() || !Number.isFinite(amount) || amount < 0 || !reference.trim()) return;
          submitting.current = true;
          setBusy(true);
          setError(null);
          void onReconcile(id, amount, reference.trim())
            .catch(setError)
            .finally(() => {
              submitting.current = false;
              setBusy(false);
            });
        }}
      >
        <Field label="Final provider charge (USD)">
          <input
            required
            type="number"
            min="0"
            step="any"
            value={cost}
            onChange={(event) => setCost(event.target.value)}
          />
        </Field>
        <Field
          label="Provider receipt reference"
          hint="Use your provider invoice or usage receipt. This reference is stored encrypted."
        >
          <input
            required
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            maxLength={AUDIO_RECEIPT_REFERENCE_MAX_LENGTH}
            autoComplete="off"
          />
        </Field>
        <Button type="submit" busy={busy} disabled={!cost.trim() || !reference.trim()}>
          Record provider receipt
        </Button>
        <ErrorNotice error={error} />
      </form>
    </details>
  );
}

function AudioReceiptsScope({
  sessionId,
  onSettled
}: {
  sessionId?: string;
  onSettled?: () => void;
}) {
  const [receipts, setReceipts] = useState<
    Array<{ id: string; reservedUsd: number; createdAt: string; label: string; sessionId?: string }>
  >([]);
  const [error, setError] = useState<unknown>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const load = async () => {
      if (sessionId) {
        const result = await get<VoicePendingReceipt[]>(
          `/v1/voice-sessions/${sessionId}/receipts`,
          { signal: controller.signal }
        );
        return result.map((receipt) => ({ ...receipt, label: 'Voice response' }));
      }
      const results = await Promise.allSettled([
        get<DictationReceipt[]>('/v1/audio/transcriptions/receipts', { signal: controller.signal }),
        get<VoiceSession[]>('/v1/voice-sessions', { signal: controller.signal })
      ]);
      const dictation = results[0].status === 'fulfilled' ? results[0].value : [];
      const sessions = results[1].status === 'fulfilled' ? results[1].value : [];
      const voice = await Promise.allSettled(
        sessions
          .filter(
            (session) =>
              ['ended', 'expired', 'lost', 'usage_uncertain'].includes(session.status) &&
              session.pendingUsd > 0
          )
          .map(async (session) =>
            (
              await get<VoicePendingReceipt[]>(`/v1/voice-sessions/${session.id}/receipts`, {
                signal: controller.signal
              })
            ).map((receipt) => ({ ...receipt, sessionId: session.id, label: 'Voice response' }))
          )
      );
      if (
        !controller.signal.aborted &&
        [...results, ...voice].some((result) => result.status === 'rejected')
      )
        setError(
          new Error('Some pending audio charges could not be loaded. Reopen Settings to retry.')
        );
      return [
        ...dictation
          .filter((receipt) => receipt.state === 'reserved')
          .map((receipt) => ({
            id: receipt.id,
            reservedUsd: receipt.reservationUsd,
            createdAt: receipt.createdAt,
            label: receipt.modelId || 'Dictation'
          })),
        ...voice.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
      ];
    };
    void load().then(
      (result) => {
        if (!controller.signal.aborted) setReceipts(result);
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setError(cause);
      }
    );
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [sessionId]);
  if (!receipts.length && !error) return null;
  return (
    <section
      className="garden-audio-receipts"
      aria-label={sessionId ? 'Pending voice receipts' : 'Pending dictation receipts'}
    >
      <h3>Pending audio charges</h3>
      <ErrorNotice error={error} />
      {receipts.map((receipt) => (
        <Receipt
          key={`${receipt.sessionId ?? sessionId ?? 'dictation'}:${receipt.id}`}
          {...receipt}
          onReconcile={async (id, costUsd, providerReceiptRef) => {
            const voiceSessionId = receipt.sessionId ?? sessionId;
            await post(
              voiceSessionId
                ? `/v1/voice-sessions/${voiceSessionId}/reconcile`
                : `/v1/audio/transcriptions/${id}/reconcile`,
              {
                ...(voiceSessionId ? { receiptId: id } : {}),
                costUsd,
                providerReceiptRef
              }
            );
            if (mounted.current) {
              setReceipts((current) =>
                current.filter((value) => value.id !== id || value.sessionId !== receipt.sessionId)
              );
              onSettled?.();
            }
          }}
        />
      ))}
    </section>
  );
}

export default function AudioReceipts(props: { sessionId?: string; onSettled?: () => void }) {
  return <AudioReceiptsScope key={props.sessionId ?? 'dictation'} {...props} />;
}
