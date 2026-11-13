import type { Ns } from './types.ts';

export const NS_PER_MS = 1_000_000n;
export const NS_PER_SECOND = 1_000_000_000n;
export const NS_PER_MINUTE = 60n * NS_PER_SECOND;
export const NS_PER_DAY = 86_400n * NS_PER_SECOND;

/** "2026-11-12T14:03:05.123Z" (UTC, milliseconds, truncated). */
export function isoFromNs(ns: Ns): string {
  return new Date(Number(ns / NS_PER_MS)).toISOString();
}

/** Epoch milliseconds (integer number) to Ns. */
export function nsFromMs(ms: number): Ns {
  return BigInt(ms) * NS_PER_MS;
}

/** Parses an ISO 8601 timestamp (as in transcripts); null when Date.parse fails. */
export function nsFromIso(iso: string): Ns | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : nsFromMs(ms);
}
