import type { CreateShareRequest, SharePreviewResponse } from '@garden/contracts';

export interface ReviewedShare {
  options: CreateShareRequest;
  signature: string;
  snapshot: SharePreviewResponse;
}

export const shareOptionsSignature = (options: CreateShareRequest): string =>
  JSON.stringify(options);

export const captureShareOptions = (options: CreateShareRequest): CreateShareRequest => ({
  ...options,
  artifactIds: [...(options.artifactIds ?? [])]
});

/** An uncertain delivery retains its identity until the reviewed content or destination changes. */
export function shareCreationOperation() {
  let pending: { signature: string; key: string } | null = null;
  return {
    prepare(review: ReviewedShare | null, options: CreateShareRequest, previous?: string) {
      if (!review || review.signature !== shareOptionsSignature(options))
        throw new Error('Review the selected snapshot before creating a link.');
      if (!/^[a-f0-9]{64}$/.test(review.snapshot.previewDigest))
        throw new Error('The server did not return a verifiable preview. Review again.');
      const body: CreateShareRequest = {
        ...captureShareOptions(review.options),
        expectedPreviewDigest: review.snapshot.previewDigest
      };
      const signature = JSON.stringify({ previous, body });
      if (pending?.signature !== signature) pending = { signature, key: crypto.randomUUID() };
      return { body, idempotencyKey: pending.key };
    },
    complete() {
      pending = null;
    }
  };
}
