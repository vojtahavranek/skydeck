// The banner's texts (S2 12.7; plan C task 75, C18): web/banner-text.js, pure. Every case passes
// its time zone as the parameter — UTC, and Europe/Prague, which is UTC+1 in winter and UTC+2 in
// summer — so that no case depends on the machine's zone (CI is UTC, the user's WSL is not).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { activityTime, bannerHeading, entryText, restoreLabel } from '../../web/banner-text.js';

/** Nanoseconds of the protocol (a decimal string) for a UTC time. */
function ns(iso: string): string {
  const ms = Date.parse(iso);
  assert.ok(Number.isFinite(ms), iso);
  return String(BigInt(ms) * 1_000_000n);
}

/** Milliseconds of a UTC time: a page's `now`. */
function ms(iso: string): number {
  return Date.parse(iso);
}

const PRAGUE = 'Europe/Prague';
/** 2026-11-15 12:00 UTC, 13:00 in Prague (CET). */
const NOW = ms('2026-11-15T12:00:00Z');
/** 2026-01-01 00:30 UTC, 01:30 in Prague: right after a new year in both. */
const NEW_YEAR = ms('2026-01-01T00:30:00Z');

describe('activityTime (C18)', () => {
  const cases: ReadonlyArray<
    readonly [name: string, at: string, zone: string, now: number, expected: string]
  > = [
    // UTC
    ['UTC today at 00:05', '2026-11-15T00:05:00Z', 'UTC', NOW, 'today at 00:05'],
    ['UTC today, a minute ago', '2026-11-15T11:59:00Z', 'UTC', NOW, 'today at 11:59'],
    ['UTC yesterday at 23:59', '2026-11-14T23:59:59Z', 'UTC', NOW, 'yesterday at 23:59'],
    ['UTC yesterday at 00:05', '2026-11-14T00:05:00Z', 'UTC', NOW, 'yesterday at 00:05'],
    ['UTC the day before yesterday', '2026-11-13T23:59:00Z', 'UTC', NOW, 'on 13 Nov at 23:59'],
    ['UTC earlier this year', '2026-03-12T18:02:00Z', 'UTC', NOW, 'on 12 Mar at 18:02'],
    ['UTC another year', '2025-11-12T18:02:00Z', 'UTC', NOW, 'on 12 Nov 2025 at 18:02'],
    ['UTC another year at 00:05', '2024-01-02T00:05:00Z', 'UTC', NOW, 'on 2 Jan 2024 at 00:05'],
    [
      'UTC yesterday across a new year',
      '2025-12-31T23:59:00Z',
      'UTC',
      NEW_YEAR,
      'yesterday at 23:59',
    ],
    [
      'UTC two days back across a new year',
      '2025-12-30T23:30:00Z',
      'UTC',
      NEW_YEAR,
      'on 30 Dec 2025 at 23:30',
    ],
    // Europe/Prague: the same instants fall on other days and hours there.
    [
      'Prague today at 00:05 (23:05 UTC the day before)',
      '2026-11-14T23:05:00Z',
      PRAGUE,
      NOW,
      'today at 00:05',
    ],
    ['Prague yesterday at 23:59', '2026-11-14T22:59:00Z', PRAGUE, NOW, 'yesterday at 23:59'],
    ['Prague yesterday at 00:05', '2026-11-13T23:05:00Z', PRAGUE, NOW, 'yesterday at 00:05'],
    ['Prague earlier this year (CET)', '2026-03-12T17:02:00Z', PRAGUE, NOW, 'on 12 Mar at 18:02'],
    ['Prague earlier this year (CEST)', '2026-07-01T16:02:00Z', PRAGUE, NOW, 'on 1 Jul at 18:02'],
    ['Prague another year', '2025-11-12T17:02:00Z', PRAGUE, NOW, 'on 12 Nov 2025 at 18:02'],
    [
      'Prague yesterday at 23:59 across a new year',
      '2025-12-31T22:59:00Z',
      PRAGUE,
      NEW_YEAR,
      'yesterday at 23:59',
    ],
    [
      'Prague yesterday where UTC says another year',
      '2025-12-30T23:30:00Z',
      PRAGUE,
      NEW_YEAR,
      'yesterday at 00:30',
    ],
    [
      'Prague today where UTC says yesterday',
      '2025-12-31T23:59:00Z',
      PRAGUE,
      NEW_YEAR,
      'today at 00:59',
    ],
  ];
  for (const [name, at, zone, now, expected] of cases) {
    test(`${name} → ${expected}`, () => {
      assert.equal(activityTime(ns(at), now, zone), expected);
    });
  }

  // Each kind of time at 00:05 and at 23:59, in both zones (review 1): `now` late on 15 Nov 2026
  // in each zone, so that both ends of today lie before it. Prague is UTC+1 on these dates but
  // 1 Jul (UTC+2).
  const LATE_UTC = ms('2026-11-15T23:59:30Z');
  const LATE_PRAGUE = ms('2026-11-15T22:59:30Z'); // 23:59:30 in Prague
  const matrix: ReadonlyArray<readonly [at: string, zone: string, now: number, expected: string]> =
    [
      ['2026-11-15T00:05:00Z', 'UTC', LATE_UTC, 'today at 00:05'],
      ['2026-11-15T23:59:00Z', 'UTC', LATE_UTC, 'today at 23:59'],
      ['2026-11-14T00:05:00Z', 'UTC', LATE_UTC, 'yesterday at 00:05'],
      ['2026-11-14T23:59:00Z', 'UTC', LATE_UTC, 'yesterday at 23:59'],
      ['2026-03-12T00:05:00Z', 'UTC', LATE_UTC, 'on 12 Mar at 00:05'],
      ['2026-03-12T23:59:00Z', 'UTC', LATE_UTC, 'on 12 Mar at 23:59'],
      ['2025-11-12T00:05:00Z', 'UTC', LATE_UTC, 'on 12 Nov 2025 at 00:05'],
      ['2025-11-12T23:59:00Z', 'UTC', LATE_UTC, 'on 12 Nov 2025 at 23:59'],
      ['2026-11-14T23:05:00Z', PRAGUE, LATE_PRAGUE, 'today at 00:05'],
      ['2026-11-15T22:59:00Z', PRAGUE, LATE_PRAGUE, 'today at 23:59'],
      ['2026-11-13T23:05:00Z', PRAGUE, LATE_PRAGUE, 'yesterday at 00:05'],
      ['2026-11-14T22:59:00Z', PRAGUE, LATE_PRAGUE, 'yesterday at 23:59'],
      ['2026-03-11T23:05:00Z', PRAGUE, LATE_PRAGUE, 'on 12 Mar at 00:05'],
      ['2026-03-12T22:59:00Z', PRAGUE, LATE_PRAGUE, 'on 12 Mar at 23:59'],
      ['2026-06-30T22:05:00Z', PRAGUE, LATE_PRAGUE, 'on 1 Jul at 00:05'],
      ['2026-07-01T21:59:00Z', PRAGUE, LATE_PRAGUE, 'on 1 Jul at 23:59'],
      ['2025-11-11T23:05:00Z', PRAGUE, LATE_PRAGUE, 'on 12 Nov 2025 at 00:05'],
      ['2025-11-12T22:59:00Z', PRAGUE, LATE_PRAGUE, 'on 12 Nov 2025 at 23:59'],
    ];
  for (const [at, zone, now, expected] of matrix) {
    test(`${zone}: ${at} seen late on 15 Nov 2026 → ${expected}`, () => {
      assert.equal(activityTime(ns(at), now, zone), expected);
    });
  }

  test('the same instant reads differently in the two zones (the parameter decides, not the machine)', () => {
    const at = ns('2026-11-14T23:05:00Z');
    assert.equal(activityTime(at, NOW, 'UTC'), 'yesterday at 23:05');
    assert.equal(activityTime(at, NOW, PRAGUE), 'today at 00:05');
  });

  test('24-hour, two digits each: 09:07, and midnight as 00:00 (never 24:00)', () => {
    assert.equal(activityTime(ns('2026-11-15T09:07:00Z'), NOW, 'UTC'), 'today at 09:07');
    assert.equal(activityTime(ns('2026-11-15T00:00:00Z'), NOW, 'UTC'), 'today at 00:00');
  });

  test('a time after now (a clock that differs): today, else its date', () => {
    assert.equal(activityTime(ns('2026-11-15T18:02:00Z'), NOW, 'UTC'), 'today at 18:02');
    assert.equal(activityTime(ns('2026-11-16T18:02:00Z'), NOW, 'UTC'), 'on 16 Nov at 18:02');
  });

  test('what is no time of the protocol gives an empty text, never a throw', () => {
    for (const bad of [null, undefined, '', ' 1', '1.5', '0x10', 'abc', 12, {}]) {
      assert.equal(activityTime(bad as unknown as string, NOW, 'UTC'), '', String(bad));
    }
  });

  test('a time zone the browser does not know is taken as UTC', () => {
    assert.equal(activityTime(ns('2026-11-15T00:05:00Z'), NOW, 'Not/A_Zone'), 'today at 00:05');
  });
});

/** A banner entry (S2 8.2.3 BannerEntryPayload). */
function entry(more: Record<string, unknown> = {}): {
  sessionId: string;
  shortId: string;
  title: string;
  endedAtNs: string | null;
  wasWorking: boolean;
  preselected: boolean;
} {
  return {
    sessionId: '7c2e9f4a-1b3d-4e5f-8a6b-9c0d1e2f3a4b',
    shortId: '7c2e9f4a',
    title: 'Fix the login page',
    endedAtNs: null,
    wasWorking: false,
    preselected: true,
    ...more,
  };
}

describe('bannerHeading', () => {
  const banner = (count: number, lastActivityNs: string | null) => ({
    bootId: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    lastActivityNs,
    entries: Array.from({ length: count }, () => entry()),
    shown: true,
    running: false,
  });

  test('three sessions, yesterday', () => {
    assert.equal(
      bannerHeading(banner(3, ns('2026-11-14T18:02:00Z')), NOW, 'UTC'),
      'Before the restart (last activity yesterday at 18:02) 3 sessions were open',
    );
  });

  test('one session: "1 session was open"', () => {
    assert.equal(
      bannerHeading(banner(1, ns('2026-11-15T08:30:00Z')), NOW, PRAGUE),
      'Before the restart (last activity today at 09:30) 1 session was open',
    );
  });

  test('no last activity: the heading without it', () => {
    assert.equal(
      bannerHeading(banner(2, null), NOW, 'UTC'),
      'Before the restart 2 sessions were open',
    );
  });
});

describe('entryText', () => {
  test('no exit recorded', () => {
    assert.equal(entryText(entry(), 'UTC'), '7c2e9f4a  Fix the login page · no exit recorded');
  });

  test('ended at a time, in the zone given, as HH:MM', () => {
    const ended = entry({ endedAtNs: ns('2026-11-14T17:02:00Z') });
    assert.equal(entryText(ended, 'UTC'), '7c2e9f4a  Fix the login page · ended 17:02');
    assert.equal(entryText(ended, PRAGUE), '7c2e9f4a  Fix the login page · ended 18:02');
  });

  test('was working, after either end', () => {
    assert.equal(
      entryText(entry({ wasWorking: true }), 'UTC'),
      '7c2e9f4a  Fix the login page · no exit recorded · was working',
    );
    assert.equal(
      entryText(entry({ wasWorking: true, endedAtNs: ns('2026-11-14T23:59:00Z') }), 'UTC'),
      '7c2e9f4a  Fix the login page · ended 23:59 · was working',
    );
  });

  test('an end time that is no time of the protocol reads as no exit recorded', () => {
    assert.equal(
      entryText(entry({ endedAtNs: 'soon' }), 'UTC'),
      '7c2e9f4a  Fix the login page · no exit recorded',
    );
  });
});

describe('restoreLabel', () => {
  test('"Restore <n>"', () => {
    assert.equal(restoreLabel(3), 'Restore 3');
    assert.equal(restoreLabel(1), 'Restore 1');
    assert.equal(restoreLabel(0), 'Restore 0');
  });
});
