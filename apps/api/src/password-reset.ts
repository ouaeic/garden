#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createDatabase, DataStore } from '@garden/data';
import { sha256 } from '@garden/core';
import { loadConfig } from './config.js';

// Root already owns the control-plane credentials. Only a short-lived grant leaves this process.
if (process.getuid?.() !== 0) throw new Error('Run sudo garden password-reset on the server.');
process.loadEnvFile(path.join(process.env.GARDEN_CONFIG || '/etc/garden', 'control.env'));
const config = loadConfig();
const database = createDatabase({
  driver: config.DATABASE_DRIVER,
  url: config.DATABASE_URL,
  pglitePath: config.PGLITE_PATH
});
try {
  const store = new DataStore(database);
  const owner = await store.soleUser();
  if (!owner) throw new Error('Password recovery requires an existing single-owner account.');
  const token = randomBytes(32).toString('base64url');
  await store.createPasswordReset(owner.id, sha256(token));
  process.stdout.write(
    `Open this one-time link to choose your password:\n${config.PUBLIC_APP_URL.replace(/\/+$/, '')}/#password-reset=${token}\n\nIt expires in 15 minutes. Existing access changes only after you save a new password.\n`
  );
} finally {
  await database.close();
}
