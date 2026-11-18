/**
 * A list row for the tests of the interactive list and of the row formats: not running, titled
 * `t`, in no group, its time in state and its last activity both T0, with a transcript (a session
 * that is not running and has none is not listed). A test overrides what it cares about.
 */
import type { ListRow } from '../../src/sessions/list.ts';
import { ds } from './derived.ts';
import { T0 } from './platform.ts';

const SHORT_ID_LENGTH = 8;

export function listRow(over: Partial<ListRow> & { id: string }): ListRow {
  const group = over.group ?? null;
  const state = over.state ?? 'not-running';
  const sinceNs = over.sinceNs ?? T0;
  const lastActivityNs = over.lastActivityNs ?? T0;
  const marks = over.marks ?? [];
  const dir = over.dir === undefined ? '/home/dev/projects/demo' : over.dir;
  return {
    shortId: over.id.slice(0, SHORT_ID_LENGTH),
    title: 't',
    titleSource: 'generated',
    label: null,
    group,
    groupSource: group === null ? null : 'meta',
    state,
    stateDetail: null,
    sinceNs,
    lastActivityNs,
    dir,
    marks,
    hasNote: false,
    note: null,
    continuedFrom: null,
    done: false,
    prs: [],
    chip: null,
    ticket: null,
    session: ds({
      id: over.id,
      state,
      sinceNs,
      lastActivityNs,
      marks,
      dir,
      hidden: over.done ?? false,
    }),
    ...over,
  };
}
