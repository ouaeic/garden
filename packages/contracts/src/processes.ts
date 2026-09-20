import { z } from 'zod';
import type { ComputationSession } from './computation.js';
import type { WorkflowRun } from './workflows.js';
export const ProcessResourceSampleSchema = z.object({
  sampledAt: z.string(),
  intervalMs: z.number().finite().nonnegative().nullable(),
  cpuPercent: z.number().finite().nonnegative().nullable(),
  residentBytes: z.number().int().nonnegative(),
  processCount: z.number().int().nonnegative(),
  threadCount: z.number().int().nonnegative(),
  children: z.array(
    z.object({
      pid: z.number().int().positive(),
      name: z.string(),
      state: z.string(),
      residentBytes: z.number().int().nonnegative(),
      threads: z.number().int().nonnegative(),
      ranForMs: z.number().finite().nonnegative().optional()
    })
  )
});
export type ProcessResourceSample = z.infer<typeof ProcessResourceSampleSchema>;

export interface ManagedProcess {
  sessionId: string;
  ownerTaskId?: string;
  workspaceId?: string;
  status: string;
  command: string[] | string;
  startedAt: string;
  ranForMs: number;
  outputBytes: number;
  finishedAt?: string;
  deadlineAt?: string;
  exitCode?: number | null;
  terminal?: { columns: number; rows: number; streams: 'combined' };
  workflow?: WorkflowRun;
  lifetime?: 'task' | 'service' | 'job';
  resources?: ProcessResourceSample;
  resourceState?: 'pending' | 'available' | 'unavailable';
  service?: { name?: string; state?: string; restarts?: number; listening?: string[] };
  job?: {
    jobId: string;
    name: string;
    state: string;
    createdAt: string;
    startedAt: string;
    restarts: number;
    checkpointResumable: boolean;
    lastExit?: { exitCode?: number | null; reason?: string };
  };
}

export interface ProcessList {
  computationSessions?: ComputationSession[];
  unavailableComputationWorkspaces?: number;
  processes: ManagedProcess[];
  observedAt?: string;
  refreshAfterMs?: number;
  resourcesAvailable?: boolean;
  host?: {
    logicalCpus: number | null;
    memoryBytes: number;
    commandMemoryLimitBytes: number | null;
  };
  agentListeners?: string[];
  reachableFromOutsideThisComputer?: string[];
  note?: string;
  unavailableWorkspaces?: number;
}
