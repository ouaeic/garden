import type {
  MediaCapabilities,
  MediaModelOption,
  MediaParameter,
  MediaPriceLine
} from '@garden/contracts';
export type { MediaCapabilities, MediaParameter, MediaPriceLine } from '@garden/contracts';
export type CatalogMediaModel = MediaModelOption;
export const mediaRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const mediaRate = (value: unknown): number | null => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1_000_000 ? rate : null;
};
export const readMediaCapabilities = (value: unknown, streaming: unknown): MediaCapabilities => {
  const parameters: Record<string, MediaParameter> = {};
  if (mediaRecord(value))
    for (const [name, raw] of Object.entries(value).slice(0, 64)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || !mediaRecord(raw)) continue;
      if (raw.type === 'boolean') parameters[name] = { type: 'boolean' };
      if (raw.type === 'enum' && Array.isArray(raw.values)) {
        const values = [
          ...new Set(
            raw.values.filter(
              (v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128
            )
          )
        ].slice(0, 128);
        if (values.length) parameters[name] = { type: 'enum', values };
      }
      if (raw.type === 'range') {
        const min = mediaRate(raw.min),
          max = mediaRate(raw.max);
        if (min !== null && max !== null && min <= max)
          parameters[name] = { type: 'range', min, max };
      }
    }
  return { parameters, supportsStreaming: streaming === true };
};
const PRICE_UNITS = new Set(['image', 'megapixel', 'token', 'character', 'second', 'minute']);
export const readMediaPricing = (value: unknown): MediaPriceLine[] => {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 128).flatMap((raw) => {
    if (!mediaRecord(raw)) return [];
    const costUsd = mediaRate(raw.cost_usd);
    if (
      costUsd === null ||
      typeof raw.billable !== 'string' ||
      !/^[a-z_]{1,64}$/.test(raw.billable) ||
      typeof raw.unit !== 'string' ||
      !PRICE_UNITS.has(raw.unit)
    )
      return [];
    if (raw.variant !== undefined && (typeof raw.variant !== 'string' || raw.variant.length > 64))
      return [];
    return [
      {
        billable: raw.billable,
        unit: raw.unit as MediaPriceLine['unit'],
        costUsd,
        ...(typeof raw.variant === 'string' ? { variant: raw.variant } : {})
      }
    ];
  });
};

export interface MediaQuoteInput {
  width?: number;
  height?: number;
  count?: number;
  characters?: number;
  seconds?: number;
  variant?: string;
  inputImageMegapixels?: number[];
  inputImageCount?: number;
  tokens?: Readonly<Record<string, number>>;
}
/** Null is an unpriced request, including an unknown tier or token-priced reference. */
export const quoteMediaPrice = (
  pricing: readonly MediaPriceLine[] | undefined,
  input: MediaQuoteInput
): number | null => {
  if (!pricing?.length) return null;
  const matching = pricing.filter(
    (line) =>
      line.variant === input.variant ||
      (line.variant === undefined &&
        !pricing.some(
          (tier) =>
            tier.billable === line.billable &&
            tier.unit === line.unit &&
            tier.variant !== undefined &&
            tier.variant === input.variant
        ))
  );
  if (
    !matching.length ||
    (input.variant !== undefined &&
      pricing.some((line) => line.variant !== undefined) &&
      !pricing.some((line) => line.variant === input.variant))
  )
    return null;
  if (input.variant === undefined && pricing.some((line) => line.variant !== undefined))
    return null;
  let total = 0;
  for (const line of matching) {
    let quantity: number | undefined;
    if (line.unit === 'token') quantity = input.tokens?.[line.billable];
    else if (line.billable === 'output_image') {
      if (line.unit === 'image') quantity = input.count ?? 1;
      if (line.unit === 'megapixel' && input.width !== undefined && input.height !== undefined)
        quantity = ((input.width * input.height) / 1_000_000) * (input.count ?? 1);
    } else if (line.billable === 'input_image' || line.billable === 'input_reference') {
      if (line.unit === 'image')
        quantity = input.inputImageCount ?? input.inputImageMegapixels?.length ?? 0;
      if (line.unit === 'megapixel')
        quantity =
          input.inputImageMegapixels?.reduce((sum, area) => sum + area, 0) ??
          (input.inputImageCount ? undefined : 0);
    } else if (line.billable === 'input_text' && line.unit === 'character')
      quantity = input.characters;
    else if (
      line.billable === 'output_video' ||
      line.billable === 'output_audio' ||
      line.billable === 'input_audio'
    ) {
      if (line.unit === 'second') quantity = input.seconds;
      if (line.unit === 'minute' && input.seconds !== undefined) quantity = input.seconds / 60;
    }
    if (quantity === undefined || !Number.isFinite(quantity) || quantity < 0) return null;
    total += quantity * line.costUsd;
  }
  return Number.isFinite(total) ? Math.ceil(total * 1e9) / 1e9 : null;
};
