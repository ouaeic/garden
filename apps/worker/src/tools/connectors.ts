import { executeProjectGitConnector } from '../project-git-connector.js';
import {
  connectorActions,
  isAccountConnectorKind,
  authorizeAccountConnector,
  secureConnectorRequest,
  decryptJson,
  encryptJson,
  executeConnectorAction,
  parseAccountConnectorAction,
  GardenError,
  type ConnectorSecret,
  type AccountOperation
} from '@garden/core';
import { withAccountOperation } from '../account-operation.js';
import { type ModelToolCall } from '@garden/model-gateway';
import { connectorHostAllowance, performConnectorAction } from '../connector-call.js';
import { asRecord, textValue } from '../values.js';
import { type ToolContext } from '../tool-dispatch.js';

/**
 * The connector tools: reaching a service the owner has connected on their behalf.
 *
 * The two arms are deliberately adjacent: the list is what the model is allowed to know about a
 * connection, and the action is what it is allowed to do with one, and the difference between those
 * two answers is the whole of the connector scope model.
 */
export async function executeConnectorTool(
  context: ToolContext,
  call: ModelToolCall
): Promise<unknown> {
  const { task } = context;
  switch (call.name) {
    case 'connector_list':
      return (await context.store.listConnectors(task.userId))
        .filter((connector) => connector.enabled)
        .map((connector) => ({
          id: connector.id,
          kind: connector.kind,
          label: connector.label,
          scopes: connector.scopes,
          lastUsedAt: connector.lastUsedAt
        }));
    case 'connector_action': {
      const connectorId = textValue(call.arguments.connectorId);
      const operation = textValue(call.arguments.action, 'unknown_connector_action');
      const connector = await context.store.getConnector(task.userId, connectorId);
      if (!connector || !connector.enabled)
        throw new GardenError('connector_not_found', 'Connected service is unavailable');
      if (connector.secretCiphertext.aad !== `connector:${task.userId}:${connector.id}`)
        throw new GardenError(
          'connector_secret_context',
          'Connector secret encryption context is invalid'
        );
      /*
       * An action this connector cannot run, answered with the ones it can, in the same result.
       *
       * `executeConnectorAction` already refuses this - "Action does not match this connector" -
       * and that sentence was enough while every action was in the enum, because a model that had
       * read all twenty-four could work out which connector it had aimed at the wrong one. It is
       * not enough now: `agentToolsFor` sends a box only the actions its own connections reach,
       * so a model asking for `github_read_file` on a mailbox is usually a model that has not
       * called `connector_list` yet, and a refusal naming no alternative costs it a whole further
       * round trip to find out what it may ask for instead. Naming them here costs nothing
       * resident and closes the retry in one call.
       *
       * Derived from `connectorActions` rather than listed, so a new action or a new kind is
       * covered the day it lands. It pre-empts only the kind mismatch and deliberately not the
       * scope denial below it: `connector_scope_denied` names the exact scope that is missing,
       * which is already the better sentence, and it is the one refusal the audit trail records
       * as `denied` rather than `failed`.
       */
      const definition = (
        connectorActions as Record<string, { kinds: readonly string[] } | undefined>
      )[operation];
      if (definition && !definition.kinds.includes(connector.kind))
        throw new GardenError(
          'connector_action_invalid',
          `${operation} is a ${definition.kinds.join('/')} action and ${connector.label} is a ${connector.kind} connection. On this one: ${Object.entries(
            connectorActions
          )
            .filter(([, entry]) => (entry.kinds as readonly string[]).includes(connector.kind))
            .map(([name]) => name)
            .join(', ')}. Call connector_list to see everything that is connected.`
        );
      const secret = isAccountConnectorKind(connector.kind)
        ? await context.store.withConnectorAuthorization(task.userId, connector.id, (current) =>
            authorizeAccountConnector(current, context.masterKey, secureConnectorRequest)
          )
        : decryptJson<ConnectorSecret>(connector.secretCiphertext, context.masterKey);
      const requested = asRecord(call.arguments.input) ?? {};
      try {
        return await performConnectorAction({
          connectorId: connector.id,
          kind: connector.kind,
          action: operation,
          requested,
          readFile: (path) => context.runner.readBytes(task.workspaceId, task.id, path),
          writeFile: (path, bytes) =>
            context.runner.writeBytes(task.workspaceId, task.id, path, bytes),
          execute: async (actionInput) => {
            const execute = (accountOperation?: AccountOperation) =>
              executeConnectorAction({
                ...(accountOperation ? { operation: accountOperation } : {}),
                projectGit: (action) =>
                  executeProjectGitConnector(context, call, connector.id, secret, action),
                kind: connector.kind,
                baseUrl: connector.baseUrl,
                scopes: connector.scopes,
                secret,
                action: actionInput,
                allowedHostSuffixes: connectorHostAllowance(
                  context.config.CONNECTOR_ALLOWED_HOST_SUFFIXES,
                  connector
                ),
                onSecretUpdated: async (updatedSecret) => {
                  const saved = await context.store.updateConnectorSecret(
                    task.userId,
                    connector.id,
                    encryptJson(
                      updatedSecret,
                      context.masterKey,
                      `connector:${task.userId}:${connector.id}`
                    )
                  );
                  if (!saved)
                    throw new GardenError(
                      'connector_secret_update_failed',
                      'The refreshed connector authorization could not be saved'
                    );
                }
              });
            const nativeWrite =
              isAccountConnectorKind(connector.kind) &&
              [
                'account_mail_draft',
                'account_mail_send',
                'account_calendar_create',
                'account_calendar_update',
                'account_calendar_delete'
              ].includes(operation);
            const executed = nativeWrite
              ? await withAccountOperation({
                  store: context.store,
                  key: context.key,
                  userId: task.userId,
                  connectorId: connector.id,
                  taskId: task.id,
                  turn: context.state.turn ?? 0,
                  action: operation,
                  parameters: parseAccountConnectorAction(actionInput),
                  execute
                })
              : await execute();
            await context.store.recordConnectorAudit({
              connectorId: connector.id,
              userId: task.userId,
              taskId: task.id,
              operation: executed.action,
              outcome: asRecord(executed.result)?.status === 'uncertain' ? 'failed' : 'succeeded',
              statusCode: executed.statusCode,
              requestBytes: executed.requestBytes,
              responseBytes: executed.responseBytes,
              durationMs: executed.durationMs
            });
            return executed.result;
          }
        });
      } catch (error) {
        await context.store.recordConnectorAudit({
          connectorId: connector.id,
          userId: task.userId,
          taskId: task.id,
          operation,
          outcome:
            error instanceof GardenError && error.code === 'connector_scope_denied'
              ? 'denied'
              : 'failed'
        });
        throw error;
      }
    }
    default:
      /*
       * Unreachable: the table in `tool-dispatch.ts` is what chooses this module, and it only
       * names the tools above. Kept so that a tool added to the table and forgotten here fails
       * loudly on the first call rather than returning `undefined` to the model.
       */
      throw new Error(`Unknown tool ${call.name}`);
  }
}
