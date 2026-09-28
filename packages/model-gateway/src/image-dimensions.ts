import type { ImageDimensions, MediaCapabilities } from '@garden/contracts';

// Model-specific geometry is documented at https://docs.byteplus.com/api/docs/ModelArk/1824121.
const dimensionsFor = (model: string): ImageDimensions | undefined =>
  model === 'bytedance-seed/seedream-4.5'
    ? {
        defaultWidth: 2048,
        defaultHeight: 2048,
        minPixels: 3_686_400,
        maxPixels: 16_777_216,
        minAspectRatio: 1 / 16,
        maxAspectRatio: 16,
        squareSizeByResolution: { '2K': 2048, '4K': 4096 }
      }
    : undefined;

/** Intersect provider controls with the model's documented geometry. */
export const imageCapabilities = (
  model: string,
  capabilities: MediaCapabilities
): MediaCapabilities => {
  const imageDimensions = dimensionsFor(model);
  if (!imageDimensions) return capabilities;
  const parameters = { ...capabilities.parameters };
  const resolution = parameters.resolution;
  if (resolution?.type === 'enum') {
    const values = resolution.values.filter(
      (value) => imageDimensions.squareSizeByResolution[value] !== undefined
    );
    if (values.length) parameters.resolution = { type: 'enum', values };
    else delete parameters.resolution;
  }
  return { ...capabilities, parameters, imageDimensions };
};

/** Approval quotes and execution use the same dimensions, including omitted values. */
export const resolveImageDimensions = (input: {
  model: string;
  capabilities?: MediaCapabilities | undefined;
  width?: number | undefined;
  height?: number | undefined;
  resolution?: string | undefined;
}): { width: number; height: number } => {
  const bounds = dimensionsFor(input.model) ?? input.capabilities?.imageDimensions;
  const square = input.resolution ? bounds?.squareSizeByResolution[input.resolution] : undefined;
  const width = input.width ?? square ?? bounds?.defaultWidth ?? 1024;
  const height = input.height ?? square ?? bounds?.defaultHeight ?? 1024;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192
  )
    throw new Error('Choose valid image dimensions');
  if (
    bounds &&
    (width * height < bounds.minPixels ||
      width * height > bounds.maxPixels ||
      width / height < bounds.minAspectRatio ||
      width / height > bounds.maxAspectRatio)
  )
    throw new Error(
      `The selected image model requires ${bounds.minPixels}–${bounds.maxPixels} pixels and an aspect ratio between ${bounds.minAspectRatio} and ${bounds.maxAspectRatio}; omit dimensions for ${bounds.defaultWidth}x${bounds.defaultHeight}`
    );
  if (bounds && input.resolution && bounds.squareSizeByResolution[input.resolution] === undefined)
    throw new Error('The selected image model does not support this resolution');
  return { width, height };
};
