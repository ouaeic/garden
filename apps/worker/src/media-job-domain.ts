import type { VideoGenerationRequest } from '@garden/model-gateway';

export interface StoredVideoRequest {
  provider: { baseUrl: string; apiKey: string; apiProtocol: 'openrouter' | 'openai' };
  input: Omit<VideoGenerationRequest, 'signal'>;
  quoteUsd: number | null;
}
export const mediaJobAad = (id: string) => `provider-media-job:${id}`;
export const mediaJobErrorAad = (id: string) => `provider-media-error:${id}`;
