import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  isoFromNs,
  NS_PER_DAY,
  NS_PER_MINUTE,
  NS_PER_MS,
  NS_PER_SECOND,
  nsFromIso,
  nsFromMs,
} from '../../src/platform/time.ts';
import { T0 } from '../helpers/platform.ts';

describe('time', () => {
  test('the unit constants are exact', () => {
    assert.equal(NS_PER_MS, 1_000_000n);
    assert.equal(NS_PER_SECOND, 1_000_000_000n);
    assert.equal(NS_PER_MINUTE, 60_000_000_000n);
    assert.equal(NS_PER_DAY, 86_400_000_000_000n);
  });

  test('isoFromNs prints UTC with milliseconds, truncating the rest', () => {
    assert.equal(isoFromNs(1_762_988_000_123_456_789n), '2025-11-12T22:53:20.123Z');
    assert.equal(isoFromNs(T0), '2026-11-12T09:00:00.000Z');
  });

  test('nsFromMs scales epoch milliseconds to nanoseconds', () => {
    assert.equal(nsFromMs(1_762_988_000_123), 1_762_988_000_123_000_000n);
  });

  test('nsFromIso reads UTC and offset timestamps', () => {
    assert.equal(nsFromIso('2026-11-12T09:00:00.000Z'), T0);
    assert.equal(nsFromIso('2026-11-12T10:00:00.000+01:00'), T0);
  });

  test('nsFromIso gives null for text that is not a timestamp', () => {
    assert.equal(nsFromIso('yesterday'), null);
  });

  test('nsFromIso accepts a timestamp with or without seconds and fraction', () => {
    assert.equal(nsFromIso('2026-11-12T09:00:00Z'), T0);
    assert.equal(nsFromIso('2026-11-12T09:00Z'), T0);
    assert.equal(nsFromIso('2026-11-12T09:00:00.5Z'), T0 + 500_000_000n);
    assert.equal(nsFromIso('2026-11-12T09:00:00.123456789Z'), T0 + 123_000_000n);
    assert.equal(
      nsFromIso('2026-11-12T09:00:00-05:30'),
      T0 + 5n * 3_600_000_000_000n + 1_800_000_000_000n,
    );
  });

  test('nsFromIso gives null for what is not an ISO 8601 date-time with Z or an offset', () => {
    for (const text of [
      '1',
      '2026',
      '2026-11-12',
      '2026-11-12T09:00:00', // local time: the answer would depend on the machine
      '2026-11-12 09:00:00Z',
      '2026-11-12T09:00:00z',
      '2026-11-12T09:00:00+0100',
      'Thu, 12 Nov 2026 09:00:00 GMT',
      'November 12, 2026 09:00:00 UTC',
      '2026-13-12T09:00:00Z',
      '2026-11-32T09:00:00Z',
      '',
    ]) {
      assert.equal(nsFromIso(text), null, JSON.stringify(text));
    }
  });

  test('nsFromIso and isoFromNs round-trip', () => {
    assert.equal(nsFromIso(isoFromNs(T0)), T0);
  });
});
