/** Keep whole owner messages: cutting a quote's introduction can turn it into a false assertion. */
export const appendMemoryOwnerInput = (previous: string | undefined, next: string): string => {
  const limit = 64_000;
  if (next.length > limit) return '';
  const combined = previous ? `${previous}\n\n${next}` : next;
  return combined.length <= limit ? combined : next;
};
