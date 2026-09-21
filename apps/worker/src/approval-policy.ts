/** The strongest provenance, lifetime and ordinary-effect requirement is authoritative. */
import { publishesPublicly, type SecurityMode } from '@athanor/contracts';
import { connectorActions, privateDiagnostics, recordPrivateDiagnostic } from '@athanor/core';
import {
  classifyDestination,
  MAX_TURN_NOVEL_BYTES,
  MAX_NOVEL_URL_BYTES,
  type DestinationVerdict
} from './egress.js';
import { scanSkillBodyForSecrets } from './skills.js';
import { surfaceActionVerb } from './surface-actions.js';
import { textValue } from './values.js';
import { checkpointInvocation } from './shell-job.js';
import {
  callDestinations,
  isScheduledExecutionPath,
  statedBindReach
} from './command-classification.js';
import {
  deferredExecutionPaths,
  isDurableInstructionPath,
  writtenPaths
} from './write-classification.js';
import {
  codingAgentName,
  connectorApprovalCard,
  skillUpsertAction,
  skillUpsertPreview
} from './approval-cards.js';
import {
  type ApprovalContext,
  type ApprovalRequirement,
  APPROVAL_RANK,
  SECURITY_MODE_FLOOR,
  DEFERRED_EXECUTION_ACTION,
  namedObjects,
  shellInvocation
} from './approval-common.js';
import { shellApprovalRequirement } from './approval-shell.js';
import { mediaApprovalRequirement } from './approval-media.js';
import { mergeTaskApproval, withTaskApproval } from './approval-grants.js';
export { SECURITY_MODE_FLOOR, type ApprovalContext } from './approval-common.js';

const NON_CREDENTIAL_SECRET_LABELS = new Set(['an email address']);

const memoryCredentialScan = (content: string): string[] =>
  scanSkillBodyForSecrets(content).filter((label) => !NON_CREDENTIAL_SECRET_LABELS.has(label));

export const MEMORY_SELF_EXPIRY_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;

export const memoryApprovalReason = (
  args: Record<string, unknown>,
  now = new Date(),
  taintSources: readonly string[] = []
): string | null => {
  const action = textValue(args.action);
  if (action === 'list' || action === '') return null;
  if (taintSources.length && ['add', 'replace', 'remove'].includes(action))
    return `This turn has read untrusted content (${taintSources.slice(0, 3).join(', ')}), so a memory write is shown to you before it is saved.`;
  if (action === 'remove')
    return 'Removing an entry the owner reviewed cannot be undone from here.';
  if (action === 'replace')
    return 'Replacing rewrites an entry the owner already reviewed, so the original is gone.';
  const content = textValue(args.content);
  const secrets = memoryCredentialScan(content);
  if (secrets.length)
    return `This appears to contain ${secrets.join(', ')}, which must never be stored in memory.`;
  const validUntil = Date.parse(textValue(args.validUntil));
  if (!Number.isFinite(validUntil) || validUntil <= now.getTime())
    return 'Without a validUntil this entry is loaded into every future task on this computer indefinitely.';
  if (validUntil - now.getTime() > MEMORY_SELF_EXPIRY_HORIZON_MS)
    return 'This expires more than a year out, which is a permanent entry with a date on it.';
  return null;
};

type PublishReachOfCall = 'private' | 'public' | null;

const publishReachOfCall = (name: string, args: Record<string, unknown>): PublishReachOfCall =>
  name === 'publish_preview' ? (publishesPublicly(args.reach) ? 'public' : 'private') : null;

const strongestRequirement = (
  raised: ApprovalRequirement | null,
  ordinary: ApprovalRequirement | null
): ApprovalRequirement | null => {
  if (!raised) return ordinary;
  if (!ordinary) return raised;
  const strongest =
    APPROVAL_RANK[ordinary.sideEffect] > APPROVAL_RANK[raised.sideEffect] ? ordinary : raised;
  const { recovery: _recovery, taskGrant: _taskGrant, ...required } = strongest;
  const taskGrant = mergeTaskApproval(raised.taskGrant, ordinary.taskGrant);
  return {
    ...required,
    ...(taskGrant ? { taskGrant } : {}),
    ...(raised.recovery && ordinary.recovery
      ? {
          recovery:
            raised.recovery === 'separate_network_steps' ||
            ordinary.recovery === 'separate_network_steps'
              ? ('separate_network_steps' as const)
              : ('verify_public_source' as const)
        }
      : {}),
    preview:
      raised.preview === ordinary.preview
        ? strongest.preview
        : `${raised.preview}\n\n${ordinary.preview}`
  };
};

const destinationCard = (
  verdicts: readonly DestinationVerdict[],
  taintSources: readonly string[],
  what: string,
  spent: number
): ApprovalRequirement => ({
  sideEffect: 'external_reversible',
  action: `Allow ${what} to ${verdicts[0]?.host ?? 'an outside host'}`,
  ...(verdicts.length > 0 &&
  verdicts.every(
    (verdict) => verdict.unfamiliarPublicHost && verdict.noveltyBytes <= MAX_NOVEL_URL_BYTES
  ) &&
  spent + verdicts.reduce((total, verdict) => total + verdict.noveltyBytes, 0) <=
    MAX_TURN_NOVEL_BYTES
    ? { recovery: 'verify_public_source' as const }
    : {}),
  preview: [
    'Garden could not verify these destinations against the request and sources already checked.',
    ...verdicts
      .slice(0, 6)
      .map(
        (verdict) => `- ${verdict.host}: ${verdict.reason} (${verdict.noveltyBytes} bytes charged)`
      ),
    `Address allowance: ${spent} of ${MAX_TURN_NOVEL_BYTES} bytes used; ${verdicts.reduce((total, verdict) => total + verdict.noveltyBytes, 0)} requested.`,
    `Content read: ${taintSources.slice(0, 3).join(', ')}.`
  ].join('\n')
});

const taintedRequirement = (
  name: string,
  args: Record<string, unknown>,
  context: ApprovalContext,
  taintSources: readonly string[]
): ApprovalRequirement | null => {
  const destinations = {
    knownOrigins: context.knownOrigins ?? [],
    knownAddresses: context.knownAddresses ?? [],
    ownerText: context.ownerText ?? '',
    selfOrigins: context.selfOrigins ?? [],
    spentNoveltyBytes: context.spentNoveltyBytes ?? 0
  };
  const destinationVerdicts = (): DestinationVerdict[] => {
    let spent = destinations.spentNoveltyBytes;
    const verdicts: DestinationVerdict[] = [];
    for (const url of callDestinations(name, args)) {
      const verdict = classifyDestination(url, { ...destinations, spentNoveltyBytes: spent });
      spent += verdict.noveltyBytes;
      verdicts.push(verdict);
    }
    return verdicts;
  };
  const sinkVerdicts = (): DestinationVerdict[] =>
    destinationVerdicts().filter((verdict) => verdict.sink);
  if (name === 'parallel_web_read' || name === 'browser_action') {
    const verdicts = sinkVerdicts();
    if (verdicts.length) {
      const card = destinationCard(
        verdicts,
        taintSources,
        name === 'browser_action' ? 'this page' : 'this read',
        destinations.spentNoveltyBytes
      );
      return card.recovery && name === 'parallel_web_read'
        ? withTaskApproval(card, name, args, 'network')
        : card;
    }
  }
  const durable = writtenPaths(name, args).filter(isDurableInstructionPath);
  if (durable.length)
    return {
      sideEffect: 'workspace_write',
      action: `Review a change to ${durable[0]}`,
      preview: `${namedObjects(durable)} is loaded ahead of every later task on this computer, so writing it while untrusted content is in the turn (${taintSources.slice(0, 3).join(', ')}) is shown to you first.`
    };
  if (publishReachOfCall(name, args) === 'private')
    return {
      sideEffect: 'external_reversible',
      action: 'Publish a private preview from a turn that read untrusted content',
      preview: `This turn has read untrusted content (${taintSources.slice(0, 3).join(', ')}). A preview link is reachable from outside this computer.`
    };
  if (name === 'shell' || name === 'desktop_launch') {
    const verdicts = destinationVerdicts();
    const sinks = verdicts.filter((verdict) => verdict.sink);
    if (sinks.length) {
      const card = destinationCard(
        sinks,
        taintSources,
        'this command',
        destinations.spentNoveltyBytes
      );
      return card.recovery && name === 'shell'
        ? withTaskApproval(card, name, args, 'network')
        : card;
    }
    if (name === 'desktop_launch')
      return {
        sideEffect: 'external_consequential',
        action: `Open ${textValue(args.executable, 'an application')} on the desktop`,
        preview: `Launch ${[textValue(args.executable, 'an application'), ...(Array.isArray(args.args) ? args.args.map(String) : [])].join(' ')} on the agent computer's desktop, after this turn read untrusted content (${taintSources.slice(0, 3).join(', ')}).`
      };
  }
  return null;
};

const serviceRequirement = (
  name: string,
  args: Record<string, unknown>,
  taintSources: readonly string[]
): ApprovalRequirement | null => {
  if (name !== 'shell' || args.background !== true) return null;
  const service = textValue(args.service);
  if (!service) return null;
  const command = [
    textValue(args.executable, 'command'),
    ...(Array.isArray(args.args) ? args.args.map(String) : [])
  ].join(' ');
  const bindReach = statedBindReach(args);
  const reachNote =
    bindReach === 'internet'
      ? ` It listens on every network interface this computer has, so anyone who can reach this computer on that port can reach what ${service} serves.`
      : bindReach === 'estate'
        ? ` It listens on an address other computers on this network can reach, not only this one.`
        : bindReach === 'self'
          ? ` It listens on this computer only, so nothing off this machine can reach it directly.`
          : '';
  return {
    sideEffect:
      taintSources.length || bindReach === 'internet' || bindReach === 'estate'
        ? 'external_consequential'
        : 'external_reversible',
    action:
      bindReach === 'internet'
        ? `Keep ${service} running on this computer, reachable from outside it`
        : `Keep ${service} running on this computer`,
    preview: `Run ${command} as a service called ${service}. It has no time limit, is started again whenever it stops, and comes back after this computer restarts, so it outlives this task.${reachNote}${
      taintSources.length
        ? ` This turn has read untrusted content (${taintSources.slice(0, 3).join(', ')}).`
        : ''
    }`
  };
};

export const approvalRequirement = (
  name: string,
  args: Record<string, unknown>,
  securityMode: SecurityMode = 'balanced',
  context: ApprovalContext = {},
  now = new Date()
): ApprovalRequirement | null => {
  const result = calculateApprovalRequirement(name, args, securityMode, context, now);
  if (privateDiagnostics())
    void recordPrivateDiagnostic('approval_decision', () => ({
      input: { name, args, securityMode, context, now: now.toISOString() },
      result
    }));
  return result;
};

const calculateApprovalRequirement = (
  name: string,
  args: Record<string, unknown>,
  securityMode: SecurityMode,
  context: ApprovalContext,
  now: Date
): ApprovalRequirement | null => {
  const taintSources = context.taintSources ?? [];
  if (name === 'decide')
    return context.decisionInference?.boundToTaskConnection === true
      ? null
      : {
          sideEffect: 'external_reversible',
          action: 'Review decision inference',
          preview:
            'The decision destination has not been verified against this task’s saved model connection and privacy policy.'
        };
  if (name === 'process' && args.action === 'describe') return null;
  if (name === 'process' && args.action === 'write')
    return {
      sideEffect: 'external_consequential',
      action: 'Review process input',
      preview:
        'Resolve the owning process and check its command together with all submitted input before writing.'
    };
  if (name === 'process' && args.action === 'workflow') {
    const action = (args.options as { action?: unknown } | undefined)?.action;
    if (action === 'list' || action === 'status') return null;
    return {
      sideEffect: 'external_consequential',
      action: 'Review workflow execution',
      preview:
        'Resolve the owning task, pipeline, configuration and network authority before starting or resuming a workflow.'
    };
  }
  if (name === 'process' && args.action === 'debug') {
    const action = (
      args.options as
        | {
            action?: unknown;
          }
        | undefined
    )?.action;
    if (action === 'list' || action === 'status') return null;
    return {
      sideEffect: 'external_consequential',
      action: 'Review native debugger authority',
      preview:
        'Resolve the owning task, stored program, stopped epoch and exact live operation before using the debugger.'
    };
  }
  if (name === 'process' && args.action === 'compute') {
    const action = (
      args.options as
        | {
            action?: unknown;
          }
        | undefined
    )?.action;
    if (action === 'list' || action === 'status') return null;
    return {
      sideEffect: 'external_consequential',
      action: 'Review native computation authority',
      preview:
        'Evaluate the exact cell against its runner-stored interpreter, workspace, network confinement and deadline before execution.'
    };
  }
  if (name === 'process' && args.action === 'resume')
    return {
      sideEffect: 'external_consequential',
      action: 'Review the stored checkpoint recovery command',
      preview:
        'Recovery must be evaluated from the runner’s persisted command before this job resumes.'
    };
  const original = strongestRequirement(
    taintSources.length ? taintedRequirement(name, args, context, taintSources) : null,
    strongestRequirement(
      serviceRequirement(name, args, taintSources),
      ordinaryRequirement(name, args, securityMode, context, now)
    )
  );
  if (name !== 'shell') return original;
  const checkpoint = checkpointInvocation(args);
  if (!checkpoint) return original;
  const recovery = approvalRequirement('shell', checkpoint, securityMode, context, now);
  const declaration: ApprovalRequirement = {
    sideEffect: taintSources.length ? 'external_consequential' : 'external_reversible',
    action: `Allow checkpoint recovery for ${textValue(args.job, 'this finite job')}`,
    preview: `Run ${shellInvocation(args)} now. If interrupted, run only this declared checkpoint command: ${shellInvocation(checkpoint)}. The original deadline still applies; completed work is never restarted.`
  };
  const strongest = strongestRequirement(original, strongestRequirement(recovery, declaration))!;
  return {
    ...strongest,
    preview: [declaration.preview, original?.preview, recovery?.preview]
      .filter(Boolean)
      .join('\n\n')
  };
};

const consequentialText =
  /\b(submit|apply|purchase|buy|pay|send|publish|delete|remove|confirm|place order|sign|accept offer|post|save changes|install|uninstall|erase|wipe|destroy|discard|overwrite|revoke|deactivate|terminate|format|reset|empty trash|empty bin|move to trash|move to bin|accept\w*\s+[a-z ]{0,16}terms|agree\w*\s+[a-z ]{0,16}terms|accept\w*\s+[a-z ]{0,16}licen[cs]e|agree\w*\s+[a-z ]{0,16}licen[cs]e|accept\w*\s+[a-z ]{0,16}eula|agree\w*\s+[a-z ]{0,16}eula)\b/i;

const SURFACE_HEADLINES: Record<string, string> = {
  click: 'Activate a control that can change something',
  click_at: 'Click at a coordinate',
  dialog: 'Accept a page dialog',
  double_click: 'Activate a control that can change something',
  drag: 'Drag between two coordinates',
  invoke: 'Activate a control that can change something',
  press: 'Press Enter',
  upload: 'Send workspace files to a website'
};

const surfaceVerbName = (args: Record<string, unknown>): string => {
  const verb = surfaceActionVerb(args);
  return /^[a-z_]{1,24}$/.test(verb) ? verb : '';
};

const surfaceHeadline = (name: string, verb: string): string =>
  `${SURFACE_HEADLINES[verb] ?? 'Interact with the visible computer'} (${name === 'browser_action' ? 'browser' : 'desktop'})`;

const statedReason = (purpose: unknown): string => {
  const text = textValue(purpose).replace(/\s+/g, ' ').replace(/"/g, "'").trim().slice(0, 300);
  return text ? `The agent states its reason as: "${text}"` : 'The agent stated no reason.';
};

const ordinaryRequirement = (
  name: string,
  args: Record<string, unknown>,
  securityMode: SecurityMode,
  context: ApprovalContext,
  now: Date
): ApprovalRequirement | null => {
  if (name === 'code_diagnostics' && textValue(args.action) === 'start')
    return withTaskApproval(
      {
        sideEffect: 'external_reversible',
        action: 'Start native code analysis',
        preview: `Launch native ${textValue(args.language)} analysis for ${textValue(args.path) || 'workspace'}. It reads project source under the workspace sandbox and network policy, and expires when idle. Rename returns previews only.`
      },
      name,
      args,
      'analysis'
    );
  const deferred = deferredExecutionPaths(name, args).sort(
    (left, right) => left.length - right.length
  );
  if (deferred.length)
    return {
      sideEffect: 'external_consequential',
      action: DEFERRED_EXECUTION_ACTION,
      preview: `${namedObjects(deferred)} is executed by a later process - the login shell, git itself, or one of the coding CLIs, all of which run under the agent's own HOME - so whatever it says runs after this task, outside any approval this task could raise.`
    };
  const scheduled = (name === 'shell' ? writtenPaths(name, args) : [])
    .filter((path) => isScheduledExecutionPath(path))
    .sort((left, right) => left.length - right.length);
  if (scheduled.length)
    return {
      sideEffect: 'external_consequential',
      action: DEFERRED_EXECUTION_ACTION,
      preview: `${namedObjects(scheduled)} is inside a directory a scheduler or an init system runs the contents of, so whatever it says runs on its own schedule after this task, outside any approval this task could raise.`
    };
  if (name === 'schedule' && textValue(args.action) !== 'list')
    return {
      sideEffect: 'external_reversible',
      action: `${textValue(args.action, 'Change')} scheduled work`,
      preview:
        textValue(args.action) === 'create'
          ? `${textValue(args.title, 'Scheduled task')}\n${textValue(args.prompt).slice(0, 1500)}\n${JSON.stringify(args.spec ?? {})}`
          : `${textValue(args.action)} schedule ${textValue(args.id, 'unknown')}`
    };
  if (name === 'memory') {
    const reason = memoryApprovalReason(args, now, context.taintSources ?? []);
    if (reason)
      return {
        sideEffect: 'workspace_write',
        action: `Review long-term ${['replace', 'remove'].includes(textValue(args.action)) ? '' : `${textValue(args.target, 'workspace')} `}memory`,
        preview:
          textValue(args.action) === 'remove'
            ? `Remove memory entry ${textValue(args.id, 'unknown')}.\n\n${reason}`
            : `${textValue(args.action) === 'replace' ? 'Replace with' : 'Save'}:\n${textValue(args.content).slice(0, 2000)}\n\n${reason}`
      };
    return null;
  }
  if (name === 'skill' && ['upsert', 'remove'].includes(textValue(args.action))) {
    if (textValue(args.action) === 'remove')
      return {
        sideEffect: 'workspace_write',
        action: `Review reusable skill ${textValue(args.id, 'change')}`,
        preview: `Remove skill ${textValue(args.id, 'unknown')}.`
      };
    return {
      sideEffect: 'workspace_write',
      action: skillUpsertAction(
        textValue(args.name, textValue(args.id, 'change')),
        context?.existingSkill
      ),
      preview: skillUpsertPreview(
        textValue(args.name),
        textValue(args.description),
        textValue(args.content),
        context?.existingSkill
      )
    };
  }
  if (name === 'generate_media' || name === 'audio_read') {
    const result = mediaApprovalRequirement(name, args, context);
    if (result !== undefined) return result;
  }
  if (name === 'coding_agent' && args.agent === 'garden') {
    if (['run', 'integrate'].includes(textValue(args.action)) && securityMode === 'review')
      return {
        sideEffect: 'workspace_write',
        action:
          textValue(args.action) === 'run'
            ? 'Start an isolated coding specialist'
            : 'Integrate reviewed coding changes',
        preview: JSON.stringify(args.options ?? {}).slice(0, 4000)
      };
    return null;
  }
  if (name === 'coding_agent' && textValue(args.action) === 'setup')
    return {
      sideEffect: 'external_reversible',
      action: `Install ${codingAgentName(args.agent)}`,
      preview:
        'Download the publisher’s current official CLI package into this private agent computer. The upstream software and service terms apply.'
    };
  if (name === 'coding_agent' && textValue(args.action) === 'run')
    return {
      sideEffect: 'external_reversible',
      action: `Delegate repository work to ${codingAgentName(args.agent)}`,
      preview: `${textValue(args.prompt).slice(0, 2000)}\n\nThe selected subscription service can inspect and modify files inside this agent computer. garden keeps the process inside the workspace and records its bounded result.`
    };
  if (name === 'shell' || name === 'desktop_launch') {
    const result = shellApprovalRequirement(name, args, securityMode, context);
    if (result !== undefined) return result;
  }
  if (publishReachOfCall(name, args) === 'public') {
    const label = textValue(args.label, 'App');
    const port = textValue(args.port, 'unknown');
    return {
      sideEffect: 'external_consequential',
      action: `Publish ${label} publicly`,
      preview: `Expose workspace port ${port} at a persistent public URL. Anyone with the URL can access the app until it is unpublished or revoked, and the URL answers only while something is still listening on that port.`
    };
  }
  if (name === 'browser_action') {
    if (SECURITY_MODE_FLOOR[securityMode].authorizesSurfaceActions) return null;
    const action = surfaceActionVerb(args);
    const purpose = textValue(args.purpose);
    const reason = statedReason(args.purpose);
    if (action === 'batch') {
      const steps = Array.isArray(args.actions) ? args.actions : [];
      let strongest: ApprovalRequirement | null = null;
      steps.forEach((step, index) => {
        const bag = (step && typeof step === 'object' ? step : {}) as Record<string, unknown>;
        const type = surfaceActionVerb(bag);
        if (!type || type === 'batch') return;
        const requirement = ordinaryRequirement(
          name,
          { ...bag, purpose: args.purpose },
          securityMode,
          {},
          now
        );
        if (!requirement) return;
        if (
          strongest &&
          APPROVAL_RANK[strongest.sideEffect] >= APPROVAL_RANK[requirement.sideEffect]
        )
          return;
        strongest = {
          ...requirement,
          preview: `Step ${index + 1} of ${steps.length} in this batch (${surfaceVerbName(bag) || 'unnamed'}):\n${requirement.preview}`
        };
      });
      if (strongest) return strongest;
    }
    if (action === 'upload') {
      const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
      return {
        sideEffect: 'external_consequential',
        action: surfaceHeadline(name, action),
        preview: `Send ${paths.join(', ') || 'workspace files'} to this website.\n${reason}`
      };
    }
    if (action === 'click_at') {
      return {
        sideEffect: 'external_consequential',
        action: surfaceHeadline(name, action),
        preview: `Coordinate clicks are ambiguous and always require confirmation.\n${reason}`
      };
    }
    if (action === 'press' && textValue(args.key).toLowerCase() === 'enter') {
      return {
        sideEffect: 'external_consequential',
        action: surfaceHeadline(name, action),
        preview: `Pressing Enter can submit the focused form.\n${reason}`
      };
    }
    if (action === 'dialog' && args.response === 'accept') {
      return {
        sideEffect: 'external_consequential',
        action: surfaceHeadline(name, action),
        preview: `${
          args.promptText
            ? 'The dialog requests private text, so the user must take over secure input.'
            : 'Accepting a page confirmation can trigger an external action.'
        }\n${reason}`
      };
    }
    if (
      (action === 'click' || action === 'double_click') &&
      consequentialText.test(`${textValue(args.selector)} ${purpose}`)
    ) {
      return {
        sideEffect: 'external_consequential',
        action: surfaceHeadline(name, action),
        preview: `Selector: ${textValue(args.selector, 'unknown')}\n${reason}`
      };
    }
  }
  if (name === 'desktop_action') {
    if (SECURITY_MODE_FLOOR[securityMode].authorizesSurfaceActions) return null;
    const action = surfaceActionVerb(args);
    const purpose = textValue(args.purpose);
    const reason = statedReason(args.purpose);
    if (action === 'click_at' || action === 'drag')
      return {
        sideEffect: 'external_consequential',
        action: surfaceHeadline(name, action),
        preview: `Coordinate clicks are ambiguous and always require confirmation.\n${reason}`
      };
    if (action === 'press' && textValue(args.key).toLowerCase() === 'enter')
      return {
        sideEffect: 'external_consequential',
        action: surfaceHeadline(name, action),
        preview: `Pressing Enter can submit the focused desktop control.\n${reason}`
      };
    if (action === 'invoke' && consequentialText.test(`${textValue(args.nodeId)} ${purpose}`))
      return {
        sideEffect: 'external_consequential',
        action: surfaceHeadline(name, action),
        preview: `Accessibility node: ${textValue(args.nodeId, 'unknown')}\n${reason}`
      };
  }
  if (name === 'connector_action') {
    const action = textValue(args.action);
    const definition = connectorActions[action as keyof typeof connectorActions];
    if (definition?.sideEffect === 'read') return null;
    if (definition?.sideEffect === 'delete' || definition?.sideEffect === 'write')
      return {
        sideEffect:
          definition.sideEffect === 'delete' ? 'external_consequential' : 'external_reversible',
        ...connectorApprovalCard(
          action,
          (args.input && typeof args.input === 'object' ? args.input : {}) as Record<
            string,
            unknown
          >
        )
      };
  }
  if (SECURITY_MODE_FLOOR[securityMode].asksBeforeEveryChange) {
    if (name === 'shell')
      return withTaskApproval(
        {
          sideEffect: 'workspace_write',
          action: 'Run a command on this computer',
          preview: `Run ${shellInvocation(args) || 'command'}`
        },
        name,
        args,
        'commands'
      );
    if (
      name === 'file_write' ||
      name === 'file_patch' ||
      name === 'print_pdf' ||
      (name === 'code_diagnostics' && args.action === 'apply')
    ) {
      const patched = namedObjects(writtenPaths(name, args));
      return withTaskApproval(
        {
          sideEffect: 'workspace_write',
          action: 'Change a workspace file',
          preview:
            name === 'code_diagnostics'
              ? `Apply the checked code preview to ${patched || 'the listed workspace files'}`
              : name === 'file_patch'
                ? `Apply ${Array.isArray(args.patches) ? args.patches.length : 0} conflict-checked file patch(es) to ${patched || 'a workspace file'}`
                : name === 'print_pdf'
                  ? `Print the current page to ${textValue(args.path, 'a workspace PDF')}`
                  : `Create or replace ${textValue(args.path, 'a workspace file')}`
        },
        name,
        args,
        'files'
      );
    }
    if (
      name === 'publish_artifact' ||
      publishReachOfCall(name, args) === 'private' ||
      name === 'desktop_launch'
    )
      return {
        sideEffect: 'workspace_write',
        action:
          name === 'desktop_launch'
            ? 'Launch a desktop application'
            : name === 'publish_preview'
              ? 'Create a private preview'
              : 'Publish a file to the chat',
        preview:
          name === 'desktop_launch'
            ? `Launch ${textValue(args.executable, 'an application')} on this computer`
            : `Use ${textValue(args.path, textValue(args.label, 'workspace output'))}`
      };
    if (name === 'browser_action' || name === 'desktop_action') {
      const verb = surfaceVerbName(args);
      if (
        !['focus', 'hover', 'scroll', 'reload', 'back', 'go_back', 'navigate'].includes(
          surfaceActionVerb(args)
        )
      )
        return {
          sideEffect: 'workspace_write',
          action: `Review ${name === 'browser_action' ? 'a browser' : 'a desktop'} action`,
          preview: `Review mode asks before each form or application change, and this one is ${verb || 'unnamed'}.\n${statedReason(args.purpose)}`
        };
    }
  }
  return null;
};
