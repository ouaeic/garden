import { z } from 'zod';
import { TaskOutputIntents } from './output-intent.js';
import { WorkSurfaceView } from './work-surface.js';

export const TaskResult = z.object({
  id: z.string(),
  kind: z.enum(['preview', 'artifact', 'file']),
  title: z.string(),
  status: z.enum(['ready', 'unavailable', 'unknown']),
  url: z.string().nullable(),
  downloadUrl: z.string().nullable(),
  /** POST here when the owner views this result to obtain a private preview URL. */
  accessPath: z.string().nullable(),
  /** Owner action: restore this app through its conversation's execution policy. */
  startPath: z.string().optional(),
  startState: z.enum(['starting', 'attention']).optional(),
  previewId: z.string().optional(),
  artifactId: z.string().optional(),
  workspaceId: z.string().optional(),
  sha256: z.string().optional(),
  createdAt: z.string().optional(),
  path: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  version: z.number().int().positive().optional(),
  detail: z.string().optional(),
  evidenceEventIds: z.array(z.string())
});
export type TaskResult = z.infer<typeof TaskResult>;

export const TaskMilestone = z.object({
  id: z.string(),
  sequence: z.number().int().nonnegative(),
  kind: z.enum(['change', 'source', 'check', 'result', 'approval', 'process', 'checkpoint']),
  title: z.string(),
  detail: z.string().optional(),
  status: z.enum(['observed', 'passed', 'failed', 'waiting']),
  createdAt: z.string()
});
export type TaskMilestone = z.infer<typeof TaskMilestone>;

/** A projection of recorded work. Counts never imply a percentage of the owner's objective. */
/** One milestone as the owner reads it: what it is, where it got to, and how long it took. */
export const TaskPhase = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed', 'skipped']),
  /** When this step last became the running one; absent for a step never started. */
  startedAt: z.string().optional(),
  /** When this step reached a closed state; with startedAt, its wall-clock duration. */
  completedAt: z.string().optional(),
  /** Sub-milestones done and total, from the plan's substeps; absent when there are none. */
  countDone: z.number().int().nonnegative().optional(),
  countTotal: z.number().int().nonnegative().optional(),
  /**
   * What happened while this step was the running one, in one line, for the hover.
   *
   * Derived from the activity already recorded rather than written by the model: the events between
   * a step starting and closing are exactly what it did, so this costs no tokens, cannot be
   * forgotten, and is available for every run that has already finished. A step that ran while
   * nothing was recorded has no line, which is the honest answer rather than an invented one.
   */
  detail: z.string().optional(),
  /** The step's own sub-milestones, one level deep, for the expandable view. */
  substeps: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        status: z.enum(['pending', 'in_progress', 'completed', 'skipped']),
        startedAt: z.string().optional(),
        completedAt: z.string().optional(),
        /** The same one-line account as its parent's, over the part's own window. */
        detail: z.string().optional()
      })
    )
    .optional()
});
export type TaskPhase = z.infer<typeof TaskPhase>;

export const TaskPresentation = z.object({
  version: z.literal(1),
  taskId: z.string(),
  /** The task's own status at projection time, so a partial completion can be labelled honestly. */
  taskStatus: z.string().optional(),
  eventCursor: z.number().int().nonnegative(),
  results: z.array(TaskResult),
  surface: WorkSurfaceView.optional(),
  outputs: TaskOutputIntents.optional(),
  delivery: z
    .object({
      status: z.enum(['pending', 'ready', 'incomplete']),
      pendingJobs: z.number().int().nonnegative(),
      failedJobs: z.number().int().nonnegative(),
      completedJobs: z.number().int().nonnegative()
    })
    .optional(),
  sourceBundle: z
    .object({
      downloadUrl: z.string(),
      fileCount: z.number().int().positive().nullable(),
      scope: z.enum(['recorded_files', 'declared_directories']),
      directories: z.array(z.string()).optional()
    })
    .optional(),
  coverage: z
    .object({
      scope: z.enum(['complete', 'recent']),
      eventCount: z.number().int().nonnegative(),
      omittedPayloads: z.number().int().nonnegative(),
      resultLimitReached: z.boolean().optional()
    })
    .optional(),
  /*
   * What the run itself said when it stopped, for the owner who was not watching.
   *
   * Every one of these fields was already recorded - `finish` declares a summary, its deliverables
   * and its verification, and the `completed` event carries the lot - and none of it was ever
   * presented as an ending. The owner got a status line reading Complete and a timeline they had
   * to read backwards to find out what had been produced or what was still wrong.
   *
   * Absent while the run is going, and absent on a run that ended without a finish - a crash or a
   * cancellation has no account of itself to give, and inventing one here would be garden putting
   * words in the model's mouth.
   */
  outcome: z
    .object({
      summary: z.string(),
      at: z.string(),
      /*
       * No list of deliverables here, deliberately.
       *
       * `finish` declares them and they are the model's own unverified strings - a run that has
       * read a hostile page can declare any address it likes, and a card that printed them would
       * be garden vouching for a link it never resolved. `results` above is the answer to "what
       * can I open": every entry there is a preview, artifact or file this box actually holds, and
       * the presentation's own test asserts a declared address never reaches the owner.
       */
      /**
       * `verified` means the harness ran the acceptance checks the run declared and they passed.
       * `not_applicable` is the conversational answer that had nothing external to check. The two
       * are never collapsed, because "checked" and "nothing to check" are different promises.
       */
      verification: z.enum(['verified', 'not_applicable', 'unverified']),
      evidence: z.number().int().nonnegative().default(0),
      /** What the run says is still wrong. Shown even when the status line says Complete. */
      remainingRisks: z.array(z.string()).default([]),
      /** Plan steps left open at the finish, so the count and the status line cannot disagree. */
      openSteps: z.number().int().nonnegative().default(0)
    })
    .optional(),
  progress: z.object({
    kind: z.enum(['general', 'build', 'research', 'analysis', 'design']),
    phases: z.array(TaskPhase),
    /*
     * The milestone lists of the directions before this one, oldest first.
     *
     * A direction opens a new plan, and until the model writes one `phases` is empty - so sending a
     * follow-up wiped the list the owner had been reading, and everything the run had already
     * achieved went with it. Nothing was lost from the record; it simply stopped being shown. These
     * are those earlier lists, kept so the trajectory of a long project reads as one thing rather
     * than as whatever is happening this minute.
     */
    history: z
      .array(
        z.object({
          directionEventId: z.string().nullable(),
          startedAt: z.string(),
          phases: z.array(TaskPhase)
        })
      )
      .default([]),
    current: z.object({ title: z.string(), eventId: z.string(), startedAt: z.string() }).nullable(),
    metrics: z.array(
      z.object({ key: z.string(), label: z.string(), value: z.number().nonnegative() })
    ),
    milestones: z.array(TaskMilestone),
    updatedAt: z.string().nullable()
  })
});
export type TaskPresentation = z.infer<typeof TaskPresentation>;

export { deliveryFilePath } from './delivery-path.js';
