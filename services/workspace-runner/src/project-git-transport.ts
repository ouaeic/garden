import { GitObjectId, ProjectGitRemoteInput } from '@athanor/contracts';
import { projectGitCommand, projectGitIsAncestor } from './project-git-command.js';

export interface GitRemoteTransport {
  head(): Promise<string | null>;
  fetch(destinationRef: string): Promise<void>;
  push(commit: string, expectedHead: string | null): Promise<void>;
}

/** Credentials remain in the trusted Git child's environment, never in URLs or arguments. */
export function githubGitTransport(
  directory: string,
  raw: ProjectGitRemoteInput,
  token: string,
  signal: AbortSignal,
  run: typeof projectGitCommand = projectGitCommand
): GitRemoteTransport {
  const input = ProjectGitRemoteInput.parse(raw);
  if (!/^[\x21-\x7e]{1,4096}$/.test(token)) throw Error('A valid GitHub credential is required');
  const url = `https://github.com/${input.owner}/${input.repository}.git`;
  const ref = `refs/heads/${input.branch}`;
  const env = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
    GIT_CONFIG_VALUE_0:
      'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64')
  };
  const request = async (args: string[]) => {
    try {
      return await run(
        directory,
        [
          '-c',
          'protocol.https.allow=always',
          '-c',
          'http.followRedirects=false',
          '-c',
          'http.sslVerify=true',
          '-c',
          'credential.helper=',
          '-c',
          'core.askPass=',
          '-c',
          'push.followTags=false',
          '-c',
          'push.gpgSign=false',
          ...args
        ],
        undefined,
        { env, signal }
      );
    } catch {
      // Transport diagnostics can contain credential-bearing provider text.
      throw Error(
        'GitHub transfer did not complete. Verify account access and inspect the remote before retrying.'
      );
    }
  };
  return {
    async head() {
      const raw = (await request(['ls-remote', '--refs', '--', url, ref])).trim();
      if (!raw) return null;
      const fields = raw.split('\t');
      if (fields.length !== 2 || fields[1] !== ref)
        throw Error('The remote branch response was ambiguous');
      return GitObjectId.parse(fields[0]);
    },
    async fetch(destinationRef) {
      if (!/^refs\/garden\/remotes\/[a-f0-9-]{36}$/.test(destinationRef))
        throw Error('Invalid captured remote reference');
      await request([
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        '--no-recurse-submodules',
        '--',
        url,
        `${ref}:${destinationRef}`
      ]);
    },
    async push(commit, expectedHead) {
      GitObjectId.parse(commit);
      if (
        expectedHead &&
        !(await projectGitIsAncestor(directory, GitObjectId.parse(expectedHead), commit))
      )
        throw Error(
          'Integrate and check the remote changes before publishing. History replacement is not permitted.'
        );
      // An explicit lease supplies compare-and-swap; the independent ancestry check forbids rewrites.
      await request([
        'push',
        '--porcelain',
        '--no-verify',
        '--recurse-submodules=no',
        `--force-with-lease=${ref}:${expectedHead ?? ''}`,
        '--',
        url,
        `${commit}:${ref}`
      ]);
    }
  };
}
