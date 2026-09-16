import type { SecurityMode } from '@athanor/contracts';
// Copied across the client bundle boundary; scripts/check-repository.mjs checks the owning floor.
export const modeFloors: Record<SecurityMode, string> = {
  review:
    'Every command, every file written, and every browser or desktop action, on top of everything Balanced asks about.',
  balanced:
    'Asks before consequential browser or desktop actions, a command reaching the internet, and installing software; the built-in web tools read without asking. Other safeguards also apply.',
  autonomous:
    'Completes browser and desktop work, including uploads and submissions, without approval. CAPTCHA and private input need you. Other tools still ask about external changes, destructive operations, a durable instruction, schedule, service or tool configuration, and unverifiable network destinations.'
};
