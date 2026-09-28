import type { MediaModelOption } from '@garden/contracts';
export const mediaRouteIsRetired = (
  option: Pick<MediaModelOption, 'retirementAt'> | null | undefined,
  now = Date.now()
): boolean => Boolean(option?.retirementAt && Date.parse(option.retirementAt) <= now);
export const mediaRetirementDate = (value: string): string =>
  new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  });
/** A slow poll must not overwrite a newer owner action receipt. */
export const mergeMediaPoll = <T extends { id: string; updatedAt: string }>(
  previous: T[],
  incoming: T[]
): T[] => {
  const byId = new Map(previous.map((row) => [row.id, row]));
  return incoming.map((row) => {
    const old = byId.get(row.id);
    return old && Date.parse(old.updatedAt) > Date.parse(row.updatedAt) ? old : row;
  });
};
