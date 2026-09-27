import { z } from 'zod';
import type { MediaPriceLine } from './media.js';
import { AUDIO_RECEIPT_REFERENCE_MAX_LENGTH } from './dictation.js';

export const VOICE_SAMPLE_RATE = 24_000;
export const VOICE_FRAME_HEADER_BYTES = 8;
export const VOICE_MAX_FRAME_SAMPLES = 2_400;
export const VOICE_MAX_SESSION_SECONDS = 1_800;
export const VOICE_MAX_INPUT_SEGMENT_SECONDS = 60;
export const VOICE_MAX_SPEND_USD = 100;
export const VOICE_PLAYBACK_BUFFER_SECONDS = 120;
export const VoiceReasoningEffort = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']);
export type VoiceReasoningEffort = z.infer<typeof VoiceReasoningEffort>;
export const VoiceStartRequest = z
  .object({
    modelId: z.string().min(1).max(200),
    voice: z.enum([
      'alloy',
      'ash',
      'ballad',
      'coral',
      'echo',
      'sage',
      'shimmer',
      'verse',
      'marin',
      'cedar'
    ]),
    reasoningEffort: VoiceReasoningEffort.default('low'),
    privacyRoute: z.enum(['provider_zdr', 'external']),
    maxSpendUsd: z.number().finite().positive().max(VOICE_MAX_SPEND_USD),
    lifetimeSeconds: z.number().int().min(30).max(VOICE_MAX_SESSION_SECONDS).default(600),
    expectedRouteProof: z.string().min(1).max(128),
    shareTaskContext: z.boolean().optional()
  })
  .strict();
export type VoiceStartRequest = z.infer<typeof VoiceStartRequest>;

export interface VoiceModelOption {
  id: string;
  provider: 'openai';
  providerModelId: string;
  displayName: string;
  available: boolean;
  reason: string | null;
  routeProof: string;
  privacyRoutes: Array<'provider_zdr' | 'external'>;
  requiresExternalConsent: boolean;
  supportedEfforts: VoiceReasoningEffort[];
  defaultEffort: VoiceReasoningEffort;
  voices: string[];
  defaultVoice: string;
  pricing: MediaPriceLine[];
  priceUpdatedAt: string;
  minimumReservationUsd: number;
  maxDurationSeconds: number;
  maxInputSegmentSeconds: number;
}
export interface VoiceModels {
  options: VoiceModelOption[];
  reason: string | null;
}
export type VoiceSessionStatus =
  | 'preparing'
  | 'connecting'
  | 'listening'
  | 'responding'
  | 'stopping'
  | 'ended'
  | 'expired'
  | 'lost'
  | 'usage_uncertain';
export interface VoiceSession {
  shareTaskContext?: boolean;
  providerGeneration?: number;
  id: string;
  taskId: string;
  workspaceId: string;
  provider: 'openai';
  providerModelId: string;
  privacyRoute: 'provider_zdr' | 'external';
  retention: string;
  voice: string;
  reasoningEffort: VoiceReasoningEffort;
  status: VoiceSessionStatus;
  createdAt: string;
  connectedAt: string | null;
  deadlineAt: string;
  endedAt: string | null;
  maxSpendUsd: number;
  settledUsd: number;
  pendingUsd: number;
  inputSeconds: number;
  outputSeconds: number;
  currentResponseId: string | null;
  cleanupPending: boolean;
  errorCode: string | null;
  note: string | null;
}
export interface VoiceConnection {
  session: VoiceSession;
  ticket: string;
  recoveryKey: string;
  socketPath: string;
  ticketExpiresAt: string;
}
export interface VoiceWorkProposal {
  id: string;
  digest: string;
  sessionId: string;
  taskId: string;
  prompt: string;
  modelId: string;
  privacyRoute: 'provider_zdr' | 'external';
  maxSpendUsd: number | null;
  status: 'pending' | 'confirmed' | 'rejected' | 'expired';
  createdAt: string;
  expiresAt: string;
  messageId: string | null;
}
export interface VoicePendingReceipt {
  id: string;
  providerResponseId: string | null;
  reservedUsd: number;
  createdAt: string;
}
export const VoiceReceiptReconciliation = z
  .object({
    receiptId: z.string().uuid(),
    costUsd: z.number().finite().min(0).max(1_000_000),
    providerReceiptRef: z.string().trim().min(1).max(AUDIO_RECEIPT_REFERENCE_MAX_LENGTH)
  })
  .strict();
const epoch = z.number().int().min(1).max(0xffffffff);
const samples = z.number().int().min(0).max(0xffffffff);
export const VoiceClientControl = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ticket'), ticket: z.string().min(20).max(128) }).strict(),
  z.object({ type: z.literal('ping') }).strict(),
  z.object({ type: z.literal('mute') }).strict(),
  z.object({ type: z.literal('unmute') }).strict(),
  z.object({ type: z.literal('interrupt'), epoch, playedSamples: samples }).strict(),
  z.object({ type: z.literal('playback'), epoch, playedSamples: samples }).strict(),
  z.object({ type: z.literal('stop') }).strict()
]);
export type VoiceClientControl = z.infer<typeof VoiceClientControl>;
export type VoiceServerEvent =
  | { type: 'pong' }
  | { type: 'ready'; session: VoiceSession; inputEpoch: number; sampleRate: 24000 }
  | { type: 'input'; inputEpoch: number; muted: boolean }
  | { type: 'session'; session: VoiceSession }
  | { type: 'audio_start'; epoch: number; itemId: string; responseId: string; sampleRate: 24000 }
  | { type: 'audio_done'; epoch: number; totalSamples: number }
  | { type: 'flush'; epoch: number; reason: 'owner' | 'speech_started' | 'stopped' }
  | { type: 'transcript'; epoch: number; text: string; final: boolean }
  | { type: 'proposal'; proposal: VoiceWorkProposal }
  | { type: 'error'; code: string; message: string };

/** Each binary frame: uint32 BE epoch, uint32 BE sample offset, then mono PCM16 LE at 24 kHz. */
export interface VoiceAudioFrame {
  epoch: number;
  sampleOffset: number;
  pcm: Uint8Array;
}
