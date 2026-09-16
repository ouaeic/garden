import { createHmac, randomUUID } from 'node:crypto';
import { chmod, lstat } from 'node:fs/promises';
import { durableMkdir } from './project-version-files.js';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decryptJson, encryptJson, type EncryptedEnvelope } from '@athanor/core';
import { WorkflowStart } from '@athanor/contracts';
import { z } from 'zod';

const Spec = WorkflowStart.omit({ action: true });
const Record = z.object({
  workflowId: z.uuid(),
  owner: z.string(),
  workspaceId: z.string(),
  spec: Spec,
  attempt: z.number().int().positive(),
  createdAt: z.string(),
  engineVersion: z.string()
});
const Attempt = z.object({
  number: z.number().int().positive(),
  engineVersion: z.string(),
  requestId: z.string(),
  parameters: WorkflowStart.shape.parameters,
  resumeSession: z.string().optional(),
  phase: z.enum(['prepared', 'dispatching', 'launched', 'cancelled']),
  jobId: z.string().nullable(),
  state: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  note: z.string().optional()
});
export type WorkflowRecord = z.infer<typeof Record>;
export type WorkflowAttempt = z.infer<typeof Attempt>;
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)])
        )
      : value;

/** Encrypted intents are committed before a job is dispatched, independently of HTTP replies. */
export class WorkflowStore {
  constructor(private readonly secret: string) {}
  async #use<T>(root: string, work: (db: DatabaseSync, key: Buffer) => T): Promise<T> {
    const directory = path.join(root, '.athanor', 'workflows');
    await durableMkdir(directory, 0o700);
    if (!(await lstat(directory)).isDirectory())
      throw new Error('Invalid workflow store directory');
    const filename = path.join(directory, 'runs.sqlite');
    const existing = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (existing && !existing.isFile()) throw new Error('Invalid workflow store');
    const db = new DatabaseSync(filename);
    try {
      await chmod(filename, 0o600);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      db.exec(`CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS attempts (workflow TEXT NOT NULL, number INTEGER NOT NULL, job TEXT, value TEXT NOT NULL, PRIMARY KEY(workflow,number));
        CREATE TABLE IF NOT EXISTS requests (owner TEXT NOT NULL, id TEXT NOT NULL, digest TEXT NOT NULL, workflow TEXT NOT NULL, attempt INTEGER NOT NULL, PRIMARY KEY(owner,id));
        CREATE INDEX IF NOT EXISTS attempts_job ON attempts(job);
        CREATE INDEX IF NOT EXISTS runs_owner ON runs(owner,id);`);
      const key = createHmac('sha256', this.secret)
        .update('workflow-records\0' + root)
        .digest();
      return work(db, key);
    } finally {
      db.close();
    }
  }
  #read<T>(value: string, key: Buffer, aad: string, schema: z.ZodType<T>): T {
    return schema.parse(decryptJson(JSON.parse(value) as EncryptedEnvelope, key, aad));
  }
  #get(db: DatabaseSync, key: Buffer, id: string, owner: string | null) {
    const row = db.prepare('SELECT owner,value FROM runs WHERE id=?').get(id) as
      | { owner: string; value: string }
      | undefined;
    if (!row || (owner !== null && row.owner !== owner)) throw new Error('Workflow not found');
    return this.#read(row.value, key, id, Record);
  }
  #attempt(db: DatabaseSync, key: Buffer, id: string, number: number) {
    const row = db
      .prepare('SELECT value FROM attempts WHERE workflow=? AND number=?')
      .get(id, number) as { value: string } | undefined;
    if (!row) throw new Error('Workflow attempt not found');
    return this.#read(row.value, key, `${id}:${number}`, Attempt);
  }
  #saveAttempt(db: DatabaseSync, key: Buffer, id: string, attempt: WorkflowAttempt) {
    db.prepare(
      'INSERT INTO attempts(workflow,number,job,value) VALUES (?,?,?,?) ON CONFLICT(workflow,number) DO UPDATE SET job=excluded.job,value=excluded.value'
    ).run(
      id,
      attempt.number,
      attempt.jobId,
      JSON.stringify(encryptJson(Attempt.parse(attempt), key, `${id}:${attempt.number}`))
    );
  }
  get(root: string, id: string, owner: string | null) {
    return this.#use(root, (db, key) => {
      const record = this.#get(db, key, id, owner);
      return { record, attempt: this.#attempt(db, key, id, record.attempt) };
    });
  }
  list(root: string, owner: string | null, after = '', limit = 50) {
    return this.#use(root, (db, key) => {
      const rows = (
        owner === null
          ? db
              .prepare('SELECT id,value FROM runs WHERE id>? ORDER BY id LIMIT ?')
              .all(after, limit + 1)
          : db
              .prepare('SELECT id,value FROM runs WHERE owner=? AND id>? ORDER BY id LIMIT ?')
              .all(owner, after, limit + 1)
      ) as { id: string; value: string }[];
      const records = rows.slice(0, limit).map((row) => this.#read(row.value, key, row.id, Record));
      return {
        records: records.map((record) => ({
          record,
          attempt: this.#attempt(db, key, record.workflowId, record.attempt)
        })),
        next: rows.length > limit ? records.at(-1)!.workflowId : null
      };
    });
  }
  forJobs(root: string, ids: readonly string[]) {
    if (!ids.length) return Promise.resolve([]);
    return this.#use(root, (db, key) => {
      const found: Array<{ record: WorkflowRecord; attempt: WorkflowAttempt }> = [];
      for (let index = 0; index < ids.length; index += 100) {
        const page = ids.slice(index, index + 100);
        const rows = db
          .prepare(
            `SELECT runs.id, runs.value AS record, attempts.number, attempts.value AS attempt FROM attempts JOIN runs ON runs.id=attempts.workflow WHERE attempts.job IN (${page.map(() => '?').join(',')})`
          )
          .all(...page) as Array<{ id: string; record: string; number: number; attempt: string }>;
        for (const row of rows)
          found.push({
            record: this.#read(row.record, key, row.id, Record),
            attempt: this.#read(row.attempt, key, `${row.id}:${row.number}`, Attempt)
          });
      }
      return found;
    });
  }
  lookup(root: string, owner: string, requestId: string, request: unknown) {
    return this.#use(root, (db, key) => {
      const prior = db
        .prepare('SELECT digest,workflow,attempt FROM requests WHERE owner=? AND id=?')
        .get(owner, requestId) as { digest: string; workflow: string; attempt: number } | undefined;
      if (!prior) return null;
      const digest = createHmac('sha256', key)
        .update(JSON.stringify(canonical(request)))
        .digest('hex');
      if (prior.digest !== digest)
        throw new Error('Workflow request identity was reused with different arguments');
      return {
        record: this.#get(db, key, prior.workflow, owner),
        attempt: this.#attempt(db, key, prior.workflow, prior.attempt)
      };
    });
  }
  claim(
    root: string,
    owner: string,
    requestId: string,
    request: unknown,
    create: () => Omit<WorkflowRecord, 'workflowId' | 'attempt'>,
    resume?: {
      workflowId: string;
      attempt: number;
      parameters: WorkflowAttempt['parameters'];
      resumeSession: string;
      engineVersion: string;
      reusePrepared: boolean;
    }
  ) {
    if (!requestId || requestId.length > 256)
      throw new Error('Workflow request requires a stable requestId');
    return this.#use(root, (db, key) => {
      const digest = createHmac('sha256', key)
        .update(JSON.stringify(canonical(request)))
        .digest('hex');
      db.exec('BEGIN IMMEDIATE');
      try {
        const prior = db
          .prepare('SELECT digest,workflow,attempt FROM requests WHERE owner=? AND id=?')
          .get(owner, requestId) as
          | { digest: string; workflow: string; attempt: number }
          | undefined;
        if (prior) {
          if (prior.digest !== digest)
            throw new Error('Workflow request identity was reused with different arguments');
          const record = this.#get(db, key, prior.workflow, owner),
            attempt = this.#attempt(db, key, prior.workflow, prior.attempt);
          db.exec('COMMIT');
          return { record, attempt, repeated: true };
        }
        const record: WorkflowRecord = resume
          ? this.#get(db, key, resume.workflowId, owner)
          : { ...create(), workflowId: randomUUID(), attempt: 1 };
        let retained: WorkflowAttempt | undefined;
        if (resume) {
          if (record.attempt !== resume.attempt)
            throw new Error('Workflow changed while resuming; read its current state');
          const current = this.#attempt(db, key, record.workflowId, record.attempt);
          if (resume.reusePrepared) {
            if (current.phase !== 'prepared')
              throw new Error('Workflow launch state changed; read its current state');
            retained = { ...current, engineVersion: resume.engineVersion };
          } else {
            if (current.phase === 'prepared')
              throw new Error('Workflow launch has not been dispatched');
            record.attempt++;
          }
        }
        const attempt: WorkflowAttempt = retained ?? {
          number: record.attempt,
          engineVersion: resume?.engineVersion ?? record.engineVersion,
          requestId,
          parameters: resume?.parameters ?? record.spec.parameters,
          phase: 'prepared',
          jobId: null,
          ...(resume ? { resumeSession: resume.resumeSession } : {})
        };
        db.prepare(
          'INSERT INTO runs(id,owner,value) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value'
        ).run(
          record.workflowId,
          owner,
          JSON.stringify(encryptJson(Record.parse(record), key, record.workflowId))
        );
        this.#saveAttempt(db, key, record.workflowId, attempt);
        db.prepare('INSERT INTO requests(owner,id,digest,workflow,attempt) VALUES (?,?,?,?,?)').run(
          owner,
          requestId,
          digest,
          record.workflowId,
          attempt.number
        );
        db.exec('COMMIT');
        return { record, attempt, repeated: false };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    });
  }
  update(
    root: string,
    workflowId: string,
    owner: string | null,
    number: number,
    change: Partial<Omit<WorkflowAttempt, 'number' | 'requestId' | 'parameters' | 'resumeSession'>>
  ) {
    return this.#use(root, (db, key) => {
      this.#get(db, key, workflowId, owner);
      const attempt = { ...this.#attempt(db, key, workflowId, number), ...change };
      this.#saveAttempt(db, key, workflowId, attempt);
      return attempt;
    });
  }
}
