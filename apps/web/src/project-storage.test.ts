import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectStorageUsage } from '@garden/contracts';
import { expect, it } from 'vitest';
import { ProjectStorageDetails } from './ProjectStorage';

it('keeps allocation, file copies, partial coverage and reclaimable space distinct', () => {
  const usage: ProjectStorageUsage = {
    observedAt: '2026-09-20T00:00:00Z',
    durationMs: 20,
    complete: false,
    scannedEntries: 10,
    fileReferences: 8,
    uniqueFiles: 2,
    logicalBytes: 8192,
    allocatedBytes: 4096,
    sharedCopies: 6,
    skippedEntries: 1,
    limited: true,
    changedDuringScan: true,
    reclaimableBytes: null
  };
  const html = renderToStaticMarkup(createElement(ProjectStorageDetails, { usage }));
  expect(html).toContain('4 KiB');
  expect(html).toContain('8 KiB');
  expect(html).toContain('Partial scan');
  expect(html).toContain('Files changed');
  expect(html).toContain('1 entry could not be counted');
  expect(html).toContain('not an estimate of space that can be freed');
  expect(html).toContain('Conversation working folders and job files are separate');
});
