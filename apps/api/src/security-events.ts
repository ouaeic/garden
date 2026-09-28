import { redactObject } from '@garden/core';
import type { DataStore } from '@garden/data';

type SecurityEvent = Parameters<DataStore['recordSecurityEvent']>[0];

/**
 * Security events are the record an owner reads after something went wrong, and they are included
 * verbatim in the privacy export. Everything written today is an identifier or a code, which is the
 * policy - but `metadata` is a free-form object, so the policy is enforced here rather than trusted
 * to nineteen call sites and everything added after them. A value that turns out to be a token is
 * stored as `[REDACTED]`, which still tells the owner the event happened.
 */
export const recordSecurityEvent = (store: DataStore, event: SecurityEvent): Promise<void> =>
  store.recordSecurityEvent(
    event.metadata
      ? { ...event, metadata: redactObject(event.metadata) as Record<string, unknown> }
      : event
  );
