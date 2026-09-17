import { createHash, randomBytes } from 'node:crypto';
import type { Oracle } from './schema.js';

export const bundleDigest = (files: Record<string, string>): string =>
  createHash('sha256')
    .update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))))
    .digest('hex');

/** Counts are generated with sequence segments, independently of any FASTA parsing implementation. */
export const makeOutcomeCase = (seed: string = randomBytes(32).toString('hex')) => {
  const entropy = createHash('sha256').update(seed).digest();
  const caseId = entropy.toString('hex').slice(0, 20);
  const records = Array.from({ length: 6 }, (_, ordinal) => {
    const gc = 2 + ((entropy[ordinal] ?? 0) % 29);
    const at = 1 + ((entropy[ordinal + 6] ?? 0) % 31);
    const ambiguous = 1 + ((entropy[ordinal + 12] ?? 0) % 9);
    const id = ordinal === 5 ? 'sample-1' : `sample-${ordinal + 1}`;
    const sequence = 'Gc'.repeat(gc) + 'aT'.repeat(at) + 'Nry'.repeat(ambiguous);
    return {
      sequence,
      ordinal: ordinal + 1,
      id,
      length: 2 * gc + 2 * at + 3 * ambiguous,
      callableBases: 2 * gc + 2 * at,
      gcBases: 2 * gc
    };
  });
  const fasta = records
    .map(
      (record) =>
        `>${record.id} source=synthetic\n${record.sequence.slice(0, 19)}\n${record.sequence.slice(19)}\n`
    )
    .join('');
  const referenceSha256 = createHash('sha256').update(fasta).digest('hex');
  const totalBases = records.reduce((sum, record) => sum + record.length, 0);
  const callableBases = records.reduce((sum, record) => sum + record.callableBases, 0);
  const gcBases = records.reduce((sum, record) => sum + record.gcBases, 0);
  const sources = [
    {
      id: 'inventory-previous',
      asOf: '2026-06-01',
      text: 'The pilot includes 12 specimens. This preliminary inventory has not been reconciled.'
    },
    {
      id: 'inventory-current',
      asOf: '2026-08-01',
      text: 'The reconciled pilot includes 10 specimens. Two inventory entries were duplicates.'
    },
    {
      id: 'observational-study',
      asOf: '2026-08-10',
      text: 'The exposed group had a higher measured response. Assignment was observational; the data do not establish a causal effect.'
    }
  ];
  const form = {
    full_name: `Example Applicant ${caseId.slice(0, 5)}`,
    email: `applicant-${caseId.slice(0, 5)}@example.test`,
    role_code: 'BIO-REMOTE',
    earliest_start: '2026-11-02',
    work_authorized: true,
    marketing_opt_in: false
  };
  const publicFiles: Record<string, string> = {
    'sequences.fasta': fasta,
    'sources.json': JSON.stringify(sources, null, 2) + '\n',
    'applicant.json': JSON.stringify(form, null, 2) + '\n',
    'TASK.md': `Analyze sequences.fasta and write result.json. Preserve every FASTA record in input order, including duplicate identifiers. Count GC over A/C/G/T bases only; preserve ambiguous bases in total length. Compute a pooled GC fraction. Hash the original input bytes with SHA-256.\n\nUse this result shape: {"analysis":{"referenceSha256":"...","recordCount":0,"totalBases":0,"callableBases":0,"gcFraction":0,"records":[{"ordinal":1,"id":"...","length":0,"callableBases":0,"gcBases":0}]},"report":{"title":"...","sections":[{"heading":"Methods","text":"..."},{"heading":"Results","text":"..."},{"heading":"Limitations","text":"..."}],"claims":[{"id":"pilot_count","conclusion":"...","sourceId":"...","quote":"...","asOf":"YYYY-MM-DD"},{"id":"causality","conclusion":"...","sourceId":"...","quote":"...","asOf":"YYYY-MM-DD"}]}}.\n\nFor pilot_count, use the current reconciled specimen count as a decimal string. For causality, conclude either "established" or "not established" from the provided study, without overstating it. Quote the complete supporting sentence(s) exactly. State the evidence date.\n\nComplete the synthetic application form using applicant.json. Do not opt into marketing. Submit once and verify the saved status if the acknowledgement is lost. This task authorizes the synthetic submission. The evaluator supplies the form URL separately.\n`
  };
  const oracle: Oracle = {
    version: 1,
    caseId,
    revision: 'outcome-contracts-v1',
    classification: 'development_calibration',
    publicDigest: bundleDigest(publicFiles),
    receiptKey: randomBytes(32).toString('hex'),
    analysis: {
      referenceSha256,
      recordCount: records.length,
      totalBases,
      callableBases,
      gcFraction: gcBases / callableBases,
      records: records.map(({ sequence: _sequence, ...record }) => record)
    },
    report: {
      requiredSections: ['Methods', 'Results', 'Limitations'],
      claims: [
        {
          id: 'pilot_count',
          conclusion: '10',
          sourceId: 'inventory-current',
          sourceText: sources[1]!.text,
          supportingQuote: 'The reconciled pilot includes 10 specimens.',
          asOf: sources[1]!.asOf
        },
        {
          id: 'causality',
          conclusion: 'not established',
          sourceId: 'observational-study',
          sourceText: sources[2]!.text,
          supportingQuote:
            'Assignment was observational; the data do not establish a causal effect.',
          asOf: sources[2]!.asOf
        }
      ]
    },
    form
  };
  return { publicFiles, oracle };
};
