import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeOutcomeCase, bundleDigest } from './fixture.js';
import { prepareCase, readJson } from './files.js';
import { gradeOutcomes, signObservation } from './grade.js';
import { startFormFixture } from './form.js';
import type { Observation, OutcomeArtifact, SignedObservation } from './schema.js';

export const unknownMetrics = () => ({
  completed: null,
  model: null,
  provider: null,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  elapsedMs: null,
  interventions: null
});

// This calibration solver parses the public FASTA; the generator counts its construction segments.
const solvePublicInputs = (files: Record<string, string>): OutcomeArtifact => {
  const fasta = files['sequences.fasta'];
  assert.ok(fasta);
  const records: OutcomeArtifact['analysis']['records'] = [];
  for (const entry of fasta.split('>').filter(Boolean)) {
    const [header, ...lines] = entry.split('\n');
    const sequence = lines.join('').toUpperCase();
    const id = header?.split(' ')[0];
    assert.ok(id);
    records.push({
      ordinal: records.length + 1,
      id,
      length: sequence.length,
      callableBases: sequence.match(/[ACGT]/g)?.length ?? 0,
      gcBases: sequence.match(/[GC]/g)?.length ?? 0
    });
  }
  assert.ok(records.length > 0);
  const callableBases = records.reduce((sum, row) => sum + row.callableBases, 0);
  return {
    analysis: {
      referenceSha256: createHash('sha256').update(fasta).digest('hex'),
      recordCount: records.length,
      totalBases: records.reduce((sum, row) => sum + row.length, 0),
      callableBases,
      gcFraction: records.reduce((sum, row) => sum + row.gcBases, 0) / callableBases,
      records
    },
    report: {
      title: 'Synthetic sequence analysis',
      sections: [
        {
          heading: 'Methods',
          text: 'Counted every record separately and used A/C/G/T in the pooled GC denominator.'
        },
        {
          heading: 'Results',
          text: 'The structured analysis records the pooled counts and preserves input record order.'
        },
        {
          heading: 'Limitations',
          text: 'Synthetic sequences cannot establish a biological mechanism.'
        }
      ],
      claims: [
        {
          id: 'pilot_count',
          conclusion: '10',
          sourceId: 'inventory-current',
          quote: 'The reconciled pilot includes 10 specimens.',
          asOf: '2026-08-01'
        },
        {
          id: 'causality',
          conclusion: 'not established',
          sourceId: 'observational-study',
          quote: 'Assignment was observational; the data do not establish a causal effect.',
          asOf: '2026-08-10'
        }
      ]
    }
  };
};

const runCli = async (args: string[], onReady?: (url: string) => Promise<void>) => {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./run.ts', import.meta.url)), ...args],
    {
      env: { ...process.env, NODE_OPTIONS: '--conditions=development' },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  let stdout = '';
  let stderr = '';
  let handling: Promise<void> | undefined;
  let readyError: Error | undefined;
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    if (onReady && !handling && stdout.includes('\n')) {
      handling = (async () => {
        try {
          const ready = JSON.parse(stdout.split('\n')[0] ?? '') as { url: string };
          await onReady(ready.url);
        } catch (error) {
          readyError = error instanceof Error ? error : new Error(String(error));
        } finally {
          child.kill('SIGTERM');
        }
      })();
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    await handling;
    if (readyError) throw readyError;
    assert.equal(code, 0, stderr);
    return stdout;
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
  }
};

export const selfTest = async () => {
  const checked: string[] = [];
  const root = await mkdtemp(path.join(os.tmpdir(), 'garden-outcomes-'));
  try {
    for (const seed of ['wrapped', 'duplicate', 'ambiguous', 'mixed-case']) {
      const { oracle, publicFiles } = makeOutcomeCase(seed);
      const answer = solvePublicInputs(publicFiles);
      const observed: Observation = {
        ...unknownMetrics(),
        version: 1,
        caseId: oracle.caseId,
        publicDigest: bundleDigest(publicFiles),
        completed: true,
        interventions: [],
        faults: [],
        recovered: null,
        submissions: [
          {
            id: 'saved',
            fields: JSON.parse(publicFiles['applicant.json'] ?? '') as typeof oracle.form
          }
        ]
      };
      const receipt = signObservation(oracle, observed);
      assert.equal(gradeOutcomes(oracle, answer, receipt).verified, true);
      const mutations: [string, (bad: OutcomeArtifact) => void][] = [
        [
          'wrong_denominator',
          (bad) => {
            bad.analysis.gcFraction =
              bad.analysis.records.reduce((sum, row) => sum + row.gcBases, 0) /
              bad.analysis.totalBases;
          }
        ],
        [
          'dropped_duplicate',
          (bad) => {
            bad.analysis.records.pop();
            bad.analysis.recordCount--;
          }
        ],
        [
          'wrong_reference',
          (bad) => {
            bad.analysis.referenceSha256 = '0'.repeat(64);
          }
        ],
        [
          'incomplete_document',
          (bad) => {
            bad.report.sections.pop();
          }
        ],
        [
          'empty_section',
          (bad) => {
            bad.report.sections[0]!.text = '   ';
          }
        ],
        [
          'fabricated_quote',
          (bad) => {
            bad.report.claims[0]!.quote = 'The reconciled pilot includes 14 specimens.';
          }
        ],
        [
          'stale_claim',
          (bad) => {
            bad.report.claims[0]!.conclusion = '12';
          }
        ],
        [
          'unsupported_causality',
          (bad) => {
            bad.report.claims[1]!.conclusion = 'established';
          }
        ],
        [
          'irrelevant_real_quote',
          (bad) => {
            bad.report.claims[1]!.quote = 'The exposed group had a higher measured response.';
          }
        ],
        [
          'wrong_evidence_date',
          (bad) => {
            bad.report.claims[0]!.asOf = '2026-06-01';
          }
        ],
        [
          'missing_claim',
          (bad) => {
            bad.report.claims.pop();
          }
        ]
      ];
      assert.ok(mutations.length > 0);
      for (const [name, mutate] of mutations) {
        const bad = structuredClone(answer);
        mutate(bad);
        const grade = gradeOutcomes(oracle, bad, receipt);
        assert.equal(grade.verified, false, name);
        assert.equal(grade.completion, true, 'Completion must not excuse incorrect outcomes');
        checked.push(`${seed}/${name}`);
      }
      const wrongForm = structuredClone(observed);
      wrongForm.submissions[0]!.fields['marketing_opt_in'] = true;
      assert.equal(
        gradeOutcomes(oracle, answer, signObservation(oracle, wrongForm)).correctness.form,
        false
      );
      const duplicate = {
        ...observed,
        submissions: [...observed.submissions, ...observed.submissions]
      };
      assert.equal(
        gradeOutcomes(oracle, answer, signObservation(oracle, duplicate)).correctness.form,
        false
      );
      const tampered = structuredClone(receipt);
      tampered.payload.costUsd = 0;
      const untrusted = gradeOutcomes(oracle, answer, tampered);
      assert.equal(untrusted.verified, false);
      assert.equal(untrusted.efficiency.costUsd, null);
      assert.equal(untrusted.completion, null);
      assert.equal(gradeOutcomes(oracle, answer, receipt).efficiency.costUsd, null);
      assert.equal(
        gradeOutcomes(makeOutcomeCase('another-case').oracle, answer, receipt).verified,
        false
      );
      const fullQuotes = structuredClone(answer);
      for (const claim of fullQuotes.report.claims)
        claim.quote = oracle.report.claims.find((expected) => expected.id === claim.id)!.sourceText;
      assert.equal(gradeOutcomes(oracle, fullQuotes, receipt).verified, true);
      checked.push(`${seed}/form_and_integrity`);
    }

    const prepared = await prepareCase(path.join(root, 'public'), path.join(root, 'private'));
    const oracleFile = path.join(prepared.privateRoot, 'oracle.json');
    assert.equal((await stat(prepared.privateRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(oracleFile)).mode & 0o777, 0o600);
    await assert.rejects(
      prepareCase(path.join(root, 'public'), path.join(root, 'public', 'secrets'))
    );
    await symlink(oracleFile, path.join(root, 'symlink.json'));
    await assert.rejects(readJson(path.join(root, 'symlink.json')));
    await writeFile(path.join(root, 'large.json'), ' '.repeat(1_048_577));
    await assert.rejects(readJson(path.join(root, 'large.json')));
    const oracleText = await readFile(oracleFile, 'utf8');
    assert.ok(oracleText.includes('receiptKey'));
    assert.equal(
      (await readFile(path.join(prepared.publicRoot, 'TASK.md'), 'utf8')).includes('receiptKey'),
      false
    );
    checked.push('separate_private_oracle', 'bounded_regular_files');
    const cliPublic = path.join(root, 'cli public');
    const cliPrivate = path.join(root, 'cli private');
    await runCli(['prepare', cliPublic, cliPrivate]);
    await runCli(['serve', cliPrivate, cliPublic, '--lose-ack', '--port=0'], async (url) => {
      assert.equal((await fetch(url)).status, 200);
      assert.equal((await fetch(`${url}/inputs/TASK.md`)).status, 200);
      assert.equal((await fetch(`${url}/inputs/oracle.json`)).status, 404);
    });
    const cliReceipt = (await readJson(path.join(cliPrivate, 'receipt.json'))) as SignedObservation;
    assert.equal(cliReceipt.payload.completed, null);
    assert.equal(cliReceipt.payload.costUsd, null);
    checked.push('cli_prepare_serve_shutdown_receipt');

    const { oracle, publicFiles } = makeOutcomeCase('fault-recovery');
    const stateFile = path.join(root, 'form-state.json');
    let fixture = await startFormFixture({
      oracle,
      publicFiles,
      stateFile,
      loseAcknowledgement: true
    });
    try {
      const page = await (await fetch(fixture.url)).text();
      assert.equal(
        await (await fetch(`${fixture.url}/inputs/sequences.fasta`)).text(),
        publicFiles['sequences.fasta']
      );
      assert.equal((await fetch(`${fixture.url}/inputs/oracle.json`)).status, 404);
      const key = /key:'([a-f0-9]{32})'/.exec(page)?.[1];
      assert.ok(key);
      const fields = JSON.parse(publicFiles['applicant.json'] ?? '') as typeof oracle.form;
      const request = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, fields })
      };
      await assert.rejects(fetch(`${fixture.url}/submit`, request));
      const before = await fixture.observe(unknownMetrics());
      assert.deepEqual(before.payload.faults, ['response_lost_after_submission']);
      assert.equal(before.payload.submissions.length, 1);
      assert.equal(before.payload.recovered, null);
      const route = new URL(fixture.url).pathname;
      await fixture.close();
      fixture = await startFormFixture({ oracle, publicFiles, stateFile });
      assert.equal(new URL(fixture.url).pathname, route);
      const saved = await fetch(`${fixture.url}/status`);
      assert.equal(saved.status, 200);
      const duplicates = await Promise.all(
        Array.from({ length: 3 }, () => fetch(`${fixture.url}/submit`, request))
      );
      assert.ok(duplicates.length > 0);
      for (const response of duplicates) {
        assert.equal(response.status, 200);
        await response.arrayBuffer();
      }
      const conflicting = await fetch(`${fixture.url}/submit`, {
        ...request,
        body: JSON.stringify({ key, fields: { ...fields, marketing_opt_in: true } })
      });
      assert.equal(conflicting.status, 409);
      await conflicting.arrayBuffer();
      const receipt: SignedObservation = await fixture.observe({
        ...unknownMetrics(),
        completed: true,
        interventions: []
      });
      const result = gradeOutcomes(oracle, solvePublicInputs(publicFiles), receipt);
      assert.equal(result.verified, true);
      assert.equal(result.recovery?.recovered, true);
      assert.equal(receipt.payload.submissions.length, 1);
      assert.equal((await fetch(`${fixture.url}/oracle`)).status, 404);
      assert.equal(
        (await fetch(`${fixture.url}/sign`, { method: 'POST', body: '{}' })).status,
        404
      );
      checked.push(
        'real_post_observation',
        'lost_acknowledgement',
        'fixture_restart',
        'idempotent_retry',
        'conflicting_retry_refused',
        'no_oracle_or_signing_route'
      );
    } finally {
      await fixture.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  return {
    classification: 'development_calibration',
    paidModelCalls: 0,
    passed: true,
    checks: checked
  };
};
