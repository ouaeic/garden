#!/usr/bin/env node
/**
 * garden as an Agent Client Protocol agent, so other people can write clients for this box.
 *
 * WHAT THIS IS. ACP is a JSON-RPC 2.0 protocol spoken over a subprocess's stdin and stdout, in
 * which a client - an editor, a desktop app, somebody's own front end - spawns an agent and talks
 * to it. This file is the agent half. It owns no model, no tools and no policy: every turn it runs
 * is an ordinary garden task, created through the same HTTP API `garden task` uses and governed
 * by the same approval floor. What it buys is that a client nobody here wrote, and nobody here
 * maintains, can drive this box.
 *
 * The value is the CLIENT ecosystem and not an agent ecosystem, and the difference is the whole
 * reason this is acceptable in a curated tree. Speaking ACP *as an agent* admits no third-party
 * code onto the owner's machine. Hosting third-party ACP *agents* inside garden would be a plugin
 * marketplace with a protocol on it, which this repository has already declined. `session/new`
 * refuses a non-empty `mcpServers` for exactly that reason - see `refuseForeignMcpServers` below.
 *
 * WHICH SPECIFICATION. Schema `v1`, read from the tagged release `schema-v1.21.0` of
 * github.com/agentclientprotocol/agent-client-protocol (`schema/v1/schema.json` and
 * `schema/v1/meta.json`), alongside the prose at agentclientprotocol.com. `protocolVersion` is the
 * single integer `1`. A `v2` exists in that repository's `main` branch and has published three
 * pre-releases (`schema-v2.0.0-alpha.1` through `alpha.3`); it drops `fs/*`, `terminal/*`,
 * `session/load` and renames `authenticate` to `auth/login`. None of those are surfaces this agent
 * uses, so a later move to 2 is a version bump here and not a rewrite. Until it leaves alpha this
 * answers 1, which is what the negotiation rule asks for: the specification says an agent that does
 * not support the client's version "MUST respond with the latest version it supports", and the
 * client then closes the connection if it cannot live with the answer.
 *
 * ZERO RESIDENT BYTES. Nothing here is visible to the model. This is a command an operator's editor
 * spawns, not a tool in the catalogue, and it adds no field to any model request - it only calls
 * HTTP routes that already existed. That is the same standing `garden task` has, and
 * docs/HEADLESS.md records the precedent: "these are commands an operator types, not tools the
 * agent can see, so the tool catalogue is the same byte for byte with them and without them."
 *
 * NO DEPENDENCIES. Node builtins only, `fetch` included; package.json declares `engines.node`
 * ">=24.0.0" and every garden box runs the API on that same Node.
 *
 * THE APPROVAL FLOOR. The crux, and the thing to read before changing a line of this file, is in
 * `docs/ACP.md` and in `requestPermissionOptions` and `refuseModeChange` below. In short: a client
 * cannot move this workspace off the security mode its owner chose, and by default a client is
 * never asked to answer a card at all.
 *
 * Usage: garden acp --workspace ID [--model ID] [--credits N] [--spend-usd N]
 *                    [--approvals park|relay] [--turn-timeout SECONDS]
 */

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * How this process ends, and what each number means.
 *
 * Deliberately NOT the table `garden task` uses. That command runs one piece of work and its exit
 * code says how that work ended; this one holds a session open across many turns, and how a turn
 * ended is answered inside the protocol by `stopReason` and the `_meta` beside it. Reusing task's
 * numbers here would mean picking one turn's ending to represent all of them, which is the same
 * dishonesty in a new place.
 *
 * So these describe the BRIDGE. A client that reads them gets "did the agent stay up", not "did the
 * work succeed" - and the docs say so rather than leaving it to be inferred.
 */
const EXIT_OK = 0; // The client closed the connection and every turn it asked for was answered.
const EXIT_CANNOT = 1; // Could not do its job: no token, bad option, unreadable arguments.
const EXIT_TRANSPORT = 2; // The API stopped answering, or stdout closed under us mid-session.

/** The protocol major version this agent speaks. See WHICH SPECIFICATION above. */
const PROTOCOL_VERSION = 1;

/**
 * JSON-RPC error codes, from `ErrorCode` in the ACP schema. Only the four this agent can actually
 * produce are named; inventing constants for codes nothing raises is how a reader comes to believe
 * a path exists.
 */
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const AUTH_REQUIRED = -32000;

/**
 * How long one turn may be watched before the bridge stops watching.
 *
 * The same half hour `garden task` defaults to, and the same admission: nothing in this repository
 * records how long an ordinary job takes, so this is a number picked to be wrong in the cheap
 * direction rather than a measured one. Running out does NOT stop the task - it keeps running and
 * keeps spending - and the turn that reports it says so in words, because a client that read only
 * the stop reason would otherwise file a live, spending task as finished.
 */
const DEFAULT_TURN_SECONDS = Number(process.env.GARDEN_ACP_TURN_SECONDS || 1800);

/**
 * How often the turn asks the API what happened.
 *
 * Two seconds, matching `garden task`, and for the reason recorded there: the events read crosses
 * a socket, so half-second polling costs 2,400 requests to watch a twenty-minute job. It is worth
 * being plain that this is polling and not a live stream. `GET /v1/tasks/:taskId/events/stream` is
 * an SSE route that exists and reconnects with `Last-Event-ID`, and using it would put the client's
 * first token sooner. It is not used here because a poll of `?after=` is a handful of lines with no
 * reconnection state machine, and this bridge is meant to be small enough to audit. The cost is up
 * to two seconds of added latency per frame, and nothing else.
 */
const POLL_SECONDS = Number(process.env.GARDEN_ACP_POLL_SECONDS || 2);

/** One HTTP call's ceiling, matching `garden task`: creating a task waits on a catalogue read. */
const HTTP_SECONDS = Number(process.env.GARDEN_ACP_HTTP_SECONDS || 30);

/**
 * Task statuses that mean the turn is over, mapped to what this bridge tells the client.
 *
 * `awaiting_user`, `paused` and `awaiting_resource` are endings too. They are the ones a naive
 * bridge reports as success.
 */
const TERMINAL_STATUS = new Set([
  'completed',
  'failed',
  'cancelled',
  'awaiting_user',
  'paused',
  'awaiting_resource'
]);

const jsonrpc = '2.0';

/** Everything one line of stderr should carry. Progress and refusals go here; stdout is protocol. */
const note = (message) => {
  process.stderr.write(`garden acp: ${message}\n`);
};

const die = (message, code = EXIT_CANNOT) => {
  note(message);
  process.exit(code);
};

// --- arguments ----------------------------------------------------------------------------------

/**
 * Read the command line.
 *
 * Worth knowing who controls this: in ACP the CLIENT spawns the agent, so the argv this parses is
 * whatever the client's configuration says. That is why no argument here can widen what a turn is
 * allowed to do - see `--approvals` below, and `refuseModeChange`.
 */
const parseArguments = (argv) => {
  const options = {
    workspace: '',
    model: '',
    credits: '',
    spendUsd: '',
    approvals: 'park',
    turnSeconds: DEFAULT_TURN_SECONDS
  };
  const want = (index, flag) => {
    if (index + 1 >= argv.length) die(`garden acp ${flag} needs a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--workspace':
        options.workspace = want(index, flag);
        index += 1;
        break;
      case '--model':
        options.model = want(index, flag);
        index += 1;
        break;
      case '--credits':
        options.credits = want(index, flag);
        index += 1;
        break;
      case '--spend-usd':
        options.spendUsd = want(index, flag);
        index += 1;
        break;
      case '--approvals':
        options.approvals = want(index, flag);
        index += 1;
        break;
      case '--turn-timeout':
        options.turnSeconds = Number(want(index, flag));
        index += 1;
        break;
      default:
        die(`garden acp: unknown option ${flag}`);
    }
  }
  if (!options.workspace) die('garden acp needs --workspace ID');
  if (!['park', 'relay'].includes(options.approvals))
    die(`garden acp --approvals takes park or relay, not ${options.approvals}`);
  if (!Number.isFinite(options.turnSeconds) || options.turnSeconds <= 0)
    die('garden acp --turn-timeout takes a positive number of seconds');
  for (const [flag, value] of [
    ['--credits', options.credits],
    ['--spend-usd', options.spendUsd]
  ]) {
    if (value !== '' && !Number.isFinite(Number(value))) die(`garden acp ${flag} takes a number`);
  }
  return options;
};

// --- the token ----------------------------------------------------------------------------------

/**
 * The same two places `garden task` looks, in the same order, checked the same way.
 *
 * Deliberately not a third mechanism: docs/HEADLESS.md explains why a token cannot be minted by a
 * machine at all, and a bridge that invented its own way to get one would be routing around that.
 * The pattern check is local because a typo should cost an error message rather than a round trip
 * and an authentication failure the operator has to interpret.
 *
 * Note what this does NOT do, matching the CLI exactly: it does not create the file, set its mode,
 * or check the permissions on it.
 */
const resolveToken = () => {
  const file = process.env.GARDEN_TOKEN_FILE || '/etc/garden/api-token';
  let token = process.env.GARDEN_TOKEN || '';
  if (!token) {
    try {
      token = readFileSync(file, 'utf8').trim();
    } catch {
      token = '';
    }
  }
  if (!token) return { token: '', why: `no API token: put one in ${file} or export GARDEN_TOKEN` };
  if (!/^oc_live_[A-Za-z0-9_-]{40,80}$/.test(token))
    return { token: '', why: 'that is not an garden API token: they begin oc_live_' };
  return { token, why: '' };
};

// --- the HTTP side ------------------------------------------------------------------------------

/** Raised when the API answered something other than success. Carries enough to report honestly. */
class ApiRefusal extends Error {
  constructor(status, code, message, scope) {
    super(message);
    this.status = status;
    this.code = code;
    this.scope = scope;
  }
}

const createApi = (base, token) => {
  const call = async (method, path, { body, idempotencyKey, scope } = {}) => {
    const headers = { Authorization: `Bearer ${token}` };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      // Every write on this API requires an Idempotency-Key. A caller that omitted it would be
      // refused, so the key is built here rather than left to the caller to remember.
      headers['Idempotency-Key'] = idempotencyKey || `garden-acp-${randomUUID()}`;
    }
    let response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(HTTP_SECONDS * 1000)
      });
    } catch (error) {
      throw new ApiRefusal(
        0,
        'unreachable',
        `${base} did not answer (${error.message}). Is garden running, and is GARDEN_API right?`,
        scope
      );
    }
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      // The scope is named because the refusal an operator actually hits is a token minted without
      // it, and a 403 that does not say which of the eight scopes was wanted leaves them guessing.
      const detail = parsed?.error?.message || `HTTP ${response.status}`;
      throw new ApiRefusal(
        response.status,
        parsed?.error?.code || 'refused',
        response.status === 401 || response.status === 403
          ? `${detail} (this call needs the ${scope} scope)`
          : detail,
        scope
      );
    }
    if (parsed === null)
      throw new ApiRefusal(
        response.status,
        'unreadable',
        'the server answered, but not with JSON this could read',
        scope
      );
    return parsed;
  };
  return {
    createTask: (body, key) =>
      call('POST', '/v1/tasks', { body, idempotencyKey: key, scope: 'tasks:write' }),
    continueTask: (taskId, body, key) =>
      call('POST', `/v1/tasks/${taskId}/messages`, {
        body,
        idempotencyKey: key,
        scope: 'tasks:write'
      }),
    getTask: (taskId) => call('GET', `/v1/tasks/${taskId}`, { scope: 'tasks:read' }),
    cancelTask: (taskId) =>
      call('POST', `/v1/tasks/${taskId}/cancel`, {
        body: {},
        idempotencyKey: `garden-acp-cancel-${taskId}`,
        scope: 'tasks:write'
      }),
    // The unwindowed read: everything from the cursor, ascending, as a bare array. That is the
    // shape a poller wants and it is the shape this route has always returned without `?page=1`.
    events: (taskId, after) =>
      call('GET', `/v1/tasks/${taskId}/events?after=${after}`, { scope: 'tasks:read' }),
    pendingApprovals: () =>
      call('GET', '/v1/approvals?status=pending', { scope: 'approvals:read' }),
    decideApproval: (approvalId, decision) =>
      call('POST', `/v1/approvals/${approvalId}/${decision}`, {
        body: {},
        // Names the decision as well as the approval, so answering yes and then no is two
        // operations rather than a replay of the first.
        idempotencyKey: `garden-acp-${decision}-${approvalId}`,
        scope: 'approvals:write'
      })
  };
};

// --- the JSON-RPC transport ---------------------------------------------------------------------

/**
 * Line-delimited JSON-RPC 2.0 over stdin and stdout.
 *
 * Both directions carry requests: the client calls `session/prompt`, and in relay mode this agent
 * calls `session/request_permission` back. So outbound requests need their own ids and a table of
 * what is waiting on them, which `pending` is.
 */
const createTransport = (onMessage) => {
  let nextId = 1;
  const pending = new Map();
  let closed = false;

  const write = (message) => {
    if (closed) return;
    // A client that exits mid-turn closes our stdout. Writing into it raises EPIPE, and an
    // unhandled one here would look like a crash in the middle of somebody's editor session.
    try {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    } catch {
      closed = true;
    }
  };

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      write({ jsonrpc, id, method, params });
    });

  const notify = (method, params) => write({ jsonrpc, method, params });

  const respond = (id, result) => write({ jsonrpc, id, result });

  const respondError = (id, code, message, data) =>
    write({ jsonrpc, id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      // Parse error, per JSON-RPC. Answered without an id because there is no id to answer with.
      write({ jsonrpc, id: null, error: { code: -32700, message: 'Invalid JSON was received' } });
      return;
    }
    // A reply to something this agent asked the client - in practice, a permission decision.
    if (message.id !== undefined && message.method === undefined) {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message || 'client refused'));
      else waiting.resolve(message.result);
      return;
    }
    void onMessage(message);
  });

  const onClose = [];
  lines.on('close', () => {
    closed = true;
    // Anything still waiting on the client will never be answered now. Rejecting rather than
    // leaving the promise unsettled is what lets an in-flight turn end instead of hanging.
    for (const [, waiting] of pending)
      waiting.reject(new Error('the client closed the connection'));
    pending.clear();
    for (const hook of onClose) hook();
  });

  return {
    request,
    notify,
    respond,
    respondError,
    onClose: (hook) => onClose.push(hook),
    isClosed: () => closed
  };
};

// --- events, turned into what a client renders --------------------------------------------------

/**
 * Map one garden task event onto an ACP `session/update`, or onto nothing.
 *
 * The "onto nothing" cases are the load-bearing ones, and they come from how the worker writes a
 * reply rather than from taste. `packages/data/src/store/tasks.ts` says it plainly: "A reply is
 * streamed a frame at a time, and the assistant_message that closes it carries the final text - so
 * the moment that message exists, every delta before it is a redundant slice of it", and the store
 * then DELETES those deltas in the same transaction.
 *
 * That deletion is the trap for a poller. Frames are read at sequences 10, 11, 12; the settled
 * message lands at 13 and removes 10 through 12; the next poll asks for everything after 12 and
 * gets 13, the whole answer again. A bridge that emitted both would show the client every reply
 * twice - once in pieces and once whole - and would look correct in any test whose stand-in did
 * not model the delete.
 *
 * So the rule mirrors the web client's: frames are emitted as they arrive, and the settled message
 * that supersedes them is emitted only if no frame was. `streamed` carries that state, reset by
 * anything that closes a stretch of speech.
 */
/**
 * The id that ties a `tool_call` update to the `tool_call_update` that closes it.
 *
 * The model's own call id, out of the payload, and NOT the timeline row's `event.id`. Those are
 * different things and using the row id was a real defect while this file was being written:
 * `tool_started` and `tool_result` are two rows with two ids, so a client was told a tool call had
 * completed under an id it had never been told was open. `tool-recording.ts` writes
 * `toolCallId: call.id` into both payloads, which is the pair the protocol wants.
 *
 * The fallback to the row id is for a transcript written before that payload field existed. It
 * cannot correlate, and a client seeing it will show an unmatched update rather than a wrong one.
 */
const toolCallId = (event, payload) =>
  typeof payload.toolCallId === 'string' && payload.toolCallId ? payload.toolCallId : event.id;

const createEventMapper = () => {
  let streamedAnswer = false;
  let streamedThinking = false;

  const chunk = (kind, text) => ({
    sessionUpdate: kind,
    content: { type: 'text', text }
  });

  return (event) => {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    const markdown = typeof payload.markdown === 'string' ? payload.markdown : '';
    switch (event.kind) {
      case 'assistant_delta': {
        // Frames are published with `append: true` and are deliberately not trimmed: the space
        // between two words routinely lands on a frame boundary, and trimming welds them together.
        if (payload.append !== true || !markdown) return null;
        streamedAnswer = true;
        return chunk('agent_message_chunk', markdown);
      }
      case 'assistant_message': {
        const settled = markdown || event.summary || '';
        if (streamedAnswer) {
          // The client watched this arrive. Emitting it again is the duplicate described above.
          streamedAnswer = false;
          return null;
        }
        streamedAnswer = false;
        return settled ? chunk('agent_message_chunk', settled) : null;
      }
      case 'assistant_reasoning': {
        // The row that closes a turn's thinking carries the whole of it with `replace`, so that the
        // frames under it can be dropped from the log. Same supersession, same handling.
        if (payload.replace === true) {
          if (streamedThinking) {
            streamedThinking = false;
            return null;
          }
          streamedThinking = false;
          return markdown ? chunk('agent_thought_chunk', markdown) : null;
        }
        if (!markdown) return null;
        streamedThinking = true;
        return chunk('agent_thought_chunk', markdown);
      }
      case 'tool_started': {
        streamedAnswer = false;
        streamedThinking = false;
        return {
          sessionUpdate: 'tool_call',
          toolCallId: toolCallId(event, payload),
          title: event.summary || 'Tool call',
          status: 'in_progress',
          kind: 'other'
        };
      }
      case 'tool_result':
        return {
          sessionUpdate: 'tool_call_update',
          toolCallId: toolCallId(event, payload),
          status: 'completed',
          ...(event.summary ? { title: event.summary } : {})
        };
      case 'plan':
      case 'status':
      case 'notice':
      case 'warning':
      case 'error':
      case 'question_asked':
      case 'approval_requested':
      case 'approval_resolved':
        // Reported as agent speech rather than dropped or invented into a richer shape. `plan` has
        // an ACP update of its own, and it is not used: ACP's plan entries want a status per entry
        // and garden's plan payload does not carry one, so filling the field would mean guessing.
        // The summary is what the owner's own transcript shows for these, so it is what a client
        // gets, and it is labelled with the kind so nothing reads as the model speaking.
        streamedAnswer = false;
        return event.summary
          ? chunk('agent_message_chunk', `\n[${event.kind}] ${event.summary}\n`)
          : null;
      default:
        // task_created, user_message, queued_message, preview, artifact, cost, completed. The
        // client sent the prompt and does not need it read back; the ending is the turn's own
        // result rather than a line of speech.
        return null;
    }
  };
};

// --- the agent ----------------------------------------------------------------------------------

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  const base = process.env.GARDEN_API || 'http://127.0.0.1:4100';
  const { token, why } = resolveToken();
  const api = token ? createApi(base, token) : null;

  /** ACP session id -> what this bridge knows about it. One session is one garden task. */
  const sessions = new Map();
  let initialized = false;
  let exitCode = EXIT_OK;

  const transport = createTransport(async (message) => {
    try {
      await dispatch(message);
    } catch (error) {
      // A throw while answering a request must still answer it; a client waiting on an id that
      // never comes back hangs forever with no way to tell a slow turn from a dead agent.
      if (message.id !== undefined)
        transport.respondError(message.id, INTERNAL_ERROR, error.message || 'internal error');
      else note(`while handling ${message.method}: ${error.message}`);
    }
  });

  /**
   * The permission options this agent will ever offer a client.
   *
   * THIS IS THE CRUX AND IT IS SHORT ON PURPOSE. ACP's `PermissionOptionKind` has four values:
   * `allow_once`, `allow_always`, `reject_once`, `reject_always`. Only the two "once" kinds are
   * offered here, and the two "always" kinds are refused outright, for a reason that is about
   * garden and not about taste:
   *
   *   garden has nowhere to keep a standing decision. `POST /v1/approvals/:id/:decision` resolves
   *   ONE approval; there is no rule table, no remembered grant, nothing that a second identical
   *   request would consult. So `allow_always` cannot be honoured by this agent - and a client
   *   given it would reasonably stop asking its user, which moves the answer from the owner to a
   *   toggle in somebody's editor. Offering an option the server cannot implement would be a false
   *   promise made in the protocol rather than in a comment, and it would be a false promise whose
   *   whole effect is to lower the floor.
   *
   * What this costs, said plainly: a client's "always allow" affordance is unavailable against
   * this agent, and an operator answering many cards answers each of them.
   */
  const requestPermissionOptions = () => [
    { optionId: 'approve', name: 'Approve this once', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny this once', kind: 'reject_once' }
  ];

  /**
   * Every ACP method that would let a client change how much this box stops to ask.
   *
   * Refused with `Method not found`, which is the truth: this agent does not implement them, and
   * `initialize` advertises no capability that would suggest it does. `session/new` returns no
   * `modes`, so there is no mode for `session/set_mode` to name in the first place.
   *
   * The refusal matters more than it looks. `garden task run` already declines a `--security-mode`
   * flag on the same grounds - "a flag on the command that started the work could quietly answer
   * questions the owner had asked to be shown" - and ACP hands a client a general-purpose version
   * of that flag. A client that could set the mode could put this workspace into `autonomous` and
   * lower the floor for every future task, not merely for the turn it was running.
   *
   * One thing underneath this refusal narrows it and one thing does NOT, and the second is the one
   * to know before minting a token. This comment claimed both were narrowings and was wrong.
   *
   *   - the CREATE path cannot carry a mode. `CreateTaskRequest` in
   *     `packages/contracts/src/index.ts` has no `securityMode` field, and the WORKSPACE mode is
   *     changed by `PATCH /v1/workspaces/:id/security-mode`, which `auth-hook.ts` puts behind
   *     `workspaces:write` - a scope an ACP token has no reason to carry.
   *   - but a PER-TASK override exists and is reachable. `PATCH /v1/tasks/:taskId/security-mode`
   *     in `apps/api/src/routes/tasks.ts` sets the mode of one task; `requiredApiTokenScope` sends
   *     it to `tasks:write` because it is under `/v1/tasks`, and the route takes no second factor
   *     on purpose - "No second factor for choosing how much this run asks". `tasks:write` is the
   *     minimum this bridge needs, so every ACP token can reach that route.
   *
   * So the refusal is NOT held up by an unreachable route, and saying it was would have sent an
   * operator to mint a token believing something untrue. What holds it is narrower and worth
   * stating exactly: this file never calls that route, and `createApi` above has no method that
   * could - the only `security-mode` request anything under `scripts/acp/` ever makes is the one
   * drill provokes with both mode setters and then asserts never happened - and on the box the bridge reads
   * the token out of `/etc/garden/api-token` itself, so a client that spawned it never sees the
   * credential. A client that is HANDED the token in `GARDEN_TOKEN`, which is the remote
   * configuration docs/ACP.md describes, holds `tasks:write` and can set that task autonomous with
   * one HTTP call that has nothing to do with this protocol. That is a property of the token, not
   * of ACP, and it is the same for `garden task`; docs/ACP.md says so where it names the scopes.
   */
  const refuseModeChange = (id, method) =>
    transport.respondError(
      id,
      METHOD_NOT_FOUND,
      `garden does not implement ${method}: how much this box stops to ask is its owner's setting, not a client's`
    );

  /**
   * `session/new` carries `mcpServers`, and a non-empty one is refused.
   *
   * ACP lets a client hand the agent a list of MCP servers to connect to for the session. Honouring
   * it would mean this box runs whatever a client names, which is third-party code on the owner's
   * machine arriving through a protocol field - the plugin marketplace this repository declined,
   * with a specification on top of it. garden's connectors are configured by its owner and nowhere
   * else.
   *
   * The empty array is accepted rather than refused, because the field is REQUIRED by the schema
   * (`NewSessionRequest` has `"required": ["cwd", "mcpServers"]`) and every conforming client sends
   * it. Refusing the field's presence would refuse every client there is.
   */
  const refuseForeignMcpServers = (id, servers) => {
    if (!Array.isArray(servers) || servers.length === 0) return false;
    transport.respondError(
      id,
      INVALID_PARAMS,
      `garden will not connect to MCP servers a client names (${servers.length} offered). Its connectors are configured by its owner.`
    );
    return true;
  };

  /**
   * Ask the client to decide one approval, then hand the answer to garden - relay mode only.
   *
   * Read `requestPermissionOptions` above first. The rest of the honesty is here:
   *
   * THE CONTROL IS THE TOKEN'S SCOPE, NOT THIS FLAG. In ACP the client spawns the agent, so the
   * client controls argv and could pass `--approvals relay` itself. What it cannot do is give
   * itself `approvals:write`: `requiredApiTokenScope` in `apps/api/src/http/auth-hook.ts` routes
   * every write under `/v1/approvals` to that scope, and a token minted without it is refused by
   * the server with a 403 no matter what this process was told on its command line. An operator who
   * wants the floor to be unreachable from an editor mints the token without `approvals:write` and
   * is done; the flag is a convenience, the scope is the control, and that is the sentence to
   * verify adversarially.
   *
   * What relay does NOT do: it does not decide anything itself, it cannot answer an approval the
   * owner has not been shown, and it cannot make garden stop asking. Every card garden raises is
   * still raised - the security mode decides which actions are carded and this path never touches
   * it. Relay only changes WHERE the question is displayed.
   */
  const relayApproval = async (sessionId, approval) => {
    const preview =
      typeof approval.preview === 'object' && approval.preview
        ? JSON.stringify(approval.preview).slice(0, 400)
        : String(approval.preview ?? '');
    const answer = await transport.request('session/request_permission', {
      sessionId,
      toolCall: {
        toolCallId: `approval-${approval.id}`,
        title: approval.action || 'garden is asking permission',
        status: 'pending',
        kind: 'other',
        content: [{ type: 'content', content: { type: 'text', text: preview } }]
      },
      options: requestPermissionOptions()
    });
    const outcome = answer?.outcome;
    // A cancelled turn resolves permission requests with `cancelled` rather than a selection, and
    // the specification requires a client to send that. Nothing is answered on that path.
    if (!outcome || outcome.outcome !== 'selected') return 'unanswered';
    const decision = outcome.optionId === 'approve' ? 'approve' : 'deny';
    await api.decideApproval(approval.id, decision);
    return decision;
  };

  /**
   * Watch one task until it stops, streaming what it does, and say how it ended.
   *
   * The stop reason is the part worth arguing with, so the argument is written down.
   *
   * ACP v1 has five stop reasons - `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`,
   * `cancelled` - and no reason for "parked, waiting on a decision nobody has made yet". garden
   * has three endings of exactly that shape: `awaiting_user`, `paused` and `awaiting_resource`,
   * plus a fourth case where this bridge simply stopped watching a task that is still running.
   *
   * Those four are reported as `refusal`, not `end_turn`, and that is a deliberate trade with a
   * real cost on each side:
   *
   *   - `end_turn` means "the turn ended successfully". A parked task reported that way looks
   *     finished to any client that reads only the stop reason. This repository has been bitten
   *     twice by a wrapper returning success while the work died, and `garden task` exists largely
   *     to make that impossible; reintroducing it in a new protocol would be the same defect a
   *     step along.
   *   - `refusal` is documented as meaning the prompt "won't be included in the next prompt, so
   *     this should be reflected in the UI". A client may therefore drop the turn from its own
   *     history. That is cosmetic HERE and only here, because garden owns the transcript: the task
   *     keeps its full context server-side, and the next `session/prompt` continues the same task
   *     whatever the client's UI chose to display.
   *
   * So: the client's display may be wrong, or the operator's belief about whether work finished may
   * be wrong. The second is the one that costs money and lets a live task go unwatched.
   *
   * A `failed` task is different again and is not a stop reason at all - it comes back as a JSON-RPC
   * error, because "the work died" must not be reachable by reading a success field.
   */
  const watchTurn = async (session) => {
    const map = createEventMapper();
    const deadline = Date.now() + options.turnSeconds * 1000;
    const relayed = [];
    for (;;) {
      if (transport.isClosed())
        return { stopReason: 'cancelled', meta: { garden: { ended: 'client-closed' } } };
      const events = await api.events(session.taskId, session.cursor);
      if (Array.isArray(events)) {
        for (const event of events) {
          if (typeof event.sequence === 'number' && event.sequence > session.cursor)
            session.cursor = event.sequence;
          const update = map(event);
          if (update) transport.notify('session/update', { sessionId: session.id, update });
        }
      }
      const task = await api.getTask(session.taskId);
      const status = String(task.status || 'unknown');

      if (session.cancelRequested) {
        // The specification is explicit: this reason MUST come back after `session/cancel`, "even
        // if the cancellation causes exceptions in underlying operations".
        if (TERMINAL_STATUS.has(status) || status === 'cancelled')
          return { stopReason: 'cancelled', meta: { garden: { status, taskId: session.taskId } } };
      }

      if (status === 'completed')
        return { stopReason: 'end_turn', meta: { garden: { status, taskId: session.taskId } } };

      if (status === 'cancelled')
        return { stopReason: 'cancelled', meta: { garden: { status, taskId: session.taskId } } };

      if (status === 'failed') {
        const reason = lastOwnerReason(events);
        throw new ApiRefusal(0, 'task_failed', reason || 'the task failed', 'tasks:read');
      }

      if (status === 'awaiting_user') {
        if (options.approvals === 'relay') {
          const pending = await api.pendingApprovals().catch((error) => {
            note(`could not read the pending approvals: ${error.message}`);
            return [];
          });
          const mine = (Array.isArray(pending) ? pending : []).filter(
            (approval) => String(approval.taskId) === String(session.taskId)
          );
          let answeredAny = false;
          for (const approval of mine) {
            const decision = await relayApproval(session.id, approval);
            relayed.push({ approvalId: approval.id, decision });
            if (decision !== 'unanswered') answeredAny = true;
          }
          // An answered approval requeues the task, so the loop keeps watching rather than ending
          // the turn. Nothing answered means the client declined to decide, which is a park.
          if (answeredAny) {
            await sleep(POLL_SECONDS);
            continue;
          }
        }
        const pending = await describePendingApprovals(session.taskId);
        transport.notify('session/update', {
          sessionId: session.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `\ngarden stopped to ask before going further, and this turn is parked rather than finished.\n${pending}\nAnswer it in garden, or with: sudo garden task approvals ${session.taskId}\n`
            }
          }
        });
        return {
          stopReason: 'refusal',
          meta: {
            garden: {
              status,
              taskId: session.taskId,
              parked: 'awaiting_approval',
              ...(relayed.length ? { relayed } : {})
            }
          }
        };
      }

      if (status === 'paused' || status === 'awaiting_resource') {
        transport.notify('session/update', {
          sessionId: session.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `\ngarden stopped this task (${status}) and it needs a resume before it will run again. Nothing here can clear it: POST /v1/tasks/${session.taskId}/resume is the call.\n`
            }
          }
        });
        return {
          stopReason: 'refusal',
          meta: { garden: { status, taskId: session.taskId, parked: 'needs_resume' } }
        };
      }

      if (Date.now() >= deadline) {
        transport.notify('session/update', {
          sessionId: session.id,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `\nThis turn stopped being watched after ${options.turnSeconds}s. THE TASK IS STILL RUNNING AND STILL SPENDING. Stop it with: sudo garden task cancel ${session.taskId}\n`
            }
          }
        });
        return {
          stopReason: 'refusal',
          meta: {
            garden: {
              status,
              taskId: session.taskId,
              parked: 'still_running',
              stillSpending: true
            }
          }
        };
      }
      await sleep(POLL_SECONDS);
    }
  };

  /**
   * What the task stopped to ask, in words, for the message that says the turn is parked.
   *
   * Guarded because it needs `approvals:read` and the token may not carry it - a run that parks is
   * worth reporting even when the detail of the question cannot be fetched, and a bridge that threw
   * here would turn a readable park into an internal error.
   */
  const describePendingApprovals = async (taskId) => {
    try {
      const pending = await api.pendingApprovals();
      const mine = (Array.isArray(pending) ? pending : []).filter(
        (approval) => String(approval.taskId) === String(taskId)
      );
      if (!mine.length) return 'It did not say what it asked for.';
      return mine.map((approval) => `  - ${approval.action || approval.id}`).join('\n');
    } catch (error) {
      return `The question could not be read (${error.message}).`;
    }
  };

  const dispatch = async (message) => {
    const { id, method, params } = message;
    switch (method) {
      case 'initialize': {
        initialized = true;
        // The negotiation rule: answer the client's version if it is supported, otherwise answer
        // the latest this agent supports and let the client decide whether to continue.
        transport.respond(id, {
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: 'garden', version: readGardenVersion() },
          agentCapabilities: {
            // `session/load` is not implemented: replaying a task's history into a client is a
            // second transcript renderer, and garden already has one that the owner uses.
            loadSession: false,
            promptCapabilities: {
              // Text only. `POST /v1/tasks` takes a string prompt and an `attachments` array of
              // workspace paths, not inline bytes, so a client's image would have to be uploaded
              // through `/v1/workspaces/:id/file` first - which needs `files:write`, a scope this
              // bridge deliberately never asks for. Advertising `image: true` would promise a path
              // that does not exist.
              image: false,
              audio: false,
              embeddedContext: false
            },
            // No MCP capability of any kind is advertised, so a conforming client will not offer
            // servers for `session/new` to refuse. See `refuseForeignMcpServers`.
            mcpCapabilities: { http: false, sse: false }
          },
          // Empty, and it has to be. ACP's `authenticate` would have this agent obtain a credential
          // on the client's behalf, and docs/HEADLESS.md records why garden cannot: a token is
          // minted at a browser by a person with a passkey, and `POST /v1/api-tokens` is reachable
          // by no bearer token at all, so a token cannot mint a second one. There is no auth method
          // to offer, and pretending otherwise would put a login button in front of an operator
          // that could never succeed. A missing token surfaces as -32000 on the first prompt.
          authMethods: []
        });
        return;
      }
      case 'authenticate':
        transport.respondError(
          id,
          METHOD_NOT_FOUND,
          'garden offers no auth methods over ACP: put an API token in GARDEN_TOKEN or /etc/garden/api-token. See docs/HEADLESS.md.'
        );
        return;
      case 'session/new': {
        if (!initialized) {
          transport.respondError(id, INVALID_PARAMS, 'initialize before opening a session');
          return;
        }
        if (refuseForeignMcpServers(id, params?.mcpServers)) return;
        const sessionId = `garden-acp-${randomUUID()}`;
        /*
         * The task is NOT created here, and the reason is not laziness: `POST /v1/tasks` requires
         * the prompt in the same call that creates the task, so there is nothing to create until
         * the first `session/prompt`. `cwd` is recorded and otherwise unused - garden's unit of
         * work is a workspace on the box, not a directory on the client's machine, and quietly
         * treating a client's path as a workspace would be a lie about where the work happens.
         */
        sessions.set(sessionId, {
          id: sessionId,
          taskId: '',
          cursor: 0,
          cwd: typeof params?.cwd === 'string' ? params.cwd : '',
          cancelRequested: false,
          busy: false
        });
        // No `modes` and no `configOptions`: see `refuseModeChange`. A client is given nothing to
        // set, which is a stronger statement than refusing the call afterwards.
        transport.respond(id, { sessionId });
        return;
      }
      case 'session/load':
        transport.respondError(
          id,
          METHOD_NOT_FOUND,
          'garden does not implement session/load; initialize advertises loadSession: false'
        );
        return;
      case 'session/set_mode':
      case 'session/set_config_option':
        refuseModeChange(id, method);
        return;
      case 'session/cancel': {
        // A notification: no response, ever. Answering it would be a protocol error.
        const session = sessions.get(params?.sessionId);
        if (!session) return;
        session.cancelRequested = true;
        if (session.taskId && api)
          await api
            .cancelTask(session.taskId)
            .catch((error) => note(`could not cancel ${session.taskId}: ${error.message}`));
        return;
      }
      case 'session/prompt': {
        const session = sessions.get(params?.sessionId);
        if (!session) {
          transport.respondError(id, INVALID_PARAMS, 'no such session');
          return;
        }
        if (!token) {
          transport.respondError(id, AUTH_REQUIRED, why);
          return;
        }
        if (session.busy) {
          transport.respondError(id, INVALID_PARAMS, 'this session already has a turn in flight');
          return;
        }
        const text = promptText(params?.prompt);
        if (!text) {
          transport.respondError(
            id,
            INVALID_PARAMS,
            'this agent takes text prompts only; initialize advertises image and audio as unsupported'
          );
          return;
        }
        session.busy = true;
        session.cancelRequested = false;
        try {
          if (!session.taskId) {
            const created = await api.createTask({
              workspaceId: options.workspace,
              prompt: text,
              ...(options.model ? { modelId: options.model } : {}),
              ...(options.credits === '' ? {} : { maxComputeCredits: Number(options.credits) }),
              ...(options.spendUsd === '' ? {} : { maxSpendUsd: Number(options.spendUsd) })
            });
            if (!created?.id) throw new Error('the server accepted the task but returned no id');
            session.taskId = created.id;
            // A cancel that arrived while the task was being created found no id to cancel and
            // could only leave its mark. Honour it now, or the turn runs to its own end and the
            // client that cancelled is answered with the task's verdict instead of `cancelled`.
            if (session.cancelRequested)
              await api
                .cancelTask(session.taskId)
                .catch((error) => note(`could not cancel ${session.taskId}: ${error.message}`));
          } else {
            // A second prompt in the same ACP session continues the same garden task, so the
            // conversation the owner sees is the conversation the client is having.
            await api.continueTask(session.taskId, { prompt: text });
          }
          const { stopReason, meta } = await watchTurn(session);
          transport.respond(id, { stopReason, _meta: meta });
        } catch (error) {
          if (error instanceof ApiRefusal) {
            transport.respondError(
              id,
              error.status === 401 || error.status === 403 ? AUTH_REQUIRED : INTERNAL_ERROR,
              error.message,
              {
                garden: {
                  code: error.code,
                  ...(error.status ? { httpStatus: error.status } : {}),
                  ...(error.scope ? { scope: error.scope } : {}),
                  ...(session.taskId ? { taskId: session.taskId } : {})
                }
              }
            );
            if (error.code === 'unreachable') exitCode = EXIT_TRANSPORT;
          } else {
            transport.respondError(
              id,
              INTERNAL_ERROR,
              error.message || 'the turn could not be run'
            );
          }
        } finally {
          session.busy = false;
        }
        return;
      }
      case '$/cancel_request':
        // Acknowledged by doing nothing: the only long-running request this agent answers is
        // `session/prompt`, and `session/cancel` is the method that stops one. Silently ignoring is
        // correct for a notification the agent cannot act on.
        return;
      default:
        if (id !== undefined)
          transport.respondError(id, METHOD_NOT_FOUND, `garden acp does not implement ${method}`);
        return;
    }
  };

  if (!token) note(`${why} - the session will open but the first prompt will be refused`);
  note(
    `speaking ACP v${PROTOCOL_VERSION} for workspace ${options.workspace}, approvals: ${options.approvals}`
  );

  await new Promise((resolve) => transport.onClose(resolve));
  process.exit(exitCode);
};

// --- small helpers ------------------------------------------------------------------------------

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/** Text blocks joined; anything else ignored, which is what `promptCapabilities` promised. */
const promptText = (blocks) =>
  (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();

/**
 * Why a run died, read the way `garden task` reads it and for the reasons recorded there: the
 * worker writes the sentence that ends a run as a `warning` when the code mentions the provider,
 * and a recovered tool call writes an `error` mid-run that has nothing to do with the ending. So
 * the owner-addressed flag is what is looked for, with any `error` as the fallback for transcripts
 * written before that flag existed.
 */
const lastOwnerReason = (events) => {
  if (!Array.isArray(events)) return '';
  const owned = events.filter((event) => event?.payload?.owner === true);
  const chosen = owned.at(-1) || events.filter((event) => event.kind === 'error').at(-1);
  return chosen ? String(chosen.summary || '') : '';
};

/** Best effort; a bridge that could not read its own version number is not a bridge that fails. */
const readGardenVersion = () => {
  try {
    return (
      JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ||
      '0.0.0'
    );
  } catch {
    return '0.0.0';
  }
};

main().catch((error) => {
  note(error?.stack || String(error));
  process.exit(EXIT_TRANSPORT);
});
