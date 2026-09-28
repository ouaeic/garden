import { registerProjectSessionRoutes } from './project-sessions.js';
/**
 * The screen, the shell and the desktop, proxied to the workspace runner.
 *
 * The three `*-token` routes hand back a runner capability - a terminal one is an interactive
 * shell on the box - so they are a session-cookie flow only. No API token scope reaches them; see
 * `streamCredentialRoutes` in `http/auth-hook.ts`.
 */

import {
  BrowserAction,
  BrowserTabRetentionRequest,
  DesktopAction,
  DesktopHolder,
  DesktopLaunchRequest
} from '@garden/contracts';
import { GardenError, MAX_CAPABILITY_TTL_SECONDS } from '@garden/core';
import { z } from 'zod';
import { requireUser } from '../http/auth-hook.js';
import type { RouteContext } from '../http/server-context.js';
import { registerProjectProcessRoutes } from './project-processes.js';

export const registerRunnerProxyRoutes = (context: RouteContext): void => {
  registerProjectProcessRoutes(context);
  registerProjectSessionRoutes(context);
  const { app, store, runner, config, idempotent } = context;
  app.post<{ Params: { workspaceId: string; tab: string } }>(
    '/v1/workspaces/:workspaceId/browser/tabs/:tab/retention',
    async (request, reply) => {
      const user = requireUser(request.user);
      if (request.apiToken)
        throw new GardenError(
          'session_required',
          'Manage browser tabs from a signed-in device',
          403
        );
      return idempotent(request, reply, user, async () => {
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
        const tab = z
          .string()
          .regex(/^tab-[1-9]\d*$/)
          .max(32)
          .parse(request.params.tab);
        const body = BrowserTabRetentionRequest.parse(request.body);
        return runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['browser.control'],
          path: `/v1/workspaces/${workspace.id}/browser/tabs/${tab}/retention`,
          method: 'POST',
          body: JSON.stringify(body),
          contentType: 'application/json'
        });
      });
    }
  );
  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser/snapshot',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      return runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['browser.read'],
        path: `/v1/workspaces/${workspace.id}/browser/snapshot`,
        method: 'POST',
        body: '{}',
        contentType: 'application/json'
      });
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser/action',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
        const action = BrowserAction.parse(request.body);
        return runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['browser.control'],
          path: `/v1/workspaces/${workspace.id}/browser/action`,
          method: 'POST',
          body: JSON.stringify(action),
          contentType: 'application/json'
        });
      });
    }
  );

  app.post<{
    Params: { workspaceId: string };
    Body: { holder: 'agent' | 'user' | 'secure_input' };
  }>('/v1/workspaces/:workspaceId/browser/holder', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      return runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['browser.takeover'],
        path: `/v1/workspaces/${workspace.id}/browser/holder`,
        method: 'POST',
        body: JSON.stringify(request.body),
        contentType: 'application/json'
      });
    });
  });

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/terminal-token',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      return {
        runnerUrl: config.PUBLIC_RUNNER_URL,
        /*
         * A terminal token opens one socket and nothing else, so it is bound to that one request.
         *
         * The lifetime is the session's, not the handshake's. The runner closes the socket when the
         * capability expires - deliberately, so a shell on the box stays revocable - and at sixty
         * seconds that meant every terminal died about a minute in, mid-command, reporting "Session
         * closed" as though that were normal. The token is single-use and bound to this workspace,
         * this owner, the `terminal` scope and this exact path, so a longer life widens the window
         * to open one terminal rather than the blast radius of having one.
         *
         * `MAX_CAPABILITY_TTL_SECONDS` caps this at fifteen minutes, and that cap is right - it is
         * what stops a leaked signing secret minting a token that outlives the leak - so this asks
         * for the most it is allowed rather than the length of a session. Fifteen minutes is not
         * the answer, it is fifteen times the old one. The answer is a renewal frame: the client
         * refreshing shortly before expiry and the runner re-arming its timer, which keeps
         * revocation fine-grained without cutting a shell off mid-command.
         */
        token: runner.token(
          workspace.id,
          user.id,
          'user',
          ['terminal'],
          MAX_CAPABILITY_TTL_SECONDS,
          {
            method: 'GET',
            path: `/v1/workspaces/${workspace.id}/terminal`
          }
        )
      };
    }
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/browser-token',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      return {
        runnerUrl: config.PUBLIC_RUNNER_URL,
        /*
         * Three routes, because the pane spends this credential three ways: it opens the frame
         * stream, it sends private keystrokes straight to the runner rather than through here, and
         * it moves the holder when the owner takes over. It used to name none of them, which meant
         * `browser.read` also bought `browser/read-many` - a fetch of any address the caller likes,
         * from the workspace's own browser - and `browser/search`. Neither is anything this pane
         * does.
         */
        token: runner.token(
          workspace.id,
          user.id,
          'user',
          ['browser.read', 'browser.control', 'browser.takeover'],
          90,
          [
            { method: 'GET', path: `/v1/workspaces/${workspace.id}/browser/stream` },
            { method: 'POST', path: `/v1/workspaces/${workspace.id}/browser/action` },
            { method: 'POST', path: `/v1/workspaces/${workspace.id}/browser/holder` }
          ]
        )
      };
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/desktop/snapshot',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      return runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['desktop.read'],
        path: `/v1/workspaces/${workspace.id}/desktop/snapshot`,
        method: 'POST',
        body: '{}',
        contentType: 'application/json'
      });
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/desktop/launch',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
        return runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['desktop.control'],
          path: `/v1/workspaces/${workspace.id}/desktop/launch`,
          method: 'POST',
          body: JSON.stringify(DesktopLaunchRequest.parse(request.body)),
          contentType: 'application/json'
        });
      });
    }
  );

  app.post<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/desktop/action',
    async (request, reply) => {
      const user = requireUser(request.user);
      return idempotent(request, reply, user, async () => {
        const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
        if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
        return runner.request({
          workspaceId: workspace.id,
          userId: user.id,
          role: 'user',
          scopes: ['desktop.control'],
          path: `/v1/workspaces/${workspace.id}/desktop/action`,
          method: 'POST',
          body: JSON.stringify(DesktopAction.parse(request.body)),
          contentType: 'application/json'
        });
      });
    }
  );

  app.post<{
    Params: { workspaceId: string };
    Body: { holder: 'agent' | 'user' | 'secure_input' };
  }>('/v1/workspaces/:workspaceId/desktop/holder', async (request, reply) => {
    const user = requireUser(request.user);
    return idempotent(request, reply, user, async () => {
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      return runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['desktop.takeover'],
        path: `/v1/workspaces/${workspace.id}/desktop/holder`,
        method: 'POST',
        body: JSON.stringify({ holder: DesktopHolder.parse(request.body.holder) }),
        contentType: 'application/json'
      });
    });
  });

  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/desktop-token',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      return {
        runnerUrl: config.PUBLIC_RUNNER_URL,
        /* The same three, for the desktop surface. See `browser-token` above. */
        token: runner.token(
          workspace.id,
          user.id,
          'user',
          ['desktop.read', 'desktop.control', 'desktop.takeover'],
          90,
          [
            { method: 'GET', path: `/v1/workspaces/${workspace.id}/desktop/stream` },
            { method: 'POST', path: `/v1/workspaces/${workspace.id}/desktop/action` },
            { method: 'POST', path: `/v1/workspaces/${workspace.id}/desktop/holder` }
          ]
        )
      };
    }
  );

  /**
   * What this computer is running right now.
   *
   * The runner has always kept this list and has always served it; nothing on this side ever asked
   * for it, so the only account the owner had of their own machine's background work was whatever
   * the transcript happened to mention. The token is audience-bound to this one GET, so the `exec`
   * scope it carries cannot be turned round and used to start a process.
   *
   * The runner answers whatever the workspace's status here says, because the status is not evidence
   * about what is running. Services are built to outlive a snapshot, a checkpoint restore and a
   * runner restart, and the runner brings every one it finds on disk back up when it boots - so a box
   * this side calls hibernated can be serving, and a panel that short-circuited on the status told
   * the owner their machine was idle while it was not. Reading this cannot start anything: the
   * runner's route reads an in-memory table and returns an empty list for a workspace it holds
   * nothing for.
   */
  app.get<{ Params: { workspaceId: string } }>(
    '/v1/workspaces/:workspaceId/processes',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      // `agentListeners` and the two fields beside it are the ports an agent-owned process holds
      // open on the box, which the runner measures rather than infers - a service can be reachable
      // from the internet with every other field on the row looking exactly like a private one.
      return runner.request<{
        processes: unknown[];
        agentListeners?: string[];
        reachableFromOutsideThisComputer?: string[];
        note?: string;
      }>({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['exec'],
        path: `/v1/workspaces/${workspace.id}/processes`,
        // Someone is watching this pane refresh, so a wedged runner has to fail in seconds rather
        // than hold the request for undici's five-minute header timeout.
        timeoutMs: 5_000
      });
    }
  );

  /**
   * Stop one of them.
   *
   * The runner was widened for exactly this - `ProcessManager.action` takes a null owner so the
   * person who owns the box is not held to the task subject an agent capability carries - and
   * nothing on this side ever called it, so a service, which outlives the task that declared it and
   * comes back after every restart, could be seen in the panel and stopped from nowhere. The
   * capability is audience-bound to this one path, so the `exec` scope it carries cannot be turned
   * round and used to start something.
   *
   * `:session` rather than `:sessionId`: the runner names a session `proc_<uuid>`, which is not a
   * column here, and the UUID guard above would answer 404 for every real one. Re-encoded on the way
   * out so a segment carrying `%2F` cannot walk out of this route and into another of the runner's.
   */
  app.post<{ Params: { workspaceId: string; session: string } }>(
    '/v1/workspaces/:workspaceId/processes/:session/resume',
    async (request) => {
      const user = requireUser(request.user);
      if (request.apiToken)
        throw new GardenError(
          'session_required',
          'Resume finite jobs from a signed-in device',
          403
        );
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      const session = z
        .string()
        .regex(/^job_[0-9a-f-]+$/)
        .parse(request.params.session);
      return runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['exec'],
        method: 'POST',
        path: `/v1/workspaces/${workspace.id}/processes/${encodeURIComponent(session)}/resume`,
        contentType: 'application/json',
        body: '{}',
        timeoutMs: 15_000
      });
    }
  );

  app.post<{ Params: { workspaceId: string; session: string }; Body: { action?: string } }>(
    '/v1/workspaces/:workspaceId/processes/:session',
    async (request) => {
      const user = requireUser(request.user);
      const workspace = await store.getWorkspace(user.id, request.params.workspaceId);
      if (!workspace) throw new GardenError('workspace_not_found', 'Workspace not found');
      /*
       * Read it, or stop it. The action was hard-coded to `kill` here, so the runner's `log` arm -
       * which returns the output buffered since the last read, and is the only way to see what a
       * background process has written - was reachable by the agent and by nothing the owner has.
       * A service that is failing could be seen in the panel and stopped, and never read.
       *
       * `poll` and `write` are deliberately not offered. `poll` is the agent's own wait loop and
       * says nothing `log` does not; `write` puts bytes on the stdin of a process the owner is
       * looking at rather than driving, and the runner refuses it for an ownerless caller anyway.
       */
      const action = z
        .object({ action: z.enum(['kill', 'log']).default('kill') })
        .parse(request.body ?? {}).action;
      return runner.request({
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        scopes: ['exec'],
        method: 'POST',
        path: `/v1/workspaces/${workspace.id}/processes/${encodeURIComponent(request.params.session)}`,
        contentType: 'application/json',
        body: JSON.stringify({ action }),
        timeoutMs: 5_000
      });
    }
  );
};
