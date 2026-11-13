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

  test('nsFromIso and isoFromNs round-trip', () => {
    assert.equal(nsFromIso(isoFromNs(T0)), T0);
  });
});
