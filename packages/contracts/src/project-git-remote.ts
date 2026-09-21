import { z } from 'zod';
import { GitObjectId } from './project-git.js';

const RepositoryName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,100}$/)
  .refine((value) => !['.', '..'].includes(value));
const Branch = z
  .string()
  .min(1)
  .max(240)
  .refine((value) =>
    [...value].every((char) => char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127)
  );
const Identity = z.object({
  requestId: z.uuid(),
  repositoryId: z.uuid(),
  connectorId: z.uuid(),
  owner: RepositoryName,
  repository: RepositoryName,
  branch: Branch
});
export const ProjectGitRemoteInput = z.discriminatedUnion('action', [
  Identity.extend({ action: z.literal('fetch') }).strict(),
  Identity.extend({
    action: z.literal('push'),
    revisionId: z.uuid(),
    commit: GitObjectId,
    expectedHead: GitObjectId.nullable()
  }).strict()
]);
export type ProjectGitRemoteInput = z.infer<typeof ProjectGitRemoteInput>;
export const ProjectGitRemoteOperation = z.object({
  input: ProjectGitRemoteInput,
  taskId: z.uuid().nullable(),
  workspaceId: z.uuid().nullable(),
  state: z.enum(['running', 'succeeded', 'rejected', 'uncertain', 'interrupted']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  phase: z.enum(['fetching', 'checking', 'pushing', 'verifying', 'finished']),
  commit: GitObjectId.nullable(),
  bundlePath: z.string().nullable(),
  detail: z.string().nullable()
});
export type ProjectGitRemoteOperation = z.infer<typeof ProjectGitRemoteOperation>;

const GitHubSource = z.object({
  repositoryId: z.uuid(),
  owner: RepositoryName,
  repository: RepositoryName,
  branch: Branch,
  requestId: z.uuid().optional()
});
export const GitHubProjectActions = [
  GitHubSource.extend({ action: z.literal('github_git_fetch') }).strict(),
  GitHubSource.extend({
    action: z.literal('github_git_push'),
    revisionId: z.uuid(),
    commit: GitObjectId,
    expectedHead: GitObjectId.nullable()
  }).strict(),
  z.object({ action: z.literal('github_git_status'), requestId: z.uuid() }).strict()
] as const;
export const GitHubProjectAction = z.discriminatedUnion('action', GitHubProjectActions);
export type GitHubProjectAction = z.infer<typeof GitHubProjectAction>;
