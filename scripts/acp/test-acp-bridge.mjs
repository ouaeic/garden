#!/usr/bin/env node
/**
 * What `garden acp` promises an ACP client, driven end to end against stand-ins for both halves.
 *
 * A protocol implementation nobody has driven is the shape this programme keeps catching: something
 * computed, shipped, and never wired to a caller. So this does not unit-test the mapper. It spawns
 * the REAL `scripts/garden acp` arm as a subprocess, speaks the CLIENT half of ACP down its stdin
 * and reads the agent half off its stdout, and answers its HTTP calls from a stand-in API on a
 * loopback port that returns the shapes `apps/api` actually returns.
 *
 * Two stand-ins, because the bridge sits between them and every defect worth catching is a
 * disagreement between the two. The precedent is `scripts/test-task-cli.mjs`, which does the same
 * for `garden task` and says the same thing about what it cannot prove: this is a stand-in, so it
 * stays green if the API changes shape underneath it. `scripts/live-drill.mjs` is the other half,
 * and it costs money.
 *
 * The checks that matter most are the last three. They are the approval floor, and they are written
 * as adversarial questions rather than as happy paths: can a client answer a card the owner was
 * meant to see, can a client widen what gets carded, and can a client hand this box somebody else's
 * code to run.
 *
 * Usage: node scripts/acp/test-acp-bridge.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = path.join(repositoryRoot, 'scripts', 'garden');
// Shaped like the real thing: `auth-hook.ts` accepts /^oc_live_[A-Za-z0-9_-]{40,80}$/, and the
// bridge checks the same pattern before it will put the value in an Authorization header.
const TOKEN = `oc_live_${'a'.repeat(43)}`;
const WORKSPACE = 'ws-2222';

let checks = 0;
const failures = [];
const check = (what, run) => {
  checks += 1;
  try {
    run();
  } catch (error) {
    failures.push(`${what}: ${error.message}`);
  }
};

/** The task record `apps/api/src/context.ts` builds, with only the fields the bridge reads. */
const taskRecord = (over = {}) => ({
  id: 'task-1111',
  workspaceId: WORKSPACE,
  status: 'running',
  securityMode: 'balanced',
  modelId: 'a/model',
  ...over
});

const event = (sequence, kind, payload, summary = '') => ({
  id: `ev-${sequence}`,
  taskId: 'task-1111',
  sequence,
  kind,
  summary,
  ...(payload === undefined ? {} : { payload }),
  createdAt: new Date().toISOString()
});

/**
 * A stand-in garden API.
 *
 * `script` is a list of what each successive GET /v1/tasks/:id should answer, so a test can walk a
 * task from running to whatever ending it is about. `events` is keyed by the `after` cursor, which
 * is what lets one case model the thing a poller gets wrong: the store DELETES the streamed deltas
 * when the settled message lands, so a second poll can legitimately return an answer whose frames
 * are no longer in the log.
 */
const startApi = (plan) => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const url = new URL(request.url, 'http://127.0.0.1');
      requests.push({
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        authorization: request.headers.authorization,
        idempotencyKey: request.headers['idempotency-key'],
        body: body ? JSON.parse(body) : null
      });
      const send = (status, payload) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      const answer = plan.route(url, request.method, body ? JSON.parse(body) : null, requests);
      send(answer.status ?? 200, answer.body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => server.close()
      });
    });
  });
};

/**
 * A stand-in ACP client: it spawns the real arm, frames JSON-RPC both ways, and lets a case await
 * the reply to a given id or the arrival of a given notification.
 */
const startClient = (api, extraArguments = [], environment = {}) => {
  const child = spawn(
    cli,
    ['acp', '--workspace', WORKSPACE, '--turn-timeout', '20', ...extraArguments],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        GARDEN_API: api.base,
        GARDEN_TOKEN: TOKEN,
        // No /etc/garden to fall back to, so a case that clears GARDEN_TOKEN really has none.
        GARDEN_TOKEN_FILE: path.join(repositoryRoot, 'scripts', 'acp', 'no-such-token'),
        GARDEN_ACP_POLL_SECONDS: '0.05',
        ...environment
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  );
  let nextId = 1;
  const replies = new Map();
  const waiters = [];
  const notifications = [];
  /** Requests the AGENT sent us - in practice, session/request_permission. */
  const inbound = [];
  const inboundWaiters = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (message.method && message.id === undefined) {
      notifications.push(message);
      return;
    }
    if (message.method && message.id !== undefined) {
      inbound.push(message);
      for (const waiter of inboundWaiters.splice(0)) waiter(message);
      return;
    }
    replies.set(message.id, message);
    for (const waiter of waiters.splice(0)) waiter();
  });

  const settled = () =>
    // Woken by a reply OR by the tick, so a request that is never going to be answered fails on
    // the deadline below instead of parking this process forever. Found the honest way: a
    // deliberate break made the agent ask the client a question this rig had not been written to
    // answer, and the rig hung rather than going red. A drill that hangs reports nothing at all.
    new Promise((resolve) => {
      waiters.push(resolve);
      setTimeout(resolve, 50).unref();
    });
  const request = async (method, params) => {
    const id = nextId;
    nextId += 1;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    // Generously longer than any turn this file sets up, and far shorter than a stuck CI job.
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (replies.has(id)) return replies.get(id);
      if (child.exitCode !== null) throw new Error(`the agent exited ${child.exitCode}: ${stderr}`);
      if (Date.now() > deadline)
        throw new Error(`the agent never answered ${method}; stderr was: ${stderr}`);
      await settled();
    }
  };
  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const nextInbound = async () => {
    if (inbound.length) return inbound.shift();
    return new Promise((resolve) => inboundWaiters.push(resolve));
  };
  const reply = (id, result) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  const close = () =>
    new Promise((resolve) => {
      child.on('exit', (code) => resolve({ code, stderr, notifications }));
      child.stdin.end();
    });
  /*
   * `inbound` is returned as well as `notifications`, and the difference is load-bearing rather
   * than tidy. A `session/request_permission` is a REQUEST: it carries a `method` AND an `id`, so
   * the reader above files it in `inbound` and it can never appear in `notifications`. The park
   * check below asserts that no such request was made, and it was written against `notifications`
   * - where the thing it forbids cannot land - so it could not fail. Measured: a break that made
   * park mode send a `session/request_permission` on every parked turn passed all 43 checks.
   */
  return {
    request,
    notify,
    nextInbound,
    reply,
    close,
    notifications,
    inbound,
    stderr: () => stderr
  };
};

/** Every text chunk the agent streamed, in order, as one string. */
const streamedText = (notifications) =>
  notifications
    .filter((message) => message.method === 'session/update')
    .filter((message) => message.params.update.sessionUpdate === 'agent_message_chunk')
    .map((message) => message.params.update.content.text)
    .join('');

const openSession = async (client) => {
  const ready = await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
  });
  const opened = await client.request('session/new', {
    cwd: '/home/someone/project',
    mcpServers: []
  });
  return { ready, opened };
};

// --- 1. the handshake ---------------------------------------------------------------------------

{
  const api = await startApi({ route: () => ({ body: {} }) });
  const client = startClient(api);
  const { ready, opened } = await openSession(client);

  check('initialize answers protocol version 1', () => {
    assert.equal(ready.result.protocolVersion, 1);
  });
  check('initialize offers no auth method, because a token cannot be minted by a machine', () => {
    assert.deepEqual(ready.result.authMethods, []);
  });
  check('initialize promises no session loading and no MCP', () => {
    assert.equal(ready.result.agentCapabilities.loadSession, false);
    assert.deepEqual(ready.result.agentCapabilities.mcpCapabilities, { http: false, sse: false });
  });
  check('initialize promises text prompts only', () => {
    assert.equal(ready.result.agentCapabilities.promptCapabilities.image, false);
    assert.equal(ready.result.agentCapabilities.promptCapabilities.audio, false);
  });
  check('session/new returns a session id', () => {
    assert.match(opened.result.sessionId, /^garden-acp-/);
  });
  /*
   * The floor, stated as a shape rather than as a promise: a client cannot set a mode it was never
   * offered one of. `NewSessionResponse.modes` is what a conforming client reads before it will
   * show a mode picker, and its absence is why `session/set_mode` is unreachable in a real client
   * rather than merely refused when called.
   */
  check('session/new offers no modes for a client to pick between', () => {
    assert.equal(opened.result.modes, undefined);
    assert.equal(opened.result.configOptions, undefined);
  });

  const exited = await client.close();
  check('a closed client exits the agent cleanly', () => {
    assert.equal(exited.code, 0);
  });
  api.close();
}

// --- 2. a turn that finishes, and the duplicate answer a poller invites --------------------------

{
  /*
   * The trap, modelled exactly as the store creates it. Frames land at sequences 2, 3 and 4; the
   * settled `assistant_message` lands at 5 and the store deletes 2 through 4 in the same
   * transaction ("the moment that message exists, every delta before it is a redundant slice of
   * it"). So a poller that asks for everything after 4 is legitimately handed the whole answer
   * again. A bridge that emitted both would show the client every reply twice.
   */
  let taskReads = 0;
  const api = await startApi({
    route: (url, method) => {
      if (url.pathname === '/v1/tasks' && method === 'POST') return { body: taskRecord() };
      if (url.pathname === '/v1/tasks/task-1111/events') {
        const after = Number(url.searchParams.get('after'));
        if (after === 0)
          return {
            body: [
              event(2, 'assistant_delta', { markdown: 'I read ', append: true }),
              event(3, 'assistant_delta', { markdown: 'the file ', append: true }),
              event(4, 'assistant_delta', { markdown: 'and it is a CSV.', append: true })
            ]
          };
        return {
          body: [
            event(5, 'assistant_message', { markdown: 'I read the file and it is a CSV.' }),
            event(6, 'completed', { summary: 'done' })
          ]
        };
      }
      if (url.pathname === '/v1/tasks/task-1111') {
        taskReads += 1;
        return { body: taskRecord({ status: taskReads >= 2 ? 'completed' : 'running' }) };
      }
      return { body: {} };
    }
  });
  const client = startClient(api);
  await openSession(client);
  const session = (await client.request('session/new', { cwd: '/x', mcpServers: [] })).result
    .sessionId;
  const turn = await client.request('session/prompt', {
    sessionId: session,
    prompt: [{ type: 'text', text: 'read the file' }]
  });

  check('a finished turn stops with end_turn', () => {
    assert.equal(turn.result.stopReason, 'end_turn');
  });
  check('the turn reports which garden task ran it', () => {
    assert.equal(turn.result._meta.garden.taskId, 'task-1111');
  });
  check('the streamed answer arrives once, not twice', () => {
    const text = streamedText(client.notifications);
    assert.equal(text, 'I read the file and it is a CSV.');
  });
  check('the task was created with the workspace given on the command line', () => {
    const created = api.requests.find(
      (entry) => entry.path === '/v1/tasks' && entry.method === 'POST'
    );
    assert.equal(created.body.workspaceId, WORKSPACE);
    assert.equal(created.body.prompt, 'read the file');
  });
  /*
   * There is no field for it to send, and this pins that. `CreateTaskRequest` has no `securityMode`,
   * so a task inherits its workspace's mode; if a future edit added one here, a client would be
   * choosing how much this box stops to ask.
   */
  check('the task is created without a security mode of its own', () => {
    const created = api.requests.find(
      (entry) => entry.path === '/v1/tasks' && entry.method === 'POST'
    );
    assert.equal(created.body.securityMode, undefined);
  });
  check('every write carried an idempotency key', () => {
    for (const entry of api.requests.filter((one) => one.method === 'POST'))
      assert.ok(entry.idempotencyKey, `${entry.path} was written without an Idempotency-Key`);
  });
  check('the token was sent as a bearer token and never in a query string', () => {
    for (const entry of api.requests) {
      assert.equal(entry.authorization, `Bearer ${TOKEN}`);
      assert.equal(JSON.stringify(entry.query).includes(TOKEN), false);
    }
  });

  await client.close();
  api.close();
}

// --- 3. a turn that dies must not read as a turn that finished ----------------------------------

{
  const api = await startApi({
    route: (url, method) => {
      if (url.pathname === '/v1/tasks' && method === 'POST') return { body: taskRecord() };
      if (url.pathname === '/v1/tasks/task-1111/events')
        return {
          body: [event(2, 'warning', { owner: true }, 'The provider stopped answering')]
        };
      if (url.pathname === '/v1/tasks/task-1111') return { body: taskRecord({ status: 'failed' }) };
      return { body: {} };
    }
  });
  const client = startClient(api);
  await openSession(client);
  const session = (await client.request('session/new', { cwd: '/x', mcpServers: [] })).result
    .sessionId;
  const turn = await client.request('session/prompt', {
    sessionId: session,
    prompt: [{ type: 'text', text: 'do the thing' }]
  });

  /*
   * The defect this repository has been bitten by twice, in its new clothes. ACP has no stop reason
   * for "it broke", so a failed task comes back as a JSON-RPC error: there is no success field a
   * client could read and believe the work was done.
   */
  check('a failed task answers with an error, not a stop reason', () => {
    assert.equal(turn.result, undefined);
    assert.ok(turn.error, 'a failed task answered with a result');
  });
  check('the failure says what the worker told the owner', () => {
    assert.match(turn.error.message, /provider stopped answering/i);
  });

  await client.close();
  api.close();
}

// --- 4. cancellation ----------------------------------------------------------------------------

{
  let cancelled = false;
  const api = await startApi({
    route: (url, method) => {
      if (url.pathname === '/v1/tasks' && method === 'POST') return { body: taskRecord() };
      if (url.pathname === '/v1/tasks/task-1111/cancel') {
        cancelled = true;
        return { body: taskRecord({ status: 'cancelled' }) };
      }
      if (url.pathname === '/v1/tasks/task-1111/events') return { body: [] };
      if (url.pathname === '/v1/tasks/task-1111')
        return { body: taskRecord({ status: cancelled ? 'cancelled' : 'running' }) };
      return { body: {} };
    }
  });
  const client = startClient(api);
  await openSession(client);
  const session = (await client.request('session/new', { cwd: '/x', mcpServers: [] })).result
    .sessionId;
  const turn = client.request('session/prompt', {
    sessionId: session,
    prompt: [{ type: 'text', text: 'a long job' }]
  });
  // Not a fixed wait: `session/cancel` needs the task to exist, and on a loaded machine the bridge
  // can take longer than any number chosen here to create it - a cancel that arrives first is
  // answered as a refusal, and the drill then fails for a reason that has nothing to do with the
  // bridge. So wait for the creation itself, bounded so a bridge that never creates one still fails
  // loudly rather than hanging the drill.
  const createdBy = Date.now() + 10_000;
  while (!api.requests.some((entry) => entry.path === '/v1/tasks' && entry.method === 'POST')) {
    if (Date.now() > createdBy) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  client.notify('session/cancel', { sessionId: session });
  const answered = await turn;

  check('a cancelled turn stops with cancelled, as the specification requires', () => {
    assert.equal(answered.result.stopReason, 'cancelled');
  });
  check('session/cancel actually cancelled the garden task', () => {
    assert.ok(
      api.requests.some((entry) => entry.path === '/v1/tasks/task-1111/cancel'),
      'nothing cancelled the task'
    );
  });

  await client.close();
  api.close();
}

// --- 5. THE APPROVAL FLOOR: a parked turn is not a finished turn --------------------------------

{
  const api = await startApi({
    route: (url, method) => {
      if (url.pathname === '/v1/tasks' && method === 'POST') return { body: taskRecord() };
      if (url.pathname === '/v1/tasks/task-1111/events') return { body: [] };
      if (url.pathname === '/v1/tasks/task-1111')
        return { body: taskRecord({ status: 'awaiting_user' }) };
      if (url.pathname === '/v1/approvals')
        return { body: [{ id: 'ap-1', taskId: 'task-1111', action: 'install ripgrep' }] };
      return { body: {} };
    }
  });
  const client = startClient(api);
  await openSession(client);
  const session = (await client.request('session/new', { cwd: '/x', mcpServers: [] })).result
    .sessionId;
  const turn = await client.request('session/prompt', {
    sessionId: session,
    prompt: [{ type: 'text', text: 'install ripgrep' }]
  });

  /*
   * Settle before the two negatives below, for the reason recorded on the same pause in case 8: a
   * write the bridge does not await lands after the assertion and passes it. Measured here too - a
   * break that added a fire-and-forget `decideApproval` to the parked path passed while it was
   * answering the card.
   */
  await new Promise((resolve) => setTimeout(resolve, 250));
  /*
   * In the default mode the client is never asked. If this ever sent one, an editor's "always
   * allow" toggle would be answering a card the owner asked to be shown.
   *
   * Asserted over `inbound` and NOT over `notifications`: a permission request carries an id, so it
   * is a request and never a notification. See the comment on the client's return value.
   */
  check('park mode never asks the client for permission', () => {
    assert.deepEqual(
      client.inbound.filter((message) => message.method === 'session/request_permission'),
      []
    );
  });
  check('park mode does not answer the approval itself', () => {
    const decided = api.requests.filter(
      (entry) => entry.method === 'POST' && entry.path.startsWith('/v1/approvals/')
    );
    assert.deepEqual(decided, [], 'something answered an approval on the owner behalf');
  });
  check('a parked turn does not report end_turn', () => {
    assert.notEqual(turn.result.stopReason, 'end_turn');
    assert.equal(turn.result.stopReason, 'refusal');
  });
  check('the parked turn says it is parked, in a field and in words', () => {
    assert.equal(turn.result._meta.garden.parked, 'awaiting_approval');
    assert.match(streamedText(client.notifications), /parked rather than finished/);
    assert.match(streamedText(client.notifications), /install ripgrep/);
  });

  await client.close();
  api.close();
}

// --- 6. THE APPROVAL FLOOR: relay asks, and never offers a standing yes -------------------------

{
  let approved = false;
  const api = await startApi({
    route: (url, method) => {
      if (url.pathname === '/v1/tasks' && method === 'POST') return { body: taskRecord() };
      if (url.pathname === '/v1/tasks/task-1111/events') return { body: [] };
      if (url.pathname === '/v1/tasks/task-1111')
        return { body: taskRecord({ status: approved ? 'completed' : 'awaiting_user' }) };
      if (url.pathname === '/v1/approvals')
        return {
          body: approved ? [] : [{ id: 'ap-1', taskId: 'task-1111', action: 'install ripgrep' }]
        };
      if (url.pathname === '/v1/approvals/ap-1/approve') {
        approved = true;
        return { body: { ok: true } };
      }
      return { body: {} };
    }
  });
  const client = startClient(api, ['--approvals', 'relay']);
  await openSession(client);
  const session = (await client.request('session/new', { cwd: '/x', mcpServers: [] })).result
    .sessionId;
  const turn = client.request('session/prompt', {
    sessionId: session,
    prompt: [{ type: 'text', text: 'install ripgrep' }]
  });
  const asked = await client.nextInbound();

  check('relay asks the client with session/request_permission', () => {
    assert.equal(asked.method, 'session/request_permission');
    assert.equal(asked.params.sessionId, session);
  });
  /*
   * THE CRUX, as an assertion. ACP's PermissionOptionKind has four values and this offers two.
   * `allow_always` is the one that matters: garden has nowhere to keep a standing decision -
   * `POST /v1/approvals/:id/:decision` resolves one approval and consults no rule table - so a
   * client handed `allow_always` would reasonably stop asking its user, and from that moment a
   * toggle in somebody's editor is answering every card instead of the owner.
   */
  check('relay never offers a standing yes or a standing no', () => {
    const kinds = asked.params.options.map((option) => option.kind).sort();
    assert.deepEqual(kinds, ['allow_once', 'reject_once']);
  });

  client.reply(asked.id, { outcome: { outcome: 'selected', optionId: 'approve' } });
  const answered = await turn;

  check('the client decision reaches garden own approval route', () => {
    const decided = api.requests.find((entry) => entry.path === '/v1/approvals/ap-1/approve');
    assert.ok(decided, 'the approval was never answered against the API');
    assert.equal(decided.method, 'POST');
  });
  check('an approved turn carries on and finishes', () => {
    assert.equal(answered.result.stopReason, 'end_turn');
  });

  await client.close();
  api.close();
}

// --- 7. THE APPROVAL FLOOR: the scope is the control, not the flag ------------------------------

{
  /*
   * The adversarial question. In ACP the CLIENT spawns the agent, so a client controls argv and can
   * pass `--approvals relay` itself. What it cannot do is give itself a scope: every write under
   * `/v1/approvals` is behind `approvals:write` in `requiredApiTokenScope`, so a token minted
   * without it is refused by the server whatever the command line said. This runs the relay path
   * against an API that refuses exactly the way that one does.
   */
  const api = await startApi({
    route: (url, method) => {
      if (url.pathname === '/v1/tasks' && method === 'POST') return { body: taskRecord() };
      if (url.pathname === '/v1/tasks/task-1111/events') return { body: [] };
      if (url.pathname === '/v1/tasks/task-1111')
        return { body: taskRecord({ status: 'awaiting_user' }) };
      if (url.pathname === '/v1/approvals')
        return { body: [{ id: 'ap-1', taskId: 'task-1111', action: 'install ripgrep' }] };
      if (url.pathname === '/v1/approvals/ap-1/approve')
        return {
          status: 403,
          body: {
            error: {
              code: 'api_token_scope_required',
              message: 'This API token requires the approvals:write scope'
            }
          }
        };
      return { body: {} };
    }
  });
  const client = startClient(api, ['--approvals', 'relay']);
  await openSession(client);
  const session = (await client.request('session/new', { cwd: '/x', mcpServers: [] })).result
    .sessionId;
  const turn = client.request('session/prompt', {
    sessionId: session,
    prompt: [{ type: 'text', text: 'install ripgrep' }]
  });
  const asked = await client.nextInbound();
  client.reply(asked.id, { outcome: { outcome: 'selected', optionId: 'approve' } });
  const answered = await turn;

  check('a client cannot approve past a token that lacks the scope', () => {
    assert.equal(answered.result, undefined, 'the turn reported success after a refused approval');
    assert.ok(answered.error, 'a refused approval was not reported as an error');
    assert.match(answered.error.message, /approvals:write/);
  });

  await client.close();
  api.close();
}

// --- 8. THE APPROVAL FLOOR: nothing lets a client widen what gets carded ------------------------

{
  const api = await startApi({ route: () => ({ body: {} }) });
  const client = startClient(api);
  await openSession(client);
  const session = (await client.request('session/new', { cwd: '/x', mcpServers: [] })).result
    .sessionId;

  const mode = await client.request('session/set_mode', {
    sessionId: session,
    modeId: 'autonomous'
  });
  const option = await client.request('session/set_config_option', {
    sessionId: session,
    configOptionId: 'securityMode',
    value: 'autonomous'
  });

  check('session/set_mode is refused', () => {
    assert.ok(mode.error, 'session/set_mode was answered rather than refused');
    assert.equal(mode.error.code, -32601);
    assert.match(mode.error.message, /owner/);
  });
  check('session/set_config_option is refused', () => {
    assert.ok(option.error, 'session/set_config_option was answered rather than refused');
    assert.equal(option.error.code, -32601);
  });
  /*
   * Settle before asserting a NEGATIVE about the requests made, and this is not belt and braces.
   *
   * Measured: a break that put a fire-and-forget `fetch` of `PATCH /v1/tasks/:id/security-mode` in
   * front of the refusal passed all 43 checks, because the refusal is written to stdout
   * synchronously and the client's reply arrives before the request reaches the stand-in. The same
   * break with the fetch awaited went red. So without this pause the check only catches the form of
   * the defect nobody would write, and misses the form somebody would.
   *
   * 250ms because the stand-in is on loopback in this process and a round trip there is under a
   * millisecond; it is three orders of magnitude of headroom, and it is paid once.
   */
  await new Promise((resolve) => setTimeout(resolve, 250));
  // Both routes, not just the workspace one: `PATCH /v1/tasks/:taskId/security-mode` is a per-task
  // override and `auth-hook.ts` sends it to `tasks:write`, the scope this bridge already needs. So
  // the workspace route being out of scope proves nothing here; what is asserted is that the bridge
  // made no `security-mode` request of any kind while being pushed at with both mode setters.
  check('nothing wrote to any security mode route, task or workspace', () => {
    assert.deepEqual(
      api.requests.filter((entry) => entry.path.includes('security-mode')),
      []
    );
  });

  await client.close();
  api.close();
}

// --- 9. no third-party code arrives through a protocol field ------------------------------------

{
  const api = await startApi({ route: () => ({ body: {} }) });
  const client = startClient(api);
  await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const refused = await client.request('session/new', {
    cwd: '/x',
    mcpServers: [{ name: 'someone-elses-tools', command: '/usr/bin/whatever', args: [] }]
  });
  const accepted = await client.request('session/new', { cwd: '/x', mcpServers: [] });

  check('a client cannot hand this box MCP servers to run', () => {
    assert.ok(refused.error, 'a session was opened with somebody else MCP servers attached');
    assert.equal(refused.error.code, -32602);
    assert.match(refused.error.message, /configured by its owner/);
  });
  check('an empty mcpServers is accepted, because the schema requires the field', () => {
    assert.ok(accepted.result.sessionId, 'a conforming client with no MCP servers was refused');
  });

  await client.close();
  api.close();
}

// --- 10. a missing token is refused honestly, and nothing pretends otherwise --------------------

{
  const api = await startApi({ route: () => ({ body: {} }) });
  const client = startClient(api, [], { GARDEN_TOKEN: '' });
  await openSession(client);
  const session = (await client.request('session/new', { cwd: '/x', mcpServers: [] })).result
    .sessionId;
  const turn = await client.request('session/prompt', {
    sessionId: session,
    prompt: [{ type: 'text', text: 'anything' }]
  });

  check('a prompt with no token is refused with authentication required', () => {
    assert.ok(turn.error);
    assert.equal(turn.error.code, -32000);
    assert.match(turn.error.message, /GARDEN_TOKEN/);
  });
  check('a turn with no token never reached the API', () => {
    assert.deepEqual(api.requests, []);
  });

  await client.close();
  api.close();
}

// --- 11. a turn nobody is watching is never reported as finished --------------------------------

{
  const api = await startApi({
    route: (url, method) => {
      if (url.pathname === '/v1/tasks' && method === 'POST') return { body: taskRecord() };
      if (url.pathname === '/v1/tasks/task-1111/events') return { body: [] };
      // Never stops. This is the case where the bridge gives up and the task does not.
      if (url.pathname === '/v1/tasks/task-1111')
        return { body: taskRecord({ status: 'running' }) };
      return { body: {} };
    }
  });
  const client = startClient(api, ['--turn-timeout', '1']);
  await openSession(client);
  const session = (await client.request('session/new', { cwd: '/x', mcpServers: [] })).result
    .sessionId;
  const turn = await client.request('session/prompt', {
    sessionId: session,
    prompt: [{ type: 'text', text: 'a job longer than the watch' }]
  });

  check('a watch that ran out does not report end_turn', () => {
    assert.equal(turn.result.stopReason, 'refusal');
    assert.equal(turn.result._meta.garden.parked, 'still_running');
  });
  check('it says the task is still running and still spending', () => {
    assert.equal(turn.result._meta.garden.stillSpending, true);
    assert.match(streamedText(client.notifications), /STILL RUNNING AND STILL SPENDING/);
  });
  check('it names the command that stops it', () => {
    assert.match(streamedText(client.notifications), /garden task cancel task-1111/);
  });

  await client.close();
  api.close();
}

// --- 12. a second prompt continues the same conversation ----------------------------------------

{
  const api = await startApi({
    route: (url, method) => {
      if (url.pathname === '/v1/tasks' && method === 'POST') return { body: taskRecord() };
      if (url.pathname === '/v1/tasks/task-1111/messages') return { body: taskRecord() };
      if (url.pathname === '/v1/tasks/task-1111/events') return { body: [] };
      if (url.pathname === '/v1/tasks/task-1111')
        return { body: taskRecord({ status: 'completed' }) };
      return { body: {} };
    }
  });
  const client = startClient(api);
  await openSession(client);
  const session = (await client.request('session/new', { cwd: '/x', mcpServers: [] })).result
    .sessionId;
  await client.request('session/prompt', {
    sessionId: session,
    prompt: [{ type: 'text', text: 'first' }]
  });
  await client.request('session/prompt', {
    sessionId: session,
    prompt: [{ type: 'text', text: 'second' }]
  });

  check('the first prompt creates a task and the second continues it', () => {
    const created = api.requests.filter(
      (entry) => entry.path === '/v1/tasks' && entry.method === 'POST'
    );
    const continued = api.requests.filter((entry) => entry.path === '/v1/tasks/task-1111/messages');
    assert.equal(created.length, 1, 'a second prompt started a second task');
    assert.equal(continued.length, 1, 'the second prompt did not continue the conversation');
    assert.equal(continued[0].body.prompt, 'second');
  });
  const imageOnly = await client.request('session/prompt', {
    sessionId: session,
    prompt: [{ type: 'image', data: 'x', mimeType: 'image/png' }]
  });
  check('an image-only prompt is refused, matching what initialize promised', () => {
    assert.ok(imageOnly.error);
    assert.equal(imageOnly.error.code, -32602);
  });

  await client.close();
  api.close();
}

// --- 13. the other direction: an answer that was never streamed still arrives -------------------

{
  /*
   * The counter-direction to check 2, and it was added because its absence was demonstrated rather
   * than suspected: with only that check in place, a mapper changed to drop EVERY settled
   * `assistant_message` still passed all thirty-nine. Check 2's text came entirely from the frames,
   * so nothing was testing the branch that speaks when there were no frames.
   *
   * That branch is not hypothetical. The worker writes `assistant_delta` only on the streaming
   * path; `apps/worker/src/turn/record-step.ts` writes an `assistant_message` for the step either
   * way, and a route that does not stream produces this shape for every reply it ever sends.
   */
  let taskReads = 0;
  const api = await startApi({
    route: (url, method) => {
      if (url.pathname === '/v1/tasks' && method === 'POST') return { body: taskRecord() };
      if (url.pathname === '/v1/tasks/task-1111/events') {
        if (Number(url.searchParams.get('after')) !== 0) return { body: [] };
        return { body: [event(2, 'assistant_message', { markdown: 'It is a CSV of 41 rows.' })] };
      }
      if (url.pathname === '/v1/tasks/task-1111') {
        taskReads += 1;
        return { body: taskRecord({ status: taskReads >= 2 ? 'completed' : 'running' }) };
      }
      return { body: {} };
    }
  });
  const client = startClient(api);
  await openSession(client);
  const session = (await client.request('session/new', { cwd: '/x', mcpServers: [] })).result
    .sessionId;
  const turn = await client.request('session/prompt', {
    sessionId: session,
    prompt: [{ type: 'text', text: 'how many rows' }]
  });

  check('a reply that never streamed still reaches the client', () => {
    assert.equal(streamedText(client.notifications), 'It is a CSV of 41 rows.');
  });
  check('and that turn still ends normally', () => {
    assert.equal(turn.result.stopReason, 'end_turn');
  });

  await client.close();
  api.close();
}

// --- 14. a tool call and the update that closes it carry the same id ---------------------------

{
  /*
   * Found by reading `tool-recording.ts` rather than by a failing check, which is why it is pinned
   * here: `tool_started` and `tool_result` are two timeline rows with two row ids, and both carry
   * the model's own `toolCallId` in their payload. Keying the ACP updates off the row id - which is
   * what this bridge did first - told a client that a tool call had completed under an id it had
   * never been told was open, and every check in this file stayed green.
   */
  let taskReads = 0;
  const api = await startApi({
    route: (url, method) => {
      if (url.pathname === '/v1/tasks' && method === 'POST') return { body: taskRecord() };
      if (url.pathname === '/v1/tasks/task-1111/events') {
        if (Number(url.searchParams.get('after')) !== 0) return { body: [] };
        return {
          body: [
            event(2, 'tool_started', { toolCallId: 'call_abc', tool: 'shell' }, 'Running shell'),
            event(3, 'tool_result', { toolCallId: 'call_abc', result: 'ok' }, 'shell completed')
          ]
        };
      }
      if (url.pathname === '/v1/tasks/task-1111') {
        taskReads += 1;
        return { body: taskRecord({ status: taskReads >= 2 ? 'completed' : 'running' }) };
      }
      return { body: {} };
    }
  });
  const client = startClient(api);
  await openSession(client);
  const session = (await client.request('session/new', { cwd: '/x', mcpServers: [] })).result
    .sessionId;
  await client.request('session/prompt', {
    sessionId: session,
    prompt: [{ type: 'text', text: 'run it' }]
  });

  const updates = client.notifications
    .filter((message) => message.method === 'session/update')
    .map((message) => message.params.update);
  const opened = updates.find((update) => update.sessionUpdate === 'tool_call');
  const closed = updates.find((update) => update.sessionUpdate === 'tool_call_update');

  check('a tool call is opened with the model own call id', () => {
    assert.ok(opened, 'no tool_call update was sent');
    assert.equal(opened.toolCallId, 'call_abc');
  });
  check('the update that closes it carries the same id', () => {
    assert.ok(closed, 'no tool_call_update was sent');
    assert.equal(closed.toolCallId, 'call_abc');
    assert.equal(closed.toolCallId, opened.toolCallId);
  });

  await client.close();
  api.close();
}

// --- the verdict --------------------------------------------------------------------------------

if (failures.length) {
  for (const failure of failures) process.stderr.write(`  ${failure}\n`);
  process.stderr.write(`garden acp: ${failures.length} of ${checks} checks failed\n`);
  process.exit(1);
}
process.stdout.write(
  `ACP bridge: ${checks} checks, including the approval floor from four directions - a client is never asked in park mode, is never offered a standing yes in relay mode, cannot approve past a token without the scope, and cannot change the mode at all.\n`
);
