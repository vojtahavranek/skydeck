/**
 * S2 13's "when", judged on the server (stage B's plan, B12): a session starts to need you when it
 * needs you now and did not at the last judgement; each one that starts gets one `notify`, which
 * `Pages.notify` gives to the page that had focus last while no page has it. A session whose reason
 * changes does not start to need you. The first judgement records and sends nothing, so that a
 * restart does not notify everything that already needed you; it is the first check made once a
 * refresh has worked and the marks have been read (`ready`, which is `Attention.ready`), not simply
 * the first call: a start whose first refresh fails must not notify all of it at the next one.
 */
import type { AttentionPayload, NotifyMessage } from './protocol.ts';
import { startsToNeed } from './view/attention.ts';

export interface NotifierDeps {
  /** The sessions that need you now, with their title: those a page without a filter lists. */
  needs: () => ReadonlyMap<string, { title: string; attention: AttentionPayload }>;
  /** Attention.ready: until it is true, check() judges nothing. */
  ready: () => boolean;
  /** Pages.notify; whether a page got it. */
  send: (message: NotifyMessage) => boolean;
}

/**
 * check(): one judgement. The first check made while ready() is true records and sends nothing
 * (B12); a check before it does nothing at all, not even ask needs(). A `notify` that no page took
 * is not sent again: the session started to need you once. It catches nothing: what its deps throw
 * reaches the caller, whose wrapper logs it by kind.
 */
export function createNotifier(deps: NotifierDeps): { check(): void } {
  /** The last judgement; null until the first one. */
  let last: ReadonlyMap<string, unknown> | null = null;
  return {
    check() {
      if (!deps.ready()) return;
      const now = deps.needs();
      const before = last;
      last = now;
      if (before === null) return;
      for (const sessionId of startsToNeed(before, now)) {
        const need = now.get(sessionId);
        if (need === undefined) continue; // startsToNeed gives keys of `now` only
        const { title, attention } = need;
        deps.send({
          t: 'notify',
          sessionId,
          title,
          reason: attention.reason,
          detail: attention.detail,
        });
      }
    },
  };
}
