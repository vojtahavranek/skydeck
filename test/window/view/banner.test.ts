// S2 12.7, plan C9: the restore banner, the view model's pure function over the restore plan of
// the tick's rows, the stored dismissal and whether a restore runs.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ListRow } from '../../../src/sessions/list.ts';
import { refresh } from '../../../src/sessions/refresh.ts';
import { restorePlan } from '../../../src/sessions/restore.ts';
import type { RestoreEntry, RestorePlan } from '../../../src/sessions/restore.ts';
import { parsePageMessage } from '../../../src/window/protocol.ts';
import { bannerPayload } from '../../../src/window/view/banner.ts';
import { ds, meta, rowOf } from '../../helpers/derived.ts';
import { BOOT_A, BOOT_B, SEC, T0 } from '../../helpers/platform.ts';
import { BOOT_C, HOUR, MINUTE, addSession, restoreDeck, sid } from '../../helpers/restore.ts';

/** A row of session `n` titled by its label. */
function row(n: number, label = `session ${n}`): ListRow {
  return rowOf(ds({ id: sid(n) }), { metas: [meta(sid(n), { label })] });
}

function entry(n: number, over: Partial<Omit<RestoreEntry, 'row'>> & { row?: ListRow } = {}) {
  return {
    row: row(n),
    bootId: BOOT_A,
    endedAtNs: null,
    wasWorking: false,
    preselected: true,
    ...over,
  } satisfies RestoreEntry;
}

/** A plan of `entries` whose earlier boot is BOOT_A, its last event at T0. */
function planOf(entries: RestoreEntry[], bootId = BOOT_A): RestorePlan {
  return { entries, earlier: { bootId, lastEventNs: T0 } };
}

const QUIET = { dismissedBootId: null, running: false };

test('no plan, or a plan with no entries, while no restore runs: no banner', () => {
  assert.equal(bannerPayload({ plan: null, ...QUIET }), null);
  assert.equal(bannerPayload({ plan: planOf([]), ...QUIET }), null);
  assert.equal(bannerPayload({ plan: { entries: [], earlier: null }, ...QUIET }), null);
});

test('the entries in the order of the plan, each with its short id, title, end, work and preselection', () => {
  const plan = planOf([
    entry(3, { endedAtNs: T0 - 30n * SEC, wasWorking: true }),
    entry(1),
    entry(2, { endedAtNs: T0 - 10n * MINUTE, preselected: false }),
  ]);
  assert.deepEqual(bannerPayload({ plan, ...QUIET }), {
    bootId: BOOT_A,
    lastActivityNs: String(T0),
    entries: [
      {
        sessionId: sid(3),
        shortId: '00000003',
        title: 'session 3',
        endedAtNs: String(T0 - 30n * SEC),
        wasWorking: true,
        preselected: true,
      },
      {
        sessionId: sid(1),
        shortId: '00000001',
        title: 'session 1',
        endedAtNs: null,
        wasWorking: false,
        preselected: true,
      },
      {
        sessionId: sid(2),
        shortId: '00000002',
        title: 'session 2',
        endedAtNs: String(T0 - 10n * MINUTE),
        wasWorking: false,
        preselected: false,
      },
    ],
    shown: true,
    running: false,
  });
});

test('"Not now" for this boot: shown false (the switcher still finds the offer); for another boot: shown', () => {
  const plan = planOf([entry(1)]);
  const dismissed = bannerPayload({ plan, dismissedBootId: BOOT_A, running: false });
  assert.equal(dismissed?.shown, false);
  assert.equal(dismissed?.bootId, BOOT_A);
  assert.equal(dismissed?.entries.length, 1);
  assert.equal(bannerPayload({ plan, dismissedBootId: BOOT_C, running: false })?.shown, true);
  // What kv holds is any text: only the same boot id hides the banner.
  assert.equal(
    bannerPayload({ plan, dismissedBootId: BOOT_A.toUpperCase(), running: false })?.shown,
    true,
  );
});

test('a restore that runs with nothing left to offer: the running banner without a boot', () => {
  const running = { bootId: null, lastActivityNs: null, entries: [], shown: true, running: true };
  assert.deepEqual(
    bannerPayload({ plan: planOf([]), dismissedBootId: null, running: true }),
    running,
  );
  assert.deepEqual(
    bannerPayload({ plan: { entries: [], earlier: null }, dismissedBootId: BOOT_A, running: true }),
    running,
  );
  // No plan (the rows' boot id could not be read): nothing is offered, the run is still said.
  assert.deepEqual(bannerPayload({ plan: null, dismissedBootId: null, running: true }), running);
});

test('a restore that runs while sessions are still offered: the offer with running true', () => {
  const payload = bannerPayload({ plan: planOf([entry(1)]), dismissedBootId: null, running: true });
  assert.equal(payload?.running, true);
  assert.equal(payload?.bootId, BOOT_A);
  assert.deepEqual(
    payload?.entries.map((e) => e.sessionId),
    [sid(1)],
  );
  const dismissed = bannerPayload({
    plan: planOf([entry(1)]),
    dismissedBootId: BOOT_A,
    running: true,
  });
  assert.deepEqual([dismissed?.shown, dismissed?.running], [false, true]);
});

test('each session is offered once, at its first place (the switcher counts the entries)', () => {
  const plan = planOf([entry(2), entry(1), entry(2, { preselected: false }), entry(1)]);
  const payload = bannerPayload({ plan, ...QUIET });
  assert.deepEqual(
    payload?.entries.map((e) => [e.sessionId, e.preselected]),
    [
      [sid(2), true],
      [sid(1), true],
    ],
  );
});

test('an earlier boot whose id is not a lower-case UUID is offered nothing: dismiss-restore could not name it', () => {
  for (const bootId of [
    BOOT_A.toUpperCase(),
    'boot-1',
    '',
    ` ${BOOT_A}`,
    `${BOOT_A}\n`,
    BOOT_A.replaceAll('-', ''),
  ]) {
    const plan = planOf([entry(1, { bootId })], bootId);
    assert.equal(bannerPayload({ plan, ...QUIET }), null, JSON.stringify(bootId));
    assert.deepEqual(
      bannerPayload({ plan, dismissedBootId: null, running: true }),
      { bootId: null, lastActivityNs: null, entries: [], shown: true, running: true },
      JSON.stringify(bootId),
    );
  }
});

test('an offer is made for exactly the boot ids that dismiss-restore takes', () => {
  for (const bootId of [
    BOOT_A,
    BOOT_C,
    '00000000-0000-0000-0000-000000000000',
    BOOT_A.toUpperCase(),
    BOOT_A.slice(1),
    `${BOOT_A}0`,
    BOOT_A.replace('-', '_'),
    BOOT_A.replace(/^./, 'g'),
    `{${BOOT_A}}`,
    'boot',
  ]) {
    const takes = parsePageMessage(
      JSON.stringify({ t: 'act', id: 1, kind: 'dismiss-restore', bootId }),
    ).ok;
    const offered = bannerPayload({ plan: planOf([entry(1, { bootId })], bootId), ...QUIET });
    assert.equal(offered !== null, takes, bootId);
  }
});

test('only the earlier boot’s sessions are offered: the default set, whatever else a plan holds', () => {
  const plan = planOf([entry(1), entry(2, { bootId: BOOT_C }), entry(3, { bootId: BOOT_B })]);
  assert.deepEqual(
    bannerPayload({ plan, ...QUIET })?.entries.map((e) => e.sessionId),
    [sid(1)],
  );
  assert.equal(bannerPayload({ plan: planOf([entry(2, { bootId: BOOT_C })]), ...QUIET }), null);
});

test('every text of the banner is sanitised as the list’s texts are', () => {
  const hostile = {
    ...row(1),
    title: '\u001b]0;owned\u0007red \u001b[31mtext\u001b[0m\u202e\tend\u009b2J',
  };
  const payload = bannerPayload({ plan: planOf([entry(1, { row: hostile })]), ...QUIET });
  assert.equal(payload?.entries[0]?.title, 'red text end');
  for (const text of Object.values(payload?.entries[0] ?? {})) {
    assert.doesNotMatch(String(text), /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  }
});

test('the banner offers what restorePlan gives for a machine after a restart', (t) => {
  const d = restoreDeck(t);
  addSession(d, sid(1), { boot: BOOT_A, pid: 101, startNs: T0 - HOUR });
  addSession(d, sid(2), {
    boot: BOOT_A,
    pid: 102,
    startNs: T0 - HOUR,
    end: { detail: 'other', atNs: T0 - 10n * MINUTE },
  });
  addSession(d, sid(3), { boot: BOOT_C, pid: 103, startNs: T0 - 2n * HOUR });
  refresh(d.deck);
  const plan = restorePlan(d.deck, false);
  const payload = bannerPayload({ plan, ...QUIET });
  assert.equal(payload?.bootId, BOOT_A);
  // BOOT_A's last event: the end of sid(2).
  assert.equal(payload?.lastActivityNs, String(T0 - 10n * MINUTE));
  assert.deepEqual(
    payload?.entries.map((e) => [e.sessionId, e.endedAtNs, e.preselected]),
    plan.entries.map((e) => [
      e.row.id,
      e.endedAtNs === null ? null : String(e.endedAtNs),
      e.preselected,
    ]),
  );
  assert.deepEqual(payload?.entries.map((e) => e.sessionId).sort(), [sid(1), sid(2)]);
});
