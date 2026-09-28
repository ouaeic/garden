import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MediaBatch } from '@garden/contracts';
import MediaBatches from './MediaBatches';
import MediaRecovery from './MediaRecovery';

const batch: MediaBatch = {
  id: 'batch-1',
  taskId: 'task-1',
  workspaceId: 'workspace-1',
  status: 'pending',
  total: 4,
  completed: 1,
  failed: 0,
  reservationUsd: 1.6,
  watching: true,
  cancelRequested: false,
  providerStatus: 'in_progress',
  reconciliation: null,
  error: null,
  createdAt: '2026-09-06T00:00:00Z',
  updatedAt: '2026-09-06T00:00:00Z',
  cancellationSupported: true
};
const render = (value: MediaBatch) =>
  renderToStaticMarkup(<MediaBatches batches={[value]} onChange={() => undefined} />);
describe('native batch owner controls', () => {
  it('distinguishes provider render progress from delivered files and exposes separate watch and cancellation controls', () => {
    const html = render(batch);
    expect(html).toContain('1 rendered at the provider');
    expect(html).toContain('value="1" max="4"');
    expect(html).toContain('Stop watching');
    expect(html).toContain('Cancel batch');
    expect(html).toContain('Stopping updates does not cancel provider processing or charges');
    expect(html).not.toContain('download=');
  });
  it('keeps cancellation pending until a terminal provider receipt and prevents repeated requests while pending', () => {
    const html = render({ ...batch, cancelRequested: true, providerStatus: 'cancelling' });
    expect(html).toContain('The provider is cancelling this batch');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?Cancellation requested<\/button>/);
    expect(html).not.toContain('>Cancelled<');
    const terminal = render({
      ...batch,
      status: 'cancelled',
      cancelRequested: true,
      providerStatus: 'cancelled',
      failed: 3
    });
    expect(terminal).toContain('>Cancelled<');
    expect(terminal).not.toContain('Stop watching');
    expect(terminal).not.toContain('Cancel batch');
  });
  it('asks for the correct existing receipt at each uncertain submission boundary', () => {
    const input = render({
      ...batch,
      status: 'submission_uncertain',
      reconciliation: 'input_file'
    });
    expect(input).toContain('Provider input file ID');
    expect(input).toContain('submit the already approved batch once');
    expect(input).not.toContain('Cancel batch');
    const accepted = render({ ...batch, status: 'submission_uncertain', reconciliation: 'batch' });
    expect(accepted).toContain('Provider batch ID');
    expect(accepted).toContain('does not submit another batch');
    expect(accepted).not.toContain('Provider input file ID');
    const asset = renderToStaticMarkup(
      <MediaRecovery
        asset
        providerId="char_existing"
        busy={false}
        onReconcile={async () => undefined}
      />
    );
    expect(asset).toContain('value="char_existing"');
    expect(asset).toContain('Final provider charge (USD)');
  });
});
