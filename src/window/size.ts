/**
 * The size of a terminal shared by several pages (S2 8.2.6), pure. A terminal has one size, the
 * pty's; every attached page proposes one (`attach`, `resize`) and the size owner's proposal is
 * the one that applies.
 *
 * - The owner is the page that last sent input; before any input, the first page that attached. A
 *   page that attaches to a terminal without an owner becomes it.
 * - When a page becomes the owner, its remembered proposal applies at once; afterwards each resize
 *   of the owner applies, and those of other pages are only remembered.
 * - When the owner detaches, ownership passes to the attached page that sent input last, else the
 *   one that attached last, and its proposal applies; with no page attached the size stays.
 *
 * `at` orders events (pages passes a counter that only goes up): "last" above means the highest
 * `at`. A page is any string the caller uses to tell pages apart.
 */

/** What a page proposed, and when it attached and last sent input (`at` values). */
interface Proposal {
  cols: number;
  rows: number;
  attachedAt: number;
  inputAt: number | null;
}

export interface SizeState {
  owner: string | null;
  proposals: ReadonlyMap<string, Proposal>;
}

type Size = { cols: number; rows: number };

function sizeOf(proposal: Proposal): Size {
  return { cols: proposal.cols, rows: proposal.rows };
}

/** The size an attach or resize carries; RangeError without one. */
function proposed(event: { kind: string; cols?: number; rows?: number }): Size {
  if (event.cols === undefined || event.rows === undefined) {
    throw new RangeError(`a ${event.kind} carries cols and rows`);
  }
  return { cols: event.cols, rows: event.rows };
}

/** The page that takes over from an owner that left: input last, else attached last. */
function successor(proposals: ReadonlyMap<string, Proposal>): string | null {
  let best: { page: string; proposal: Proposal } | null = null;
  for (const [page, proposal] of proposals) {
    if (best === null || ranksAbove(proposal, best.proposal)) {
      best = { page, proposal };
    }
  }
  return best?.page ?? null;
}

function ranksAbove(a: Proposal, b: Proposal): boolean {
  if (a.inputAt !== null || b.inputAt !== null) {
    return (a.inputAt ?? -Infinity) > (b.inputAt ?? -Infinity);
  }
  return a.attachedAt > b.attachedAt;
}

/**
 * The state after `event`, and the size to apply (send to the keeper) or null. The state given is
 * never changed. A resize, input or detach of a page that is not attached changes nothing. An
 * attach of a page already attached replaces its proposal and attach time and keeps its input
 * time. RangeError for an attach or resize without cols and rows (the caller's mistake; ruled).
 */
export function sizeAfter(
  state: SizeState,
  event: {
    kind: 'attach' | 'resize' | 'input' | 'detach';
    page: string;
    cols?: number;
    rows?: number;
    at: number;
  },
): { state: SizeState; apply: { cols: number; rows: number } | null } {
  const { page } = event;
  const current = state.proposals.get(page);
  const proposals = new Map(state.proposals);
  switch (event.kind) {
    case 'attach': {
      const size = proposed(event);
      const proposal = { ...size, attachedAt: event.at, inputAt: current?.inputAt ?? null };
      proposals.set(page, proposal);
      const owner = state.owner ?? page;
      return { state: { owner, proposals }, apply: owner === page ? size : null };
    }
    case 'resize': {
      const size = proposed(event);
      if (current === undefined) {
        return { state, apply: null };
      }
      proposals.set(page, { ...current, ...size });
      return {
        state: { owner: state.owner, proposals },
        apply: state.owner === page ? size : null,
      };
    }
    case 'input': {
      if (current === undefined) {
        return { state, apply: null };
      }
      proposals.set(page, { ...current, inputAt: event.at });
      const becomes = state.owner !== page;
      return { state: { owner: page, proposals }, apply: becomes ? sizeOf(current) : null };
    }
    case 'detach': {
      if (current === undefined) {
        return { state, apply: null };
      }
      proposals.delete(page);
      if (state.owner !== page) {
        return { state: { owner: state.owner, proposals }, apply: null };
      }
      const owner = successor(proposals);
      const next = owner === null ? undefined : proposals.get(owner);
      return { state: { owner, proposals }, apply: next === undefined ? null : sizeOf(next) };
    }
  }
}
