import { z } from 'zod';

const Parameters = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), z.json())
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 1024 * 1024,
    'Workflow parameters exceed the metadata budget; pass large data by file path'
  );

export const WorkflowStart = z
  .object({
    action: z.literal('start'),
    name: z.string().min(1).max(120),
    script: z.string().min(1).max(4096),
    configs: z.array(z.string().min(1).max(4096)).max(16).default([]),
    parameters: Parameters.default({}),
    network: z.boolean().default(false)
  })
  .strict();
export const WorkflowRequest = z.discriminatedUnion('action', [
  WorkflowStart,
  z
    .object({
      action: z.literal('list'),
      after: z.uuid().optional(),
      limit: z.number().int().min(1).max(100).default(50)
    })
    .strict(),
  z.object({ action: z.literal('status'), workflowId: z.uuid() }).strict(),
  z.object({ action: z.literal('cancel'), workflowId: z.uuid() }).strict(),
  z
    .object({
      action: z.literal('resume'),
      workflowId: z.uuid(),
      parameters: Parameters.optional()
    })
    .strict()
]);
export type WorkflowRequest = z.infer<typeof WorkflowRequest>;
export type WorkflowStart = z.infer<typeof WorkflowStart>;

export interface WorkflowStage {
  taskId: string;
  name: string;
  hash: string;
  status: 'completed' | 'cached' | 'failed' | 'aborted' | 'unknown';
  exitCode: number | null;
  durationMs: number | null;
  peakMemoryBytes: number | null;
}
export interface WorkflowProgress {
  recordedTasks: number;
  completed: number;
  cached: number;
  failed: number;
  aborted: number;
  recent: WorkflowStage[];
  catchingUp: boolean;
  pendingRecord: boolean;
  observedAt: string;
}
export interface WorkflowRun {
  workflowId: string;
  workspaceId: string;
  ownerTaskId: string;
  name: string;
  engine: 'nextflow';
  engineVersion: string;
  script: string;
  directory: string;
  state: 'preparing' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
  attempt: number;
  canResume: boolean;
  sessionId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: WorkflowProgress | null;
  tracePath: string;
  reportPath: string;
  timelinePath: string;
  note?: string;
}
