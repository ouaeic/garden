import { describe, expect, it } from 'vitest';
import type { SharePreviewResponse } from '@garden/contracts';
import {
  captureShareOptions,
  shareCreationOperation,
  shareOptionsSignature,
  type ReviewedShare
} from './sharing-operations';

const snapshot: SharePreviewResponse = {
  v: 1,
  title: 'Reviewed work',
  createdAt: '2026-09-06T00:00:00.000Z',
  events: [],
  artifacts: [],
  previewDigest: 'a'.repeat(64)
};

describe('reviewed share delivery', () => {
  it('refuses changed selections and sends only the captured review with its digest', () => {
    const selection = { artifactIds: ['file-a'], includeReasoning: false };
    const options = captureShareOptions(selection);
    const review: ReviewedShare = {
      options,
      signature: shareOptionsSignature(options),
      snapshot
    };
    selection.artifactIds.push('file-b');
    const operation = shareCreationOperation();
    expect(() => operation.prepare(review, selection)).toThrow('Review the selected snapshot');
    expect(() => operation.prepare(null, options)).toThrow('Review the selected snapshot');
    expect(operation.prepare(review, options).body).toEqual({
      artifactIds: ['file-a'],
      includeReasoning: false,
      expectedPreviewDigest: snapshot.previewDigest
    });
  });

  it('reuses an uncertain request identity and changes it only for a different operation', () => {
    const options = { publicTitle: 'Reviewed work' };
    const review: ReviewedShare = {
      options,
      signature: shareOptionsSignature(options),
      snapshot
    };
    const operation = shareCreationOperation();
    const first = operation.prepare(review, options);
    expect(operation.prepare(review, options).idempotencyKey).toBe(first.idempotencyKey);
    const replacement = operation.prepare(review, options, 'existing-link');
    expect(replacement.idempotencyKey).not.toBe(first.idempotencyKey);
    const revised = operation.prepare(
      { ...review, snapshot: { ...snapshot, previewDigest: 'b'.repeat(64) } },
      options,
      'existing-link'
    );
    expect(revised.idempotencyKey).not.toBe(replacement.idempotencyKey);
    operation.complete();
    expect(operation.prepare(review, options).idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('refuses a response without a verifiable preview digest', () => {
    expect(() =>
      shareCreationOperation().prepare(
        { options: {}, signature: '{}', snapshot: { ...snapshot, previewDigest: '' } },
        {}
      )
    ).toThrow('verifiable preview');
  });
});
