import type { SubagentLane } from '@garden/contracts';
import type { DataStore, TaskRecord } from '@garden/data';
import { event } from './tool-recording.js';

/**
 * One delegated specialist on the owner's timeline, as it happens.
 *
 * A `delegate` call used to be exactly two rows - `tool_started` and, minutes later,
 * `tool_result` - so the answer to "where are the subagents?" was the whole time: running,
 * invisible. Every lane transition is its own `subagent` event carrying this lane's standing at
 * that moment, keyed on `laneId` so the timeline folds one lane's rows into one lane.
 *
 * A plain append rather than `replacesEarlierFrames`: the lane's history is the useful part -
 * a completed card that still shows the verification happened says more than one that does not.
 */
export const emitSubagentLane = (
  store: DataStore,
  task: TaskRecord,
  key: Uint8Array,
  lane: SubagentLane
): Promise<unknown> =>
  event(store, task, key, 'subagent', `${lane.name}: ${lane.status.replaceAll('_', ' ')}`, lane);
