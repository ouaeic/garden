import { UNKNOWN_SURFACES, type ConnectorKind } from '@garden/contracts';
import { expect, it } from 'vitest';
import { connectorActions, connectorCatalog, accountOAuthScopes } from '@garden/core';
import { approvalRequirement } from './approval-policy.js';
import { agentToolsFor } from './tool-catalogue.js';

it('describes exact calendar changes when the selected mode requires confirmation', () => {
  const input = {
    calendarId: 'owner@example.org',
    eventId: 'meeting',
    expectedVersion: '"v1"',
    target: 'occurrence',
    changes: {
      summary: 'Review analysis',
      time: { start: '2026-10-20T09:00:00Z', end: '2026-10-20T10:00:00Z', allDay: false },
      attendees: [{ address: 'colleague@example.org' }]
    }
  };
  for (const mode of ['balanced', 'review'] as const) {
    const edit = approvalRequirement(
      'connector_action',
      { action: 'account_calendar_update', input },
      mode
    );
    expect(edit?.sideEffect).toBe('external_reversible');
    expect(edit?.action).toContain('one occurrence');
    expect(edit?.preview).toContain('Review analysis');
    expect(edit?.preview).toContain('colleague@example.org');
    expect(edit?.preview).toContain(input.expectedVersion);
    const deletion = approvalRequirement(
      'connector_action',
      { action: 'account_calendar_delete', input: { ...input, target: 'series' } },
      mode
    );
    expect(deletion?.sideEffect).toBe('external_consequential');
    expect(deletion?.action).toContain('recurring series');
    expect(deletion?.preview).toContain('cancellation');
    expect(
      approvalRequirement(
        'connector_action',
        { action: 'account_calendar_read', input: { eventId: 'meeting' } },
        mode
      )
    ).toBeNull();
  }
});
it('offers conditional mutations only on a provider with the implemented contract and explicit edit/delete grants', () => {
  expect(connectorActions.account_calendar_update.kinds).toEqual(['google']);
  expect(connectorActions.account_calendar_delete.scope).toBe('calendar:events.delete');
  const google = connectorCatalog.find((item) => item.kind === 'google');
  expect(google).toBeDefined();
  expect(google!.scopes.find((item) => item.id === 'calendar:events.write')?.label).toBe(
    'Create calendar events'
  );
  expect(google!.scopes.some((item) => item.id === 'calendar:events.edit')).toBe(true);
  const microsoft = connectorCatalog.find((item) => item.kind === 'microsoft');
  expect(microsoft).toBeDefined();
  expect(microsoft!.scopes.some((item) => item.id === 'calendar:events.edit')).toBe(false);
  expect(() => accountOAuthScopes('microsoft', ['calendar:events.edit'])).toThrow();
  expect(
    accountOAuthScopes('google', ['calendar:events.edit', 'calendar:events.delete'])
  ).toContain('https://www.googleapis.com/auth/calendar.events');
  // The tool's existing kind filter keeps unavailable operations out of the model's catalogue.
  const offered = (kind: ConnectorKind) => {
    const tool = agentToolsFor('lead', UNKNOWN_SURFACES, [kind]).find(
      (tool) => tool.name === 'connector_action'
    );
    expect(tool).toBeDefined();
    const properties = tool!.parameters.properties as { action: { enum: string[] } };
    expect(properties.action.enum.length).toBeGreaterThan(0);
    return properties.action.enum;
  };
  expect(offered('google')).toContain('account_calendar_update');
  expect(offered('microsoft')).not.toContain('account_calendar_update');
  expect(offered('microsoft')).toContain('account_calendar_read');
});
