import { describe, expect, it } from 'vitest';
import {
  connectorContentOrigin,
  connectorContentOrigins,
  type AnyConnectorKind,
  type ConnectorAction
} from '@garden/core';
import { labelledConnectorResult, untrustedOriginOfResult } from './provenance.js';

/**
 * The word a connector read wears, asserted end to end rather than at either end.
 *
 * `connectorContentOrigins` is a total map - a kind cannot be added to `AnyConnectorKind` without
 * that file failing to compile - but totality at the table bought nothing, because the worker kept
 * a second copy as a chain of ternaries and the taint state was driven from a third place. The two
 * ends were only ever asserted separately: `connectors.test.ts` checked the table, and the worker's
 * own test hand-built `{trust:'untrusted', origin:'github'}` instead of asking the labeller for it.
 * A kind whose envelope named it differently from the table would have passed both.
 *
 * So this walks the live path: label a read the way `performConnectorAction` labels it, then ask
 * `untrustedOriginOfResult` what the turn is now holding, and require the table's word.
 *
 * The `satisfies` below is the part the compiler enforces. Add a connector kind and this file stops
 * compiling until somebody has said what a read through it is called.
 */
const readsThrough = {
  github: { action: 'github_read_file', origin: 'github' },
  webdav: { action: 'webdav_read', origin: 'webdav share' },
  mcp_http: { action: 'mcp_list_tools', origin: 'mcp server' },
  imap: { action: 'mail_list_mailboxes', origin: 'mailbox' },
  caldav: { action: 'calendar_list', origin: 'calendar' },
  google: { action: 'account_mail_read', origin: 'google account' },
  microsoft: { action: 'account_mail_read', origin: 'microsoft account' }
} as const satisfies Record<AnyConnectorKind, { action: ConnectorAction; origin: string }>;

const connectorCall = { id: 'call-1', name: 'connector_action', arguments: {} };

describe('what a connector read is called, from the table to the taint', () => {
  it('gives every kind the table’s word on the live path', () => {
    for (const [kind, { action, origin }] of Object.entries(readsThrough) as Array<
      [AnyConnectorKind, { action: ConnectorAction; origin: string }]
    >) {
      // The table is the source, so the expectation is checked against it rather than duplicating
      // it: a fixture that drifted from the table would otherwise assert the drift.
      expect(connectorContentOrigins[kind], kind).toBe(origin);
      const labelled = labelledConnectorResult(kind, action, { content: 'written by somebody' });
      expect((labelled as Record<string, unknown>).trust, kind).toBe('untrusted');
      expect(untrustedOriginOfResult(connectorCall, labelled), `${kind}/${action}`).toBe(origin);
    }
  });

  /**
   * A box can be newer than the code reading it, and an unnamed origin is still an origin. The one
   * outcome that must not happen is a read coming back with no label at all, because that is what
   * decides whether the turn is allowed to act on what it just read.
   */
  it('still labels a kind this build has never heard of', () => {
    const labelled = labelledConnectorResult('something_new' as AnyConnectorKind, 'mcp_call_tool', {
      content: 'x'
    });
    expect(untrustedOriginOfResult(connectorCall, labelled)).toBe('something_new');
    expect(connectorContentOrigin('something_new')).toBe('something_new');
  });
});
