import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openSlots, renderWinnerMessage, weightedPick } from '../src/giveaway/winnerRules.js';

test('weightedPick: lands proportionally to entries', () => {
  const pool = [{ id: 'a', weight: 1 }, { id: 'b', weight: 3 }];
  assert.equal(weightedPick(pool, () => 0.0)?.id, 'a');     // ticket 0 of 4
  assert.equal(weightedPick(pool, () => 0.24)?.id, 'a');    // ticket 0.96
  assert.equal(weightedPick(pool, () => 0.26)?.id, 'b');    // ticket 1.04
  assert.equal(weightedPick(pool, () => 0.999)?.id, 'b');
  assert.equal(weightedPick([], () => 0.5), null);
  assert.equal(weightedPick([{ id: 'x', weight: 0 }], () => 0.5), null);
});

test('weightedPick: real randomness roughly matches the odds', () => {
  const pool = [{ id: 'a', weight: 1 }, { id: 'b', weight: 3 }];
  let b = 0;
  for (let i = 0; i < 20_000; i++) if (weightedPick(pool)?.id === 'b') b++;
  assert.ok(b / 20_000 > 0.72 && b / 20_000 < 0.78, `b won ${b / 200}% (expected ~75%)`);
});

test('openSlots: declined/expired free a slot', () => {
  assert.equal(openSlots(1, []), 1);
  assert.equal(openSlots(1, ['pending']), 0);
  assert.equal(openSlots(1, ['declined']), 1);
  assert.equal(openSlots(3, ['accepted', 'expired', 'notified']), 1);
});

test('renderWinnerMessage: placeholders, default, unknown left alone', () => {
  assert.equal(renderWinnerMessage('Hi {name}, {giveaway} by {deadline} {oops}', { name: 'Alex', giveaway: 'GTA VI', deadline: 'Friday' }), 'Hi Alex, GTA VI by Friday {oops}');
  assert.match(renderWinnerMessage(null, { name: 'Alex', giveaway: 'GTA VI', deadline: 'Friday' }), /Congrats Alex! You won \*\*GTA VI\*\*/);
});
