import { z } from 'zod';

const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      !value.split('/').includes('..') &&
      value !== '.'
  );
const paths = z.array(path).max(4096);
const command = z.array(z.string().max(100000)).min(1).max(8192);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const at = z.string().datetime({ offset: true });
const producer = z.object({ manifest: path, sha256: hash, output: path });
const file = z.object({
  path,
  bytes: z.number().int().nonnegative(),
  sha256: hash,
  declaredSourceUrl: z.string().max(8192).optional(),
  producer: producer
    .extend({ runId: z.string().uuid(), name: z.string().max(200).optional() })
    .optional()
});
const files = z.array(file).max(4096);
const probe = z.object({
  name: z.string().max(120),
  command,
  sha256: hash,
  output: z.string().max(131072)
});

const environmentSetup = z.object({
  kind: z.enum(['python_wheels', 'r_archives', 'conda_packages']),
  directory: path,
  status: z.enum(['creating', 'installing', 'ready'])
});

/** A file supplied by a run; these are recorded observations, not live verification. */
export const AnalysisRunRecord = z.object({
  format: z.literal('garden-analysis-run-1'),
  id: z.string().uuid(),
  status: z.enum(['preparing', 'running', 'verifying', 'completed', 'failed', 'interrupted']),
  createdAt: at,
  startedAt: at.optional(),
  commandFinishedAt: at.optional(),
  finishedAt: at.optional(),
  directoryFromManifest: z.string().max(4096).optional(),
  replayedFrom: z.string().uuid().optional(),
  exitCode: z.number().int().optional(),
  error: z.string().max(65536).optional(),
  dependenciesUnchanged: z.boolean().optional(),
  outputsMatchPrevious: z.boolean().optional(),
  environmentSetup: environmentSetup.optional(),
  environmentSetups: z
    .array(environmentSetup)
    .min(1)
    .max(3)
    .refine((setups) => new Set(setups.map((setup) => setup.kind)).size === setups.length)
    .optional(),
  spec: z.object({
    name: z.string().max(200).optional(),
    command,
    sources: paths,
    inputs: z
      .array(
        z.object({
          path,
          sourceUrl: z.string().max(8192).optional(),
          sha256: hash.optional(),
          producer: producer.optional()
        })
      )
      .max(4096),
    outputs: paths,
    environment: z.object({
      lockFiles: paths,
      runtimeOnly: z.boolean().optional(),
      python: z
        .object({
          interpreter: z.string().min(1).max(100000),
          directory: path,
          wheels: z
            .array(z.object({ path, sha256: hash }))
            .min(1)
            .max(4096)
        })
        .optional(),
      r: z
        .object({
          interpreter: z.string().min(1).max(100000),
          directory: path,
          packages: z
            .array(z.object({ path, sha256: hash }))
            .min(1)
            .max(4096)
        })
        .optional(),
      conda: z
        .object({
          manager: z.object({ path, sha256: hash }),
          directory: path,
          packages: z
            .array(z.object({ path, sha256: hash }))
            .min(1)
            .max(4096)
        })
        .optional(),
      probes: z.array(z.object({ name: z.string().max(120), command })).max(32)
    }),
    seeds: z
      .record(z.string().max(120), z.union([z.string().max(200), z.number().int()]))
      .refine((value) => Object.keys(value).length <= 32)
      .optional()
  }),
  before: z
    .object({
      sources: files,
      inputs: files,
      locks: files,
      // Declared probes plus one package inventory per reconstructible runtime.
      probes: z.array(probe).max(32 + 3),
      platform: z.object({ system: z.string(), release: z.string(), architecture: z.string() })
    })
    .optional(),
  outputs: files.optional()
});
export type AnalysisRunRecord = z.infer<typeof AnalysisRunRecord>;
export type AnalysisRunFile = z.infer<typeof file>;
