const NS_PER_SECOND = 1_000_000_000n;
const SECONDS_PER_MINUTE = 60n;
const SECONDS_PER_HOUR = 3600n;
const SECONDS_PER_DAY = 86_400n;

/**
 * Compact age of a duration in ns (negative counts as 0): < 60 s → "<n>s"; < 60 min → "<n>m";
 * < 48 h → "<n>h"; otherwise "<n>d". Always rounded down.
 */
export function formatAge(durationNs: bigint): string {
  const seconds = durationNs <= 0n ? 0n : durationNs / NS_PER_SECOND;
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds}s`;
  }
  if (seconds < SECONDS_PER_HOUR) {
    return `${seconds / SECONDS_PER_MINUTE}m`;
  }
  if (seconds < 48n * SECONDS_PER_HOUR) {
    return `${seconds / SECONDS_PER_HOUR}h`;
  }
  return `${seconds / SECONDS_PER_DAY}d`;
}
