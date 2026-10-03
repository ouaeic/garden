import { describe, expect, it } from 'vitest';
import { seedModels } from './catalog.js';
import {
  currentCommercialLicenseReview,
  managedMediaModels,
  modelLicenseManifest
} from './license-manifest.js';

/**
 * What this suite is for, given that a review does not expire.
 *
 * It does not assert against a clock. Pinned to the issue date of the very records it checks, an
 * expiry could never fail; pinned to `now`, a checkout nobody had touched would go red on a
 * calendar date. Neither tests anything about the licences themselves.
 *
 * A published licence is a fact about a published artefact. So these assertions are about coverage
 * and agreement - every route the catalogue can offer has a review, every review names a real
 * upstream and a real revision, and nothing non-commercial is in the set - which is what the
 * manifest exists to guarantee and what would actually be wrong if somebody added a model without
 * reading its licence.
 */
describe('independent model-license manifest', () => {
  it('covers every chat and media route the catalogue can offer', () => {
    const missing: string[] = [];
    for (const model of seedModels(new Date()))
      if (!currentCommercialLicenseReview(model.providerModelId, model.license))
        missing.push(`${model.providerModelId} (${model.license})`);
    for (const media of Object.values(managedMediaModels))
      if (!currentCommercialLicenseReview(media.modelId, media.license))
        missing.push(`${media.modelId} (${media.license})`);
    expect(
      missing,
      `these routes are offered with no licence review: ${missing.join('; ')}. Add one to license-manifest.ts after reading the model's licence`
    ).toEqual([]);
  });

  it('answers nothing for a model it has never reviewed', () => {
    expect(currentCommercialLicenseReview('someone/unreviewed-model', 'MIT')).toBeUndefined();
  });

  /*
   * The licence a review claims has to match the licence the catalogue declares, or the review is
   * about a different artefact than the one being offered. This is the check that catches a model
   * relicensed upstream: the catalogue's declaration moves and the review's does not.
   */
  it('answers nothing when the declared licence disagrees with the review', () => {
    const reviewed = [...modelLicenseManifest.values()][0];
    if (!reviewed) throw new Error('the manifest is empty, so there is nothing to disagree with');
    const disagreeing = reviewed.license === 'MIT' ? 'Apache-2.0' : 'MIT';
    expect(currentCommercialLicenseReview(reviewed.providerModelId, disagreeing)).toBeUndefined();
    expect(
      currentCommercialLicenseReview(reviewed.providerModelId, reviewed.license)
    ).toBeDefined();
  });

  /*
   * `upstreamRevision` is what stands in for an expiry: it records exactly which revision was read,
   * so a licence that changes upstream is caught by the revision no longer matching rather than by
   * a timer. A blank one would make the review unfalsifiable.
   */
  it('records the upstream revision each reading was made against', () => {
    // The AGPL claim this file makes is a claim about the manifest's contents. An empty manifest
    // makes it vacuously, in no time at all, which is the one way a compliance test can lie.
    expect(modelLicenseManifest.size).toBeGreaterThan(0);
    for (const review of modelLicenseManifest.values()) {
      expect(
        review.upstreamRevision,
        `${review.providerModelId} has no upstream revision`
      ).toBeTruthy();
      expect(review.upstreamModelUrl, `${review.providerModelId} has no upstream url`).toMatch(
        /^https:\/\//
      );
      expect(review.licenseUrl, `${review.providerModelId} has no licence url`).toMatch(
        /^https:\/\//
      );
      expect(review.reviewedAt, `${review.providerModelId} has no reviewed date`).toMatch(
        /^\d{4}-\d{2}-\d{2}T/
      );
    }
  });

  it('does not contain non-commercial media licenses', () => {
    expect(modelLicenseManifest.has('mistralai/voxtral-mini-tts')).toBe(false);
    expect(
      [...modelLicenseManifest.values()].every(
        (entry) =>
          entry.commercialUseUnderModelLicense && entry.license !== ('CC-BY-NC-4.0' as never)
      )
    ).toBe(true);
  });
});
