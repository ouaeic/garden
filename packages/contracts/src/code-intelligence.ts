import { z } from 'zod';

export const CodeIntelligenceRequest = z
  .object({
    action: z.enum([
      'status',
      'start',
      'stop',
      'diagnostics',
      'definition',
      'references',
      'hover',
      'symbols',
      'implementation',
      'type_definition',
      'code_actions',
      'apply',
      'rename'
    ]),
    language: z.enum(['typescript', 'python', 'r']),
    root: z.string().max(4096).default('workspace'),
    path: z.string().max(4096).optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    newName: z.string().min(1).max(200).optional(),
    previewId: z.string().uuid().optional(),
    paths: z.array(z.string().max(4096)).min(1).max(32).optional()
  })
  .strict();
export type CodeIntelligenceRequest = z.infer<typeof CodeIntelligenceRequest>;
