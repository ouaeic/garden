import { discardMissionInvocation, trackMissionInvocation } from './mission-processes.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { CodeIntelligenceRequest } from '@athanor/contracts';
import { applyCodeEditPreview, saveCodeEditPreview } from './code-edit-previews.js';
import { prepareInvocation, type InvocationPolicy } from './execution.js';
import { assertUserDataPath, resolveInside } from './files.js';
import { killProcessTree } from './subprocess.js';
import { LspConnection } from './lsp-protocol.js';
import {
  CodeRange,
  codeSource,
  codeUriPath,
  displayRange,
  sourceRange,
  workspaceEdits,
  type Source
} from './code-intelligence-source.js';

export const CODE_SESSION_IDLE_MS = 10 * 60_000;
export const CODE_SESSION_MAX_MS = 60 * 60_000;
export const CODE_SESSION_LIMIT = 8;
export const CODE_DOCUMENT_LIMIT = 32;
const RESULT_LIMIT = 200;
const require = createRequire(import.meta.url);
type Language = CodeIntelligenceRequest['language'];
type Diagnostic = {
  range: z.infer<typeof CodeRange>;
  message: string;
  severity?: number | undefined;
  source?: string | undefined;
  code?: string | number | undefined;
};
const Diagnostics = z.array(
  z.object({
    range: CodeRange,
    message: z.string(),
    severity: z.number().optional(),
    source: z.string().optional(),
    code: z.union([z.string(), z.number()]).optional()
  })
);
type Session = {
  key: string;
  root: string;
  project: string;
  language: Language;
  owner: string;
  child: ChildProcessWithoutNullStreams;
  connection: LspConnection;
  createdAt: number;
  lastUsedAt: number;
  pending: number;
  ready: Promise<void>;
  tail: Promise<unknown>;
  capabilities: Record<string, unknown>;
  documents: Map<string, Source & { version: number }>;
  diagnostics: Map<string, { version?: number | undefined; items: Diagnostic[]; at: number }>;
};

export function nativeLanguageServer(language: Language): { executable: string; args: string[] } {
  if (language === 'r')
    return { executable: 'R', args: ['--vanilla', '--slave', '-e', 'languageserver::run()'] };
  const name = language === 'typescript' ? 'typescript-native' : 'pyright';
  const packageRoot = path.dirname(require.resolve(`${name}/package.json`));
  return {
    executable: process.execPath,
    args:
      language === 'typescript'
        ? [path.join(packageRoot, 'bin/tsc'), '--lsp', '--stdio']
        : [path.join(packageRoot, 'langserver.index.js'), '--stdio']
  };
}

/** Sessions are analysis processes. They never supervise or restart scientific jobs. */
export class CodeIntelligenceManager {
  #sessions = new Map<string, Session>();
  #operations = new Map<string, Set<Promise<unknown>>>();
  #epochs = new Map<string, number>();
  #quiescing = new Set<string>();
  #closed = false;
  #timer: NodeJS.Timeout;
  constructor(
    private readonly policy: InvocationPolicy,
    private readonly now: () => number = Date.now
  ) {
    this.#timer = setInterval(() => this.sweep(), 60_000);
    this.#timer.unref();
  }

  async act(root: string, owner: string, value: unknown): Promise<unknown> {
    if (this.#closed || this.#quiescing.has(root))
      throw new Error('Code analysis is stopping for this workspace');
    const active = this.#operations.get(root) ?? new Set<Promise<unknown>>();
    this.#operations.set(root, active);
    const operation = this.#act(root, owner, value, this.#epochs.get(root) ?? 0);
    active.add(operation);
    try {
      return await operation;
    } finally {
      active.delete(operation);
      if (!active.size) this.#operations.delete(root);
    }
  }
  async #act(root: string, owner: string, value: unknown, epoch: number): Promise<unknown> {
    const request = CodeIntelligenceRequest.parse(value);
    const relative = assertUserDataPath(root, request.root);
    const project = resolveInside(path.join(root, 'workspace'), path.join(root, relative));
    if ((await realpath(project)) !== project || !(await stat(project)).isDirectory())
      throw new Error('Code intelligence requires a real directory inside the workspace');
    if (this.#closed || (this.#epochs.get(root) ?? 0) !== epoch)
      throw new Error('Workspace changed while code analysis was preparing');
    if (request.action === 'apply') {
      if (!request.previewId || !request.paths)
        throw new Error('Apply requires the previewId and exact paths returned by a preview');
      return applyCodeEditPreview(root, owner, project, request.previewId, request.paths);
    }
    const key = JSON.stringify([root, owner, project, request.language]);
    this.sweep();
    let session = this.#sessions.get(key);
    if (request.action === 'status') return this.#status(session, request.language);
    if (request.action === 'stop') {
      if (session) this.#stop(session);
      return this.#status(undefined, request.language);
    }
    if (request.action === 'start') {
      if (!session) session = await this.#start(root, project, owner, key, request.language);
      await session.ready;
      session.lastUsedAt = this.now();
      return this.#status(session, request.language);
    }
    if (!session || session.connection.closed)
      throw new Error(
        'No active language session. Use code_diagnostics action=start for this root and language under the task permission mode.'
      );
    if (session.pending >= 8) throw new Error('Language session request queue is full');
    const active = session;
    active.pending++;
    const result = active.tail
      .catch(() => undefined)
      .then(async () => {
        await active.ready;
        active.lastUsedAt = this.now();
        return this.#read(active, request);
      });
    active.tail = result;
    try {
      return await result;
    } finally {
      active.pending--;
      active.lastUsedAt = this.now();
    }
  }

  sweep(): void {
    const now = this.now();
    for (const session of this.#sessions.values())
      if (
        session.connection.closed ||
        now - session.createdAt >= CODE_SESSION_MAX_MS ||
        (!session.pending && now - session.lastUsedAt >= CODE_SESSION_IDLE_MS)
      )
        this.#stop(session);
  }
  isWorkspaceBusy(root: string): boolean {
    return Boolean(this.#operations.get(root)?.size);
  }
  async quiesceWorkspace(root: string): Promise<void> {
    const sessions = [...this.#sessions.values()].filter((session) => session.root === root);
    await this.stopWorkspace(root);
    await Promise.allSettled(sessions.map((session) => session.tail));
  }
  async stopWorkspace(root: string): Promise<void> {
    this.#quiescing.add(root);
    this.#epochs.set(root, (this.#epochs.get(root) ?? 0) + 1);
    try {
      for (const session of this.#sessions.values()) if (session.root === root) this.#stop(session);
      await Promise.allSettled([...(this.#operations.get(root) ?? [])]);
    } finally {
      this.#quiescing.delete(root);
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    for (const session of this.#sessions.values()) this.#stop(session);
    await Promise.allSettled([...this.#operations.values()].flatMap((writes) => [...writes]));
  }
  #stop(session: Session): void {
    if (this.#sessions.get(session.key) !== session) return;
    this.#sessions.delete(session.key);
    if (!session.connection.closed) {
      void session.connection
        .request('shutdown')
        .then(() => session.connection.notify('exit'))
        .catch(() => undefined)
        .finally(() => {
          session.connection.close();
          killProcessTree(session.child, 'SIGTERM');
        });
    } else killProcessTree(session.child, 'SIGTERM');
    const force = setTimeout(() => {
      session.connection.close();
      killProcessTree(session.child, 'SIGKILL');
    }, 1000);
    force.unref();
  }
  #status(session: Session | undefined, language: Language) {
    return {
      language,
      running: Boolean(session && !session.connection.closed),
      root: session ? path.relative(session.root, session.project) : null,
      startedAt: session ? new Date(session.createdAt).toISOString() : null,
      idleExpiresAt: session
        ? new Date(session.lastUsedAt + CODE_SESSION_IDLE_MS).toISOString()
        : null,
      capabilities: session
        ? {
            diagnostics: Boolean(session.capabilities.diagnosticProvider),
            definition: Boolean(session.capabilities.definitionProvider),
            references: Boolean(session.capabilities.referencesProvider),
            rename: Boolean(session.capabilities.renameProvider),
            hover: Boolean(session.capabilities.hoverProvider),
            symbols: Boolean(session.capabilities.documentSymbolProvider),
            implementation: Boolean(session.capabilities.implementationProvider),
            type_definition: Boolean(session.capabilities.typeDefinitionProvider),
            code_actions: Boolean(session.capabilities.codeActionProvider)
          }
        : null
    };
  }
  async #start(
    root: string,
    project: string,
    owner: string,
    key: string,
    language: Language
  ): Promise<Session> {
    if (this.#sessions.size >= CODE_SESSION_LIMIT)
      throw new Error('Language session capacity reached; stop an unused session');
    const epoch = this.#epochs.get(root) ?? 0;
    const invocation = await prepareInvocation(
      root,
      {
        ...nativeLanguageServer(language),
        cwd: path.relative(root, project),
        env: {},
        network: false,
        requireNetworkIsolation: true
      },
      this.policy
    );
    if (this.#closed || (this.#epochs.get(root) ?? 0) !== epoch) {
      await discardMissionInvocation(invocation);
      throw new Error('Workspace changed while code analysis was preparing');
    }
    // Preparation can await the sandbox specification; recheck before reserving a slot.
    const existing = this.#sessions.get(key);
    if (existing) {
      await discardMissionInvocation(invocation);
      return existing;
    }
    if (this.#sessions.size >= CODE_SESSION_LIMIT)
      throw new Error('Language session capacity reached; stop an unused session');
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      detached: true,
      stdio: 'pipe'
    });
    trackMissionInvocation(root, invocation, child);
    const diagnostics: Session['diagnostics'] = new Map();
    let diagnosticsRegistered: (() => void) | undefined;
    const diagnosticsReady = new Promise<void>((resolve) => {
      diagnosticsRegistered = resolve;
    });
    const connection = new LspConnection(
      child.stdout,
      child.stdin,
      (method, params) => {
        if (method !== 'textDocument/publishDiagnostics') return;
        const parsed = z
          .object({ uri: z.string(), version: z.number().optional(), diagnostics: Diagnostics })
          .safeParse(params);
        if (!parsed.success || !session.documents.has(parsed.data.uri)) return;
        diagnostics.set(parsed.data.uri, {
          version: parsed.data.version,
          items: parsed.data.diagnostics.slice(0, RESULT_LIMIT),
          at: this.now()
        });
      },
      (method, params) => {
        if (method === 'workspace/configuration') {
          const items = z
            .object({ items: z.array(z.object({ section: z.string().optional() })).max(100) })
            .parse(params).items;
          return items.map((item) => {
            if (language !== 'python') return { disableAutomaticTypeAcquisition: true };
            const analysis = {
              diagnosticMode: 'workspace',
              typeCheckingMode: 'standard',
              autoSearchPaths: true
            };
            if (item.section === 'python.analysis') return analysis;
            if (item.section === 'python') return { analysis };
            return {};
          });
        }
        if (method === 'workspace/workspaceFolders')
          return [{ uri: pathToFileURL(project).href, name: path.basename(project) }];
        if (method === 'client/registerCapability') {
          const registrations = z
            .object({
              registrations: z
                .array(
                  z.object({
                    method: z.literal('textDocument/diagnostic'),
                    registerOptions: z.unknown().optional()
                  })
                )
                .min(1)
                .max(8)
            })
            .parse(params).registrations;
          session.capabilities.diagnosticProvider = registrations[0]?.registerOptions ?? true;
          diagnosticsRegistered?.();
          return null;
        }
        if (method === 'client/unregisterCapability') {
          z.object({
            unregisterations: z
              .array(z.object({ method: z.literal('textDocument/diagnostic'), id: z.string() }))
              .max(8)
          }).parse(params);
          return null;
        }
        if (method === 'workspace/applyEdit')
          return {
            applied: false,
            failureReason:
              'garden requires an approved file edit; language servers return previews only'
          };
        if (
          method === 'window/workDoneProgress/create' ||
          method === 'workspace/diagnostic/refresh'
        )
          return null;
        throw new Error('Unsupported language server request');
      },
      () => this.#stop(session)
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (error) => connection.close(error));
    child.on('exit', () =>
      connection.close(
        new Error(
          `Language server exited. ${stderr.trim() || 'Start a new session under the task permission mode.'}${language === 'r' ? ' R analysis requires R and the languageserver R package in the agent environment.' : ''}`
        )
      )
    );
    const session: Session = {
      key,
      root,
      project,
      language,
      owner,
      child,
      connection,
      createdAt: this.now(),
      lastUsedAt: this.now(),
      pending: 0,
      ready: Promise.resolve(),
      tail: Promise.resolve(),
      capabilities: {},
      documents: new Map(),
      diagnostics
    };
    this.#sessions.set(key, session);
    session.ready = (async () => {
      const result = await connection.request('initialize', {
        processId: child.pid ?? null,
        clientInfo: { name: 'garden' },
        rootUri: pathToFileURL(project).href,
        workspaceFolders: [{ uri: pathToFileURL(project).href, name: path.basename(project) }],
        capabilities: {
          general: { positionEncodings: ['utf-16'] },
          workspace: { configuration: true, workspaceFolders: true, applyEdit: false },
          textDocument: {
            synchronization: { dynamicRegistration: false },
            definition: { linkSupport: true },
            references: {},
            hover: { contentFormat: ['markdown', 'plaintext'] },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            implementation: { linkSupport: true },
            typeDefinition: { linkSupport: true },
            codeAction: {
              codeActionLiteralSupport: {
                codeActionKind: { valueSet: ['quickfix', 'refactor', 'source.organizeImports'] }
              }
            },
            rename: { prepareSupport: true },
            diagnostic: { dynamicRegistration: true },
            publishDiagnostics: { versionSupport: true }
          }
        },
        initializationOptions: { disableAutomaticTypeAcquisition: true }
      });
      const initialized = z
        .object({ capabilities: z.record(z.string(), z.unknown()) })
        .parse(result);
      if (
        initialized.capabilities.positionEncoding &&
        initialized.capabilities.positionEncoding !== 'utf-16'
      )
        throw new Error('Language server did not negotiate UTF-16 positions');
      session.capabilities = initialized.capabilities;
      connection.notify('initialized', {});
      if (language === 'python' && !session.capabilities.diagnosticProvider) {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            diagnosticsReady,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 1000);
              timer.unref();
            })
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    })().catch((error: unknown) => {
      this.#stop(session);
      throw error;
    });
    return session;
  }

  async #sync(session: Session, requested: string): Promise<Source & { version: number }> {
    const source = await codeSource(session.root, session.project, requested);
    const previous = session.documents.get(source.uri);
    if (previous?.sha256 === source.sha256) return previous;
    if (!previous && session.documents.size >= CODE_DOCUMENT_LIMIT)
      throw new Error(
        'Language session open-file limit reached; use a narrower project or restart the session'
      );
    const document = { ...source, version: (previous?.version ?? 0) + 1 };
    session.documents.set(source.uri, document);
    session.diagnostics.delete(source.uri);
    if (previous)
      session.connection.notify('textDocument/didChange', {
        textDocument: { uri: source.uri, version: document.version },
        contentChanges: [{ text: source.text }]
      });
    else
      session.connection.notify('textDocument/didOpen', {
        textDocument: {
          uri: source.uri,
          languageId:
            session.language !== 'typescript'
              ? session.language
              : /\.[cm]?jsx?$/.test(source.path)
                ? 'javascript'
                : /\.tsx$/.test(source.path)
                  ? 'typescriptreact'
                  : 'typescript',
          version: document.version,
          text: source.text
        }
      });
    // Opening a Python source joins asynchronous project discovery. Its diagnostic response
    // acknowledges analysis before rename can classify that source as an external library.
    if (session.language === 'python' && session.capabilities.diagnosticProvider) {
      try {
        await session.connection.request('textDocument/diagnostic', {
          textDocument: { uri: source.uri }
        });
      } catch (error) {
        this.#stop(session);
        throw error;
      }
    }
    return document;
  }

  async #read(session: Session, request: CodeIntelligenceRequest): Promise<unknown> {
    if (!request.path) throw new Error('This code-intelligence action requires path');
    for (const document of session.documents.values()) {
      try {
        await this.#sync(session, document.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        session.connection.notify('textDocument/didClose', { textDocument: { uri: document.uri } });
        session.documents.delete(document.uri);
        session.diagnostics.delete(document.uri);
      }
    }
    const source = await this.#sync(session, request.path);
    if (request.action === 'diagnostics') {
      let report: { items: Diagnostic[] };
      let complete = true;
      if (session.capabilities.diagnosticProvider) {
        report = z.object({ kind: z.literal('full'), items: Diagnostics }).parse(
          await session.connection.request('textDocument/diagnostic', {
            textDocument: { uri: source.uri }
          })
        );
      } else {
        const deadline = Date.now() + 5000;
        let pushed = session.diagnostics.get(source.uri);
        while (!pushed && Date.now() < deadline && !session.connection.closed) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          pushed = session.diagnostics.get(source.uri);
        }
        complete = pushed?.version === source.version;
        report = {
          items:
            pushed && (pushed.version === undefined || pushed.version === source.version)
              ? pushed.items
              : []
        };
      }
      await this.#assertCurrent(session, source);
      for (const entry of report.items) sourceRange(source.text, entry.range);
      return {
        path: source.path,
        sha256: source.sha256,
        complete,
        ...(!complete
          ? { note: 'The server has not confirmed diagnostics for this exact document version.' }
          : {}),
        total: report.items.length,
        truncated: report.items.length > RESULT_LIMIT,
        diagnostics: report.items.slice(0, RESULT_LIMIT).map((entry) => ({
          ...entry,
          message: entry.message.slice(0, 4000),
          range: displayRange(entry.range)
        }))
      };
    }
    if (request.action === 'symbols') {
      if (!session.capabilities.documentSymbolProvider)
        throw new Error('Language server does not support document symbols');
      const raw = await session.connection.request('textDocument/documentSymbol', {
        textDocument: { uri: source.uri }
      });
      const entries: unknown[] = [];
      let total = 0;
      const visit = (items: unknown, parent?: string): void => {
        for (const item of z.array(z.unknown()).parse(items ?? [])) {
          const symbol = z
            .object({
              name: z.string(),
              kind: z.number().int(),
              detail: z.string().optional(),
              range: CodeRange.optional(),
              selectionRange: CodeRange.optional(),
              location: z.object({ uri: z.string(), range: CodeRange }).optional(),
              children: z.array(z.unknown()).optional()
            })
            .parse(item);
          const range = symbol.selectionRange ?? symbol.range ?? symbol.location?.range;
          if (!range || (symbol.location && symbol.location.uri !== source.uri)) continue;
          sourceRange(source.text, range);
          total++;
          if (entries.length < RESULT_LIMIT)
            entries.push({
              name: symbol.name.slice(0, 500),
              kind: symbol.kind,
              detail: symbol.detail?.slice(0, 1000),
              parent,
              range: displayRange(range)
            });
          if (symbol.children) visit(symbol.children, symbol.name);
        }
      };
      visit(raw);
      await this.#assertCurrent(session, source);
      return {
        path: source.path,
        sha256: source.sha256,
        entries,
        total,
        truncated: total > entries.length
      };
    }
    if (!request.line || !request.column)
      throw new Error('This action requires one-based line and UTF-16 column');
    const position = { line: request.line - 1, character: request.column - 1 };
    sourceRange(source.text, { start: position, end: position });
    const params = { textDocument: { uri: source.uri }, position };
    if (request.action === 'rename') return this.#rename(session, source, params, request.newName);
    const navigation = {
      definition: ['textDocument/definition', 'definitionProvider'],
      references: ['textDocument/references', 'referencesProvider'],
      implementation: ['textDocument/implementation', 'implementationProvider'],
      type_definition: ['textDocument/typeDefinition', 'typeDefinitionProvider'],
      hover: ['textDocument/hover', 'hoverProvider'],
      code_actions: ['textDocument/codeAction', 'codeActionProvider']
    } as const;
    const route = navigation[request.action as keyof typeof navigation];
    if (!route || !session.capabilities[route[1]])
      throw new Error(`Language server does not support ${request.action}`);
    const raw = await session.connection.request(
      route[0],
      request.action === 'code_actions'
        ? {
            textDocument: params.textDocument,
            range: { start: position, end: position },
            context: { diagnostics: session.diagnostics.get(source.uri)?.items ?? [] }
          }
        : {
            ...params,
            ...(request.action === 'references' ? { context: { includeDeclaration: true } } : {})
          }
    );
    if (request.action === 'hover') {
      const hover = z
        .object({ contents: z.unknown(), range: CodeRange.optional() })
        .nullable()
        .parse(raw);
      const stringify = (value: unknown): string => {
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) return value.map(stringify).join('\n\n');
        return z.object({ value: z.string() }).parse(value).value;
      };
      const text = hover ? stringify(hover.contents) : '';
      if (hover?.range) sourceRange(source.text, hover.range);
      await this.#assertCurrent(session, source);
      return {
        path: source.path,
        sha256: source.sha256,
        text: text.slice(0, 12000),
        truncated: text.length > 12000,
        ...(hover?.range ? { range: displayRange(hover.range) } : {})
      };
    }
    if (request.action === 'code_actions') {
      const actions = z
        .array(
          z.object({
            title: z.string(),
            kind: z.string().optional(),
            edit: z.unknown().optional(),
            command: z.unknown().optional(),
            disabled: z.object({ reason: z.string() }).optional()
          })
        )
        .parse(raw ?? []);
      const entries = [];
      for (const action of actions.slice(0, 30)) {
        let preview: unknown;
        try {
          if (action.edit)
            preview = await this.#editPreview(
              session,
              workspaceEdits(action.edit),
              !action.command && !action.disabled
            );
        } catch (cause) {
          preview = { unavailable: cause instanceof Error ? cause.message : 'Cannot preview edit' };
        }
        entries.push({
          title: action.title.slice(0, 1000),
          kind: action.kind,
          disabled: action.disabled?.reason,
          preview,
          requiresCommand: action.command !== undefined
        });
      }
      await this.#assertCurrent(session, source);
      return {
        path: source.path,
        sha256: source.sha256,
        applied: false,
        actions: entries,
        total: actions.length,
        truncated: actions.length > entries.length
      };
    }
    const locations = z
      .array(
        z.union([
          z.object({ uri: z.string(), range: CodeRange }),
          z.object({
            targetUri: z.string(),
            targetRange: CodeRange,
            targetSelectionRange: CodeRange
          })
        ])
      )
      .parse(raw === null ? [] : Array.isArray(raw) ? raw : [raw]);
    const entries = [];
    let excluded = 0;
    for (const location of locations.slice(0, RESULT_LIMIT)) {
      try {
        const uri = 'uri' in location ? location.uri : location.targetUri;
        const range = 'range' in location ? location.range : location.targetSelectionRange;
        const target = await codeSource(
          session.root,
          session.project,
          codeUriPath(session.root, session.project, uri)
        );
        sourceRange(target.text, range);
        entries.push({
          path: target.path,
          range: displayRange(range),
          sha256: target.sha256,
          lineText: target.text.split('\n')[range.start.line]?.slice(0, 500) ?? ''
        });
      } catch {
        excluded++;
      }
    }
    await this.#assertCurrent(session, source);
    return {
      path: source.path,
      sha256: source.sha256,
      entries,
      excluded,
      total: locations.length,
      truncated: locations.length > RESULT_LIMIT
    };
  }
  async #assertCurrent(session: Session, source: Source): Promise<void> {
    if ((await codeSource(session.root, session.project, source.path)).sha256 !== source.sha256)
      throw new Error('Source changed during language analysis; retry against the current file');
  }
  async #rename(
    session: Session,
    source: Source,
    params: unknown,
    newName: string | undefined
  ): Promise<unknown> {
    if (!newName || !session.capabilities.renameProvider)
      throw new Error('Rename requires newName and a language server with rename support');
    const rename = async () =>
      workspaceEdits(
        await session.connection.request('textDocument/rename', { ...(params as object), newName })
      );
    let edits = await rename();
    for (const uri of edits.keys())
      await this.#sync(session, codeUriPath(session.root, session.project, uri));
    edits = await rename();
    const preview = await this.#editPreview(session, edits);
    await this.#assertCurrent(session, source);
    return { ...preview, newName };
  }

  async #editPreview(
    session: Session,
    edits: ReturnType<typeof workspaceEdits>,
    applicable = true
  ) {
    const files = [];
    const changed = [];
    let bytes = 0;
    for (const [uri, changes] of edits) {
      const snapshot = session.documents.get(uri);
      if (!snapshot)
        throw new Error('Read diagnostics for each affected file, then request this preview again');
      const expectedVersion = edits.versions.get(uri);
      if (expectedVersion != null && expectedVersion !== snapshot.version)
        throw new Error('Language server edit targets a stale document version');
      await this.#assertCurrent(session, snapshot);
      const ranges = changes
        .map((edit) => ({ ...edit, ...sourceRange(snapshot.text, edit.range) }))
        .sort((a, b) => a.start - b.start);
      for (let index = 1; index < ranges.length; index++)
        if (ranges[index]!.start < ranges[index - 1]!.end)
          throw new Error('Language server returned overlapping rename edits');
      files.push({
        path: snapshot.path,
        sha256: snapshot.sha256,
        edits: ranges.map((edit) => ({
          range: displayRange(edit.range),
          oldText: snapshot.text.slice(edit.start, edit.end),
          newText: edit.newText
        }))
      });
      let content = snapshot.text;
      for (const edit of [...ranges].reverse())
        content = content.slice(0, edit.start) + edit.newText + content.slice(edit.end);
      changed.push({ path: snapshot.path, sha256: snapshot.sha256, content });
      bytes += Buffer.byteLength(JSON.stringify(files[files.length - 1]));
      if (bytes > 100_000)
        throw new Error('Rename preview exceeds its response limit; narrow the project');
    }
    return {
      preview: true,
      applied: false,
      root: path.relative(session.root, session.project),
      ...(applicable && changed.length
        ? {
            previewId: await saveCodeEditPreview(
              session.root,
              session.owner,
              session.project,
              changed
            ),
            paths: changed.map((file) => file.path)
          }
        : {}),
      files,
      edits: files.reduce((sum, file) => sum + file.edits.length, 0)
    };
  }
}
