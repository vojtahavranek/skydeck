/**
 * Follow-up F40 (design 7.1, S2 12.6): the offer to carry fields over after `/clear`, as the server
 * keeps it. The parts of an offer are the pure `carryOffer` of `view/carry-over.ts`; this module
 * gives it its lookups from the store (the new session's `clear` link, counted only when it is not
 * older than the mark of the server's first start with F40 less 5 s; the pull requests attached
 * by hand; the resume lock), computes `rev`, and makes the two acts, each in one transaction: the
 * copy and the done mark, and the dismissal. What it keeps in `kv` (S2 10.2):
 * `window_carry_over_since` (the mark, written once), `window_carry_over:<new session>` (the answer)
 * and `window_carry_over_ticks` (the last ticks).
 */
import { createHash } from 'node:crypto';

import { NS_PER_SECOND } from '../platform/time.ts';
import type { Ns } from '../platform/types.ts';
import type { Deck } from '../sessions/deck.ts';
import { cleanGroup, cleanLabel } from '../sessions/labels.ts';
import { isListed } from '../sessions/list.ts';
import type { ListRow } from '../sessions/list.ts';
import { loadRows } from '../sessions/load.ts';
import { carryFields, discardKeptNote, markDone } from '../sessions/meta.ts';
import type { CarriedFields } from '../sessions/meta.ts';
import { isLockHeld } from '../sessions/resume.ts';
import type { KvKey } from '../store/types.ts';
import { failureKind } from './auth.ts';
import type { CarryField, CarryOverPayload } from './protocol.ts';
import { CARRY_FIELDS, carryOffer, readTicks } from './view/carry-over.ts';
import type { CarryParts } from './view/carry-over.ts';

/** The mark: the server's clock at its first start with F40 on this store. */
export const SINCE_KEY = 'window_carry_over_since';
/** The ticks of the last carry over. */
export const TICKS_KEY = 'window_carry_over_ticks';
/** The answers' prefix, WITH its colon: it can never list the two keys above. */
export const ANSWER_PREFIX = 'window_carry_over:';
/** A `clear` link dated up to this much before the mark still counts (the wall clock's steps back
 *  on WSL, design 7.6, are under 2 s; a resume lock has the same grace). */
export const SINCE_GRACE_NS: Ns = 5n * NS_PER_SECOND;

export const ANSWERED = 'this offer was answered or dismissed already';
export const NOTHING_LEFT = 'there is nothing to carry over to this session any more';
export const CHANGED = 'the sessions changed since this offer was drawn; look at it again';
export const NOTHING_TICKED =
  'nothing is ticked: tick what to carry over, or close the offer with ×';
export const NO_OFFER_TO_DISMISS = 'there is no offer to dismiss for this session';

function answerKey(sessionId: string): KvKey {
  return `${ANSWER_PREFIX}${sessionId}`;
}

/** A usable mark: a canonical decimal number of nanoseconds; null for anything else. */
export function readSince(stored: string | null): bigint | null {
  return stored !== null && /^[1-9][0-9]{0,18}$/.test(stored) ? BigInt(stored) : null;
}

/** What the page sends with `carry-over` (protocol.ts checked its form). */
export interface CarryAct {
  sessionId: string;
  rev: string;
  fields: readonly CarryField[];
  done: boolean;
}

export interface CarryOver {
  /** The mark: written in one transaction when there is no usable one. Throws what the store throws. */
  begin(): void;
  /** `begin()` until a usable mark is known to be stored; never throws (a failure is logged). */
  tick(): void;
  /** The offer of the selected session, or null; never throws (a failure is logged, by kind). */
  offer(rows: readonly ListRow[], sessionId: string): CarryOverPayload | null;
  /** `act carry-over`; throws what the store throws (and cleanLabel's, cleanGroup's refusals). */
  carry(act: CarryAct): { ok: true } | { ok: false; error: string };
  /** `act dismiss-carry-over`; throws what the store throws. */
  dismiss(sessionId: string): { ok: true; changed: boolean } | { ok: false; error: string };
  /** Removes the answers of sessions that can no longer be shown; how many it removed. */
  sweep(rows: readonly ListRow[]): number;
}

type Computed =
  { kind: 'none' } | { kind: 'answered' } | { kind: 'offer'; parts: CarryParts; rev: string };

/** `rev`: the first 16 hex digits of the SHA-256 of what the offer was computed from (no ticks). */
function revOf(sessionId: string, parts: CarryParts): string {
  const basis = [
    sessionId,
    parts.fromId,
    parts.values,
    parts.payload.kept,
    parts.payload.done !== null,
  ];
  return createHash('sha256').update(JSON.stringify(basis)).digest('hex').slice(0, 16);
}

/** Logs a failure once per kind until `ok()` is called (a try that worked). */
function onceByKind(log: (line: string) => void, text: string) {
  const logged = new Set<string>();
  return {
    failed(error: unknown): void {
      const kind = failureKind(error);
      if (logged.has(kind)) return;
      logged.add(kind);
      log(`carry-over: ${text} (${kind})`);
    },
    ok(): void {
      logged.clear();
    },
  };
}

export function createCarryOver(deps: { deck: Deck; log: (line: string) => void }): CarryOver {
  const { deck, log } = deps;
  const { store } = deck;
  let markKnown = false;
  const markFailures = onceByKind(log, 'the first start was not recorded');
  const offerFailures = onceByKind(log, 'the offer was not read');

  /** The lookups of one computation: each store read made once, and only when it is needed. */
  function lookups() {
    let since: bigint | null | undefined;
    let manual: Set<string> | undefined;
    const cleared = new Map<string, string | null>();
    return {
      clearedFrom(id: string): string | null {
        const known = cleared.get(id);
        if (known !== undefined) return known;
        const latest = store
          .linksTo(id)
          .filter((link) => link.kind === 'clear')
          .at(-1);
        let from: string | null = null;
        if (latest !== undefined) {
          since ??= readSince(store.getKv(SINCE_KEY));
          if (since !== null && latest.timeNs >= since - SINCE_GRACE_NS) from = latest.fromSession;
        }
        cleared.set(id, from);
        return from;
      },
      byHand(id: string): boolean {
        manual ??= new Set(
          store
            .sessionPrs()
            .filter((link) => link.origin === 'manual' && link.detachedAtNs === null)
            .map((link) => link.sessionId),
        );
        return manual.has(id);
      },
      resuming(id: string): boolean {
        return isLockHeld(deck, id);
      },
    };
  }

  function compute(rows: readonly ListRow[], sessionId: string): Computed {
    const look = lookups();
    if (look.clearedFrom(sessionId) === null) return { kind: 'none' };
    if (store.getKv(answerKey(sessionId)) !== null) return { kind: 'answered' };
    const byId = new Map(rows.map((row) => [row.id, row]));
    const to = byId.get(sessionId);
    if (to === undefined) return { kind: 'none' };
    const parts = carryOffer({
      to,
      rowOf: (id) => byId.get(id),
      ...look,
      ticks: readTicks(store.getKv(TICKS_KEY)),
    });
    return parts === null
      ? { kind: 'none' }
      : { kind: 'offer', parts, rev: revOf(sessionId, parts) };
  }

  function begin(): void {
    store.transaction(() => {
      if (readSince(store.getKv(SINCE_KEY)) !== null) return;
      store.setKv(SINCE_KEY, String(deck.platform.clock.nowNs()));
    });
    markKnown = true;
  }

  function tick(): void {
    if (markKnown) return;
    try {
      begin();
      markFailures.ok();
    } catch (error) {
      markFailures.failed(error);
    }
  }

  function offer(rows: readonly ListRow[], sessionId: string): CarryOverPayload | null {
    try {
      const computed = compute(rows, sessionId);
      offerFailures.ok();
      return computed.kind === 'offer' ? { ...computed.parts.payload, rev: computed.rev } : null;
    } catch (error) {
      offerFailures.failed(error);
      return null;
    }
  }

  function carry(act: CarryAct): { ok: true } | { ok: false; error: string } {
    let noteCarried = false;
    const outcome = store.transaction((): { ok: true } | { ok: false; error: string } => {
      const computed = compute(loadRows(deck), act.sessionId);
      if (computed.kind === 'answered') return { ok: false, error: ANSWERED };
      if (computed.kind === 'none') return { ok: false, error: NOTHING_LEFT };
      if (computed.rev !== act.rev) return { ok: false, error: CHANGED };
      const { parts } = computed;
      const offered = new Set(parts.payload.fields.map((field) => field.name));
      const doneOffered = parts.payload.done !== null;
      if (act.fields.some((name) => !offered.has(name)) || (act.done && !doneOffered)) {
        return { ok: false, error: CHANGED };
      }
      if (act.fields.length === 0 && !act.done) return { ok: false, error: NOTHING_TICKED };
      const ticked = new Set(act.fields);
      const { values } = parts;
      const fields: CarriedFields = {};
      if (ticked.has('label') && values.label !== undefined)
        fields.label = cleanLabel(values.label);
      if (ticked.has('group') && values.group !== undefined)
        fields.group = cleanGroup(values.group);
      if (ticked.has('ticket') && values.ticket !== undefined) fields.ticket = values.ticket;
      if (ticked.has('note') && values.note !== undefined) fields.note = values.note;
      if (ticked.has('prs') && values.prs !== undefined) fields.prs = values.prs;
      carryFields(deck, act.sessionId, fields);
      if (act.done) markDone(deck, parts.fromId);
      store.setKv(answerKey(act.sessionId), 'carried');
      // The stored ticks with the offered checkboxes replaced by the act's.
      const ticks = readTicks(store.getKv(TICKS_KEY));
      for (const name of CARRY_FIELDS) {
        if (offered.has(name)) ticks[name] = ticked.has(name);
      }
      if (doneOffered) ticks.done = act.done;
      store.setKv(TICKS_KEY, JSON.stringify(ticks));
      noteCarried = fields.note !== undefined;
      return { ok: true };
    });
    if (outcome.ok && noteCarried) discardKeptNote(deck, act.sessionId);
    return outcome;
  }

  function dismiss(
    sessionId: string,
  ): { ok: true; changed: boolean } | { ok: false; error: string } {
    return store.transaction(() => {
      if (store.getKv(answerKey(sessionId)) !== null) return { ok: true, changed: false };
      if (lookups().clearedFrom(sessionId) === null)
        return { ok: false, error: NO_OFFER_TO_DISMISS };
      store.setKv(answerKey(sessionId), 'dismissed');
      return { ok: true, changed: true };
    });
  }

  function sweep(rows: readonly ListRow[]): number {
    const byId = new Map(rows.map((row) => [row.id, row]));
    return store.transaction(() => {
      let removed = 0;
      for (const { key } of store.kvEntries(ANSWER_PREFIX)) {
        const row = byId.get(key.slice(ANSWER_PREFIX.length));
        // A session without a row is left alone: rows that failed to load must not empty the table.
        if (row === undefined || row.state !== 'not-running' || isListed(row, true)) continue;
        store.deleteKv(key);
        removed++;
      }
      return removed;
    });
  }

  return { begin, tick, offer, carry, dismiss, sweep };
}
