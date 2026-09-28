import type { ReactNode } from 'react';
import type {
  Task,
  Workspace,
  Project,
  ConversationSource,
  DirectionContext
} from '@garden/contracts';
import type { Bootstrap, Draft } from './model';

export interface ComposerProps {
  workspace: Workspace;
  project?: Project;
  execution?: 'independent' | 'shared';
  source?: ConversationSource;
  task?: Task | null;
  bootstrap: Bootstrap;
  initialDraft?: Draft;
  context?: DirectionContext | null;
  onEditingChange?: (locked: boolean) => void;
  onContextChange?: (context: DirectionContext | null) => void;
  /** Contextual actions alongside attachments and dictation. */
  toolbarExtra?: ReactNode;
  onSent: (task: Task) => void;
  onDraft: (draft: Draft) => void;
}
