/*
 * The address the tool layer's remaining callers import through.
 *
 * There is no code here. The catalogue is in ./tool-catalogue.js, the wording of an approval card
 * in ./approval-cards.js, the approval floor itself in ./approval-policy.js, and the classifiers in
 * ./surface-actions.js, ./command-classification.js and ./write-classification.js. What is left is
 * a re-export list, kept because agent.ts and four test files import through it.
 *
 * It is narrowed to exactly what has a caller: a re-export nobody reads is a second address for a
 * symbol, which is how two copies of an import list drift.
 *
 * This file can go entirely once agent.ts imports ./tool-catalogue.js, ./approval-policy.js,
 * ./surface-actions.js, ./command-classification.js and ./write-classification.js directly.
 */
export { agentTools, agentToolsFor } from './tool-catalogue.js';
export { approvalRequirement, type ApprovalContext } from './approval-policy.js';
export { surfaceActionRequest } from './surface-actions.js';
export {
  callDestinations,
  isQuarantinedDownloadPath,
  untrustedShellOrigin
} from './command-classification.js';
export {
  isMutatingToolCall,
  writesOnlyDurableInstructions,
  writesOnlyProse
} from './write-classification.js';
