import { z } from 'zod';

export const GitObjectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const ProjectRepositoryInput = z
  .object({
    requestId: z.uuid(),
    revisionId: z.uuid(),
    name: z.string().trim().min(1).max(120),
    path: z
      .string()
      .max(4096)
      .refine((value) => !value.includes('\0')),
    historyPath: z.string().min(1).max(4096).optional(),
    branch: z
      .string()
      .min(1)
      .max(240)
      .refine((value) =>
        [...value].every((char) => char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127)
      )
      .default('main'),
    format: z.enum(['sha1', 'sha256']).default('sha1')
  })
  .strict();
export type ProjectRepositoryInput = z.infer<typeof ProjectRepositoryInput>;

export interface ProjectRepository {
  id: string;
  name: string;
  path: string;
  branch: string;
  format: 'sha1' | 'sha256';
  head: string;
  createdAt: string;
}
export interface ProjectGitVersion {
  repositoryId: string;
  branch: string;
  base: string;
  commit: string;
  tree: string;
  proposalRef: string;
}
export interface ProjectGitCommit {
  id: string;
  parents: string[];
  date: string;
  subject: string;
}
export interface ProjectRepositoryHistory {
  repository: ProjectRepository;
  commits: ProjectGitCommit[];
  next: string | null;
  branches: Array<{ name: string; commit: string }>;
  branchesTruncated: boolean;
}

export const ProjectRepositoryOperation = z.object({
  input: ProjectRepositoryInput,
  state: z.enum(['preparing', 'ready', 'failed']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  detail: z.string().nullable()
});
export type ProjectRepositoryOperation = z.infer<typeof ProjectRepositoryOperation>;
export interface ProjectRepositories {
  repositories: ProjectRepository[];
  operations: ProjectRepositoryOperation[];
  exports: ProjectGitExport[];
  removals: ProjectRepositoryRemoval[];
}

export const ProjectGitExportInput = z
  .object({ requestId: z.uuid(), commit: GitObjectId })
  .strict();
export const ProjectGitExport = z.object({
  requestId: z.uuid(),
  repositoryId: z.uuid(),
  commit: GitObjectId,
  state: z.enum(['preparing', 'ready', 'failed']),
  createdAt: z.iso.datetime(),
  bytes: z.number().int().nonnegative(),
  detail: z.string().nullable()
});
export type ProjectGitExport = z.infer<typeof ProjectGitExport>;

export const ProjectRepositoryRemovalInput = z
  .object({ requestId: z.uuid(), head: GitObjectId })
  .strict();
export const ProjectRepositoryRemoval = ProjectRepositoryRemovalInput.extend({
  repositoryId: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  state: z.enum(['removing', 'removed', 'failed']),
  detail: z.string().nullable()
});
export type ProjectRepositoryRemoval = z.infer<typeof ProjectRepositoryRemoval>;
