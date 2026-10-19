import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csvCell, toCsv } from './csv';
import { planLoop, type Edge } from './loop';
import { planSplit, type SplitMember } from './split';

const member = (userId: string, skillLevel: number | null, region = 'IL', country = 'US'): SplitMember => ({
  userId,
  skillLevel,
  country,
  region,
  postalCode: null,
});

test('planSplit makes even pods grouped by skill, then place', () => {
  const people = [
    member('a', 3, 'NY'),
    member('b', 1, 'IL'),
    member('c', null),
    member('d', 3, 'CA'),
    member('e', 1, 'CA'),
    member('f', 5),
    member('g', 3, 'IL'),
    member('h', 1, 'NY'),
    member('i', 2),
    member('j', 2),
  ];
  const pods = planSplit(people, 4, 'Spring', []);
  assert.deepEqual(
    pods.map((p) => p.userIds.length),
    [4, 3, 3],
  );
  assert.deepEqual(pods.map((p) => p.name), ['Spring 1', 'Spring 2', 'Spring 3']);
  assert.deepEqual(pods.flatMap((p) => p.userIds), ['e', 'b', 'h', 'i', 'j', 'd', 'g', 'a', 'f', 'c']);
});

test('planSplit skips names already in use', () => {
  const pods = planSplit([member('a', 1), member('b', 1), member('c', 1)], 1, 'Pod', ['pod 2', 'Other']);
  assert.deepEqual(pods.map((p) => p.name), ['Pod 1', 'Pod 3', 'Pod 4']);
});

/** Follows assignments from `start` and returns the people visited, to check for one loop. */
function walk(edges: Edge[], start: string): string[] {
  const seen = [start];
  for (let cur = edges.find((e) => e.makerId === start)?.recipientId; cur && cur !== start; ) {
    seen.push(cur);
    cur = edges.find((e) => e.makerId === cur)?.recipientId;
  }
  return seen;
}

test('planLoop closes loose people into one loop', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  for (let seed = 0; seed < 20; seed++) {
    const random = mulberry(seed);
    const { add, unmatchedMakers, unmatchedRecipients } = planLoop(ids, [], random);
    assert.equal(add.length, 5);
    assert.ok(add.every((e) => e.makerId !== e.recipientId));
    assert.equal(walk(add, 'a').length, 5);
    assert.deepEqual([unmatchedMakers, unmatchedRecipients], [[], []]);
  }
});

test('planLoop keeps existing assignments and builds them into the loop', () => {
  const existing = [
    { makerId: 'a', recipientId: 'b' },
    { makerId: 'b', recipientId: 'c' },
  ];
  const { add } = planLoop(['a', 'b', 'c', 'd', 'e'], existing, mulberry(1));
  assert.ok(!add.some((e) => e.makerId === 'a' || e.makerId === 'b'), 'a and b already make for someone');
  assert.ok(!add.some((e) => e.recipientId === 'b' || e.recipientId === 'c'), 'b and c already have makers');
  assert.equal(walk([...existing, ...add], 'a').length, 5);
});

test('planLoop leaves a pod alone when everyone is covered', () => {
  const edges = [
    { makerId: 'a', recipientId: 'b' },
    { makerId: 'b', recipientId: 'a' },
  ];
  assert.deepEqual(planLoop(['a', 'b'], edges), { add: [], unmatchedMakers: [], unmatchedRecipients: [] });
});

test('planLoop never has someone make for themselves', () => {
  assert.deepEqual(planLoop(['a'], []), { add: [], unmatchedMakers: ['a'], unmatchedRecipients: ['a'] });
  // Fran already makes for two people, so nobody is free to make for Fran.
  const edges = [
    { makerId: 'fran', recipientId: 'monica' },
    { makerId: 'fran', recipientId: 'john' },
  ];
  const result = planLoop(['fran', 'monica', 'john'], edges, mulberry(3));
  assert.ok(result.add.every((e) => e.makerId !== e.recipientId));
  // One of Monica and John makes for Fran; the other still gets someone, so nobody sits idle.
  assert.equal(result.add.length, 2);
  assert.deepEqual(result.add.map((e) => e.makerId).sort(), ['john', 'monica']);
  assert.ok(result.add.some((e) => e.recipientId === 'fran'));
  assert.deepEqual([result.unmatchedMakers, result.unmatchedRecipients], [[], []]);
});

test('planLoop pairs a pod of two both ways', () => {
  for (let seed = 0; seed < 10; seed++) {
    const { add, unmatchedMakers, unmatchedRecipients } = planLoop(['a', 'b'], [], mulberry(seed));
    assert.deepEqual(add.map((e) => `${e.makerId}->${e.recipientId}`).sort(), ['a->b', 'b->a']);
    assert.deepEqual([unmatchedMakers, unmatchedRecipients], [[], []]);
  }
});

test('planLoop pairs a pod of two both ways when someone outside already makes for one of them', () => {
  for (let seed = 0; seed < 10; seed++) {
    const { add, unmatchedMakers } = planLoop(['a', 'b'], [{ makerId: 'x', recipientId: 'a' }], mulberry(seed));
    assert.deepEqual(add.map((e) => `${e.makerId}->${e.recipientId}`).sort(), ['a->b', 'b->a']);
    assert.deepEqual(unmatchedMakers, []);
  }
});

test('csvCell quotes and blocks formulas', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a, b'), '"a, b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('-5'), "'-5");
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(3), '3');
  assert.equal(toCsv([['a', 'b'], ['c']]), '﻿a,b\r\nc\r\n');
});

/** A small seeded random number generator, so shuffles are repeatable. */
function mulberry(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
