import {
  estimateSkillTokens,
  isBuiltinSkillName,
  scanSkillBodyForPaths,
  scanSkillBodyForSecrets,
  SKILL_BUDGET
} from './skills.js';
import { asRecord, textValue } from './values.js';
import type { ApprovalContext } from './approval-policy.js';

/*
 * The sentence and the preview the owner actually reads on a card.
 *
 * Separated from approval-policy.ts because the two answer different questions and fail
 * differently. The policy decides *whether* to stop the owner and how hard; this decides what they
 * see when it does. A wrong answer from the policy is a card that never appears; a wrong answer
 * from here is a card that appears and says the wrong thing, which is worse than useless because
 * it is what the owner weighs in the two seconds they give a notification.
 *
 * Nothing here reads the model's own prose for the heading of a card. Every line is written from
 * the arguments and from the harness's own record, because an agent following an injected
 * instruction writes its own approval card otherwise.
 *
 * The type import above is erased at compile time, so the pair approval-policy.ts <-> this file is
 * a cycle only in the type graph and never at runtime.
 */

/** The addresses on a card, from either shape the mailbox schema accepts. */
const addressLine = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((entry) =>
      typeof entry === 'string'
        ? entry
        : textValue((entry as Record<string, unknown> | null)?.address)
    )
    .filter(Boolean)
    .join(', ');
};

/**
 * What the owner is actually being asked to approve.
 *
 * A card reading "Delete through imap" over a JSON dump of the arguments would be neither the thing
 * being done nor anything a person can weigh in the two seconds they give a notification.
 * A message leaving the owner's own address is the one connector action they cannot take back, so
 * the card names the recipients and shows the message; everything else says what it changes and
 * where. Keyed on the action rather than on the connector, because the tier a connector action sits
 * in says how hard it is to undo, not what it is.
 */
export const connectorApprovalCard = (
  action: string,
  input: Record<string, unknown>
): { action: string; preview: string } => {
  const recipients = addressLine(input.to);
  const body = textValue(input.text).slice(0, 1_500);
  const attachments = Array.isArray(input.attachments)
    ? input.attachments.map((entry) => textValue(entry)).filter(Boolean)
    : [];
  const copies = [
    addressLine(input.cc) ? `Cc: ${addressLine(input.cc)}` : '',
    addressLine(input.bcc) ? `Bcc: ${addressLine(input.bcc)}` : '',
    attachments.length ? `Attached: ${attachments.join(', ')}` : ''
  ]
    .filter(Boolean)
    .join('\n');
  const mailbox = textValue(input.mailbox, 'INBOX');
  switch (action) {
    case 'github_git_push':
      return {
        action: `Publish Git history to ${textValue(input.owner)}/${textValue(input.repository)}`,
        preview: `Branch: ${textValue(input.branch)}\nPublished version: ${textValue(input.revisionId)}\nCommit: ${textValue(input.commit)}\nExpected remote head: ${input.expectedHead === null ? 'new branch' : textValue(input.expectedHead)}\nThe selected commit and its reachable history are sent to this repository. Existing remote history is preserved.`
      };
    case 'mail_send':
    case 'account_mail_send':
      return {
        action: `Send an email to ${recipients || 'the named recipients'}`,
        preview: `To: ${recipients || 'unknown'}\n${copies ? `${copies}\n` : ''}Subject: ${textValue(input.subject, '(no subject)')}\n\n${body}\n\nThis is sent from the connected mailbox, as the user, and cannot be recalled.`
      };
    case 'mail_reply':
      return {
        action: `Reply to message ${textValue(input.uid, '?')} in ${mailbox}`,
        preview: `${copies ? `${copies}\n` : ''}${body}\n\nIt goes to whoever sent the original${input.replyAll === true ? ' and to everyone it was addressed to' : ''}, from the connected mailbox, and cannot be recalled.`
      };
    case 'mail_draft':
    case 'account_mail_draft':
      return {
        action: `Save a draft to ${recipients || 'the named recipients'}`,
        preview: `To: ${recipients || 'unknown'}\n${copies ? `${copies}\n` : ''}Subject: ${textValue(input.subject, '(no subject)')}\n\n${body}\n\nSaved in ${textValue(input.mailbox, 'the Drafts mailbox')}. Nothing is sent.`
      };
    case 'mail_mark': {
      const count = Array.isArray(input.uids) ? input.uids.length : 0;
      const flags = [
        input.seen === undefined ? '' : input.seen ? 'read' : 'unread',
        input.flagged === undefined ? '' : input.flagged ? 'flagged' : 'unflagged'
      ]
        .filter(Boolean)
        .join(' and ');
      return {
        action: `Mark ${count} message${count === 1 ? '' : 's'} in ${mailbox}`,
        preview: `Mark ${count} message${count === 1 ? '' : 's'} in ${mailbox} as ${flags || 'changed'}.`
      };
    }
    case 'account_calendar_update':
    case 'account_calendar_delete': {
      const removing = action === 'account_calendar_delete';
      const changes = asRecord(input.changes) ?? {};
      const time = asRecord(changes.time);
      const excerpt = (value: string, limit: number) =>
        value.length > limit ? value.slice(0, limit) + '… (see full action)' : value;
      const attendees = Array.isArray(changes.attendees) ? changes.attendees : null;
      const fields = [
        typeof changes.summary === 'string' ? `Title: ${excerpt(changes.summary, 200)}` : '',
        typeof changes.description === 'string'
          ? `Description: ${excerpt(changes.description, 500) || '(clear)'}`
          : '',
        typeof changes.location === 'string'
          ? `Location: ${excerpt(changes.location, 200) || '(clear)'}`
          : '',
        time
          ? `Time: ${textValue(time.start)} to ${textValue(time.end)}${time.allDay ? ' (all day)' : ''}${textValue(time.timeZone) ? ' · ' + textValue(time.timeZone) : ''}`
          : '',
        attendees
          ? `Attendees: ${addressLine(attendees.slice(0, 5)) || '(remove all)'}${attendees.length > 5 ? ` and ${attendees.length - 5} more (see full action)` : ''}`
          : ''
      ]
        .filter(Boolean)
        .join('\n');
      return {
        action: `${removing ? 'Delete' : 'Edit'} ${input.target === 'series' ? 'the recurring series' : input.target === 'occurrence' ? 'one occurrence' : 'a calendar event'}`,
        preview: `Event: ${textValue(input.eventId)}\nCalendar: ${textValue(input.calendarId, 'primary')}\nVersion: ${textValue(input.expectedVersion)}${fields ? '\n' + fields : ''}\nAttendees may receive ${removing ? 'cancellation' : 'update'} notifications. A concurrent edit stops this change.`
      };
    }
    case 'account_calendar_create':
    case 'calendar_create_event':
      return {
        action: `Put "${textValue(input.summary, 'an event')}" in the calendar`,
        preview: `${textValue(input.summary, 'Untitled')}\n${textValue(input.start)} to ${textValue(input.end)}${input.allDay === true ? ' (all day)' : ''}${textValue(input.location) ? `\nAt: ${textValue(input.location)}` : ''}${addressLine(input.attendees) ? `\nWith: ${addressLine(input.attendees)}` : ''}`
      };
    case 'calendar_update_event':
      return {
        action: `Change an event in the calendar`,
        preview: `${textValue(input.eventUrl)}\n${[
          textValue(input.summary) ? `Title: ${textValue(input.summary)}` : '',
          textValue(input.start) ? `Starts: ${textValue(input.start)}` : '',
          textValue(input.end) ? `Ends: ${textValue(input.end)}` : '',
          textValue(input.location) ? `At: ${textValue(input.location)}` : ''
        ]
          .filter(Boolean)
          .join('\n')}\n\nAnyone else on the event sees this as a new version of it.`
      };
    case 'calendar_respond_invitation':
      return {
        action: `Answer an invitation: ${textValue(input.response, 'respond')}`,
        preview: `Record ${textValue(input.response, 'a response')} on ${textValue(input.eventUrl)}. Whether the organiser is told depends on the calendar server.`
      };
    case 'webdav_write':
      return {
        action: `Replace ${textValue(input.path, 'a file')} on the connected file service`,
        preview: `Write ${textValue(input.path, 'a file')}, replacing whatever is there now.`
      };
    case 'webdav_delete':
      return {
        action: `Delete ${textValue(input.path, 'a file')} from the connected file service`,
        preview: `Delete ${textValue(input.path, 'a file')}. It is gone from the service, not from this computer.`
      };
    case 'github_create_issue':
      return {
        action: `Open an issue on ${textValue(input.owner)}/${textValue(input.repository)}`,
        preview: `${textValue(input.title, '(no title)')}\n\n${textValue(input.body).slice(0, 1_500)}`
      };
    case 'github_create_pull_request':
      return {
        action: `Open a pull request on ${textValue(input.owner)}/${textValue(input.repository)}`,
        preview: `${textValue(input.title, '(no title)')}\n${textValue(input.head)} into ${textValue(input.base)}${input.draft === true ? ' (draft)' : ''}\n\n${textValue(input.body).slice(0, 1_500)}`
      };
    case 'mcp_call_tool':
      return {
        action: `Run ${textValue(input.tool, 'a tool')} on the connected MCP server`,
        preview: `The server decides what this does; garden cannot bound it. Arguments:\n${JSON.stringify(input.arguments ?? {}).slice(0, 1_500)}`
      };
    default:
      return {
        action: `Run ${action} on the connected service`,
        preview: `Run ${action} with ${JSON.stringify(input).slice(0, 1_500)}`
      };
  }
};

export const codingAgentName = (agent: unknown): string => {
  if (agent === 'codex') return 'OpenAI Codex CLI';
  if (agent === 'claude') return 'Anthropic Claude Code';
  if (agent === 'opencode') return 'OpenCode';
  return 'coding specialist';
};

export const skillUpsertAction = (
  name: string,
  existing?: ApprovalContext['existingSkill']
): string =>
  isBuiltinSkillName(name)
    ? `Review owner override of built-in skill ${name}`
    : existing
      ? `Review REPLACEMENT of saved skill ${name} (version ${existing.version})`
      : `Review reusable skill ${name}`;

/**
 * The review card is the durability gate, so the whole proposed body is shown. A body that would
 * not fit is reported as over budget instead of being silently truncated: a documented evasion
 * places instructions past the point where a reviewer stops reading.
 */
export const skillUpsertPreview = (
  name: string,
  description: string,
  content: string,
  existing?: ApprovalContext['existingSkill']
): string => {
  const notes: string[] = [];
  // First, because it changes what approving means. An upsert is a blind full-body overwrite: the
  // saved text is replaced outright, with no precondition on what it currently says. The card used
  // to read identically whether this was a new procedure or a rewrite of one the owner had written
  // and approved themselves.
  if (existing) {
    const saved = existing.updatedAt.slice(0, 10);
    notes.push(
      `This REPLACES the saved skill "${name}" (version ${existing.version}, last changed ${saved}, used ${existing.useCount} time${existing.useCount === 1 ? '' : 's'}). The current text is discarded and cannot be recovered.`
    );
    // The upsert forces enabled=TRUE, so approving this also undoes a deliberate act.
    if (!existing.enabled)
      notes.push(`You had turned "${name}" off. Approving this switches it back on.`);
  }
  if (isBuiltinSkillName(name))
    notes.push(
      `"${name}" is a built-in skill. Approving this keeps the built-in intact and shadows it for this workspace only.`
    );
  const lines = content ? content.split('\n').length : 0;
  const tokens = estimateSkillTokens(content);
  const overBudget = lines > SKILL_BUDGET.maxBodyLines || tokens > SKILL_BUDGET.maxBodyTokens;
  if (overBudget)
    notes.push(
      `This procedure is ${lines} lines / about ${tokens} tokens, over the ${SKILL_BUDGET.maxBodyLines}-line, ${SKILL_BUDGET.maxBodyTokens}-token review budget. Shorten it before approving.`
    );
  const secrets = scanSkillBodyForSecrets(content);
  if (secrets.length) notes.push(`It appears to contain ${secrets.join(', ')}.`);
  // A procedure is durable and the paths in it are not: an absolute path outside the workspace
  // names one run's machine state, so the skill works once and then quietly does the wrong thing.
  // The reviewer is the only place this can be caught, since nothing re-reads a saved skill.
  const paths = scanSkillBodyForPaths(content);
  if (paths.length)
    notes.push(
      `It hardcodes ${paths.join(', ')}, which is this run's machine state rather than anything durable.`
    );
  const body = overBudget
    ? content.split('\n').slice(0, SKILL_BUDGET.maxBodyLines).join('\n')
    : content;
  return `${notes.map((note) => `! ${note}`).join('\n')}${notes.length ? '\n\n' : ''}Name: ${name}\nDescription: ${description}\n\n${body}`;
};
