import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createWorkspaceFile } from './files.js';

const Plot = z
  .object({
    title: z.string().max(160).default(''),
    xLabel: z.string().max(80).default(''),
    yLabel: z.string().max(80).default(''),
    points: z
      .array(z.tuple([z.number().finite(), z.number().finite()]))
      .min(1)
      .max(2000)
  })
  .strict();
const escape = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]!
  );
export function renderComputationPlot(value: unknown): Buffer {
  const plot = Plot.parse(value);
  const xs = plot.points.map((point) => point[0]),
    ys = plot.points.map((point) => point[1]);
  const x0 = Math.min(...xs),
    x1 = Math.max(...xs),
    y0 = Math.min(...ys),
    y1 = Math.max(...ys);
  const points = plot.points
    .map(
      ([x, y]) =>
        `${(60 + ((x - x0) / (x1 - x0 || 1)) * 680).toFixed(2)},${(420 - ((y - y0) / (y1 - y0 || 1)) * 350).toFixed(2)}`
    )
    .join(' ');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><rect width="800" height="500" fill="#101d19"/><g fill="#e7efe8" font-family="sans-serif"><text x="60" y="35" font-size="20">${escape(plot.title)}</text><text x="400" y="485" text-anchor="middle">${escape(plot.xLabel)}</text><text x="12" y="245" transform="rotate(-90 12 245)" text-anchor="middle">${escape(plot.yLabel)}</text><text x="60" y="450">${x0}</text><text x="740" y="450" text-anchor="end">${x1}</text><text x="60" y="65">${y1}</text></g><path d="M60 70V420H740" fill="none" stroke="#8a9c8d"/><polyline points="${points}" fill="none" stroke="#b1d792" stroke-width="2"/></svg>`
  );
}
export async function saveComputationArtifacts(
  root: string,
  values: unknown
): Promise<Array<{ path: string; mimeType: string; bytes: number }>> {
  const items = z
    .array(
      z.union([
        z.object({ mimeType: z.literal('image/png'), base64: z.string().max(3_000_000) }).strict(),
        z.object({ mimeType: z.literal('application/vnd.garden.plot+json'), plot: Plot }).strict()
      ])
    )
    .max(4)
    .parse(values);
  const artifacts = [];
  for (const item of items) {
    const png = item.mimeType === 'image/png';
    const data = png ? Buffer.from(item.base64, 'base64') : renderComputationPlot(item.plot);
    if (
      png &&
      (data.length < 24 ||
        !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        data.toString('ascii', 12, 16) !== 'IHDR' ||
        data.readUInt32BE(16) > 8192 ||
        data.readUInt32BE(20) > 8192 ||
        data.readUInt32BE(16) === 0 ||
        data.readUInt32BE(20) === 0)
    )
      throw Error('Invalid or oversized computation PNG');
    const relative = `.garden/artifacts/computation-${randomUUID()}.${png ? 'png' : 'svg'}`;
    await createWorkspaceFile(root, relative, data, 2 * 1024 * 1024);
    artifacts.push({
      path: relative,
      mimeType: png ? 'image/png' : 'image/svg+xml',
      bytes: data.length
    });
  }
  return artifacts;
}
