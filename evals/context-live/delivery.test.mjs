import test from 'node:test';
import assert from 'node:assert/strict';
import { runFixture, evidence } from '../harness.ts';

test('live comparison fixture can resolve an existing file at completion', async () => {
  const outcome = await runFixture({
    id: 'context-delivery-existing',
    shape: 'conversation',
    request: 'Read workspace/note.txt and cite it.',
    why: 'A declared source file must exercise delivery checking, not a missing store method.',
    runner: { files: { 'workspace/note.txt': 'A synthetic note.' } },
    model: ({ index }) => ({
      calls:
        index === 0
          ? [{ id: 'read-note', name: 'file_read', args: { path: 'workspace/note.txt' } }]
          : [
              {
                id: 'done',
                name: 'finish',
                args: {
                  summary: 'Read the note.',
                  answer: 'A synthetic note.',
                  deliverables: ['workspace/note.txt'],
                  verification: evidence('read-note', 'Read the note')
                }
              }
            ]
    }),
    expect: {}
  });
  assert.equal(outcome.error, null);
  assert.equal(outcome.status, 'completed');
});

test('a source URL declared as a deliverable is checked and can be corrected', async () => {
  const outcome = await runFixture({
    id: 'context-delivery-source',
    shape: 'conversation',
    request: 'Read the shipping source.',
    why: 'An unavailable delivery reference must produce a repair turn rather than a harness exception.',
    runner: { pages: { 'https://shipping.example.test/status': 'Shipment SH-931.' } },
    model: ({ index }) => ({
      calls:
        index === 0
          ? [
              {
                id: 'read-source',
                name: 'parallel_web_read',
                args: { urls: ['https://shipping.example.test/status'] }
              }
            ]
          : [
              {
                id: `done-${index}`,
                name: 'finish',
                args: {
                  summary: 'Shipment SH-931.',
                  answer: 'Shipment SH-931.',
                  deliverables: index === 1 ? ['https://shipping.example.test/status'] : [],
                  verification: evidence('read-source', 'Read the shipment')
                }
              }
            ]
    }),
    expect: {}
  });
  assert.equal(outcome.error, null);
  assert.equal(outcome.status, 'completed');
  assert.ok(outcome.events.some((event) => event.summary === 'Declared outputs need delivery'));
});
