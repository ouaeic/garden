import type { WorkflowRun } from './workflows.js';
export interface ProcessResourceSample {
  sampledAt: string;
  intervalMs: number | null;
  cpuPercent: number | null;
  residentBytes: number;
  processCount: number;
  threadCount: number;
  children: Array<{
    pid: number;
    name: string;
    state: string;
    residentBytes: number;
    threads: number;
    ranForMs?: number;
  }>;
}

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
