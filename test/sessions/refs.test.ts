import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RefError } from '../../src/platform/errors.ts';
import type { ListRow } from '../../src/sessions/list.ts';
import { resolveRef } from '../../src/sessions/refs.ts';
import { ds, meta, rows } from '../helpers/derived.ts';
import { S1, S2, S3, T0 } from '../helpers/platform.ts';

const A1 = 'aaaa0000-0000-4000-8000-000000000001';
const A2 = 'aaaa0000-0000-4000-8000-000000000002';

/** S1 `alpha`; S2 `beta`, done. */
function two(): ListRow[] {
  return rows([ds({ id: S1 }), ds({ id: S2, hidden: true, doneAtNs: T0 })], {
    metas: [meta(S1, { label: 'alpha' }), meta(S2, { label: 'beta', doneAtNs: T0 })],
  });
}

const refError = (ref: string, rowList: readonly ListRow[]): RefError => {
  try {
    resolveRef(ref, rowList);
  } catch (error) {
    assert.ok(error instanceof RefError, `not a RefError: ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: `resolveRef(${JSON.stringify(ref)}) did not throw` });
};

test('a full session id resolves to its row, in any case', () => {
  const rowList = two();
  assert.equal(resolveRef(S1, rowList).id, S1);
  assert.equal(resolveRef(S1.toUpperCase(), rowList).id, S1);
});

test('a prefix of at least 4 characters resolves to the one row that starts with it', () => {
  assert.equal(resolveRef('0b5f', two()).id, S1);
  assert.equal(resolveRef('0B5F3C1E-8D', two()).id, S1);
});

test('a prefix shorter than 4 characters is not searched', () => {
  const error = refError('0b5', two());
  assert.equal(error.message, "no session matches '0b5'");
  assert.equal(error.exitCode, 3);
  assert.deepEqual(error.candidates, []);
});

test('a prefix of two sessions is ambiguous and names both', () => {
  const rowList = rows([
    ds({ id: A1, transcript: { aiTitle: 'one' } }),
    ds({ id: A2 }),
    ds({ id: S1 }),
  ]);
  const error = refError('aaaa', rowList);
  assert.equal(error.message, "'aaaa' matches 2 sessions");
  assert.equal(error.exitCode, 3);
  assert.deepEqual(error.candidates, [
    { id: A1, title: 'one' },
    { id: A2, title: '2026-11-12 09:00 demo' },
  ]);
});

test('an ambiguous prefix lists its candidates in the order of the rows given', () => {
  const error = refError('aaaa', rows([ds({ id: A2 }), ds({ id: A1 })]));
  assert.deepEqual(
    error.candidates.map((c) => c.id),
    [A2, A1],
  );
});

test('an exact id wins over the prefix match it is also part of', () => {
  // Real ids all have the same length, so only ids of another shape can tell the two steps apart.
  const rowList = rows([ds({ id: 'aaaa1111' }), ds({ id: 'aaaa11112222' })]);
  assert.equal(resolveRef('aaaa1111', rowList).id, 'aaaa1111');
  assert.equal(refError('aaaa111', rowList).message, "'aaaa111' matches 2 sessions");
});

test('a prefix is found among all sessions, an expired unlabelled one (not listed) included', () => {
  const expired = ds({ id: S3, marks: ['expired'], transcript: { missingSinceNs: T0 } });
  assert.equal(resolveRef('2d7b', rows([expired])).id, S3);
});

test('a prefix is found among done sessions and those of another entrypoint', () => {
  const rowList = rows([
    ds({ id: S2, hidden: true, doneAtNs: T0 }),
    ds({ id: S3, transcript: { entrypoint: 'sdk-ts' } }),
  ]);
  assert.equal(resolveRef('1c6a', rowList).id, S2);
  assert.equal(resolveRef('2d7b', rowList).id, S3);
});

test('a label resolves to its row, a done one included (D22)', () => {
  assert.equal(resolveRef('beta', two()).id, S2);
  assert.equal(resolveRef('alpha', two()).id, S1);
});

test('a label is compared as typed: no folding of case, no trimming', () => {
  const rowList = two();
  assert.equal(refError('ALPHA', rowList).message, "no session matches 'ALPHA'");
  assert.equal(refError('alpha ', rowList).message, "no session matches 'alpha '");
});

test('a label of two sessions is ambiguous and names both', () => {
  const rowList = rows([ds({ id: S1, transcript: { aiTitle: 'x' } }), ds({ id: S3 })], {
    metas: [meta(S1, { label: 'alpha' }), meta(S3, { label: 'alpha' })],
  });
  const error = refError('alpha', rowList);
  assert.equal(error.message, "'alpha' matches 2 sessions");
  assert.deepEqual(error.candidates, [
    { id: S1, title: 'alpha' },
    { id: S3, title: 'alpha' },
  ]);
});

test('a label on a row that is never listed is not found', () => {
  const rowList = rows([ds({ id: S1, transcript: { entrypoint: 'sdk-ts' } })], {
    metas: [meta(S1, { label: 'alpha' })],
  });
  assert.equal(refError('alpha', rowList).message, "no session matches 'alpha'");
});

test('a label on a not-running session without a transcript is not found', () => {
  const rowList = rows([ds({ id: S1, transcript: null })], {
    metas: [meta(S1, { label: 'alpha' })],
  });
  assert.equal(refError('alpha', rowList).message, "no session matches 'alpha'");
});

test('a label that looks like an id prefix is read as the prefix first (the first step with a match decides)', () => {
  const rowList = rows([ds({ id: S1 }), ds({ id: S3 })], {
    metas: [meta(S3, { label: '0b5f' })],
  });
  assert.equal(resolveRef('0b5f', rowList).id, S1);
});

test('a ref that matches nothing says so and has no candidates', () => {
  const error = refError('nothing', two());
  assert.equal(error.message, "no session matches 'nothing'");
  assert.deepEqual(error.candidates, []);
  assert.equal(refError('', two()).message, "no session matches ''");
});

test('nothing resolves among no rows', () => {
  assert.equal(refError(S1, []).message, `no session matches '${S1}'`);
});

test('a ref that looks like a flag resolves to nothing and never to a row by accident', () => {
  for (const ref of ['--dangerously-skip-permissions', '-rabc', '--', '----']) {
    assert.equal(refError(ref, two()).exitCode, 3, ref);
  }
});

test('the row returned carries the stored id, never the text typed', () => {
  assert.equal(resolveRef(S1.toUpperCase(), two()).id, S1);
  assert.equal(resolveRef('0B5F', two()).id, S1);
});

test('the typed text is sanitised where it is repeated in a message', () => {
  const error = refError('x\x1b]0;pwn\x07y', two());
  assert.equal(error.message, "no session matches 'xy'");
});
