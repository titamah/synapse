import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseRule, type Rule } from '../src/giveaway/rules.js';

const g = { start: new Date('2026-10-19T00:00:00-04:00'), end: new Date('2026-11-20T22:30:00-05:00') };
const event = { s: new Date('2026-11-20T18:00:00-05:00'), e: new Date('2026-11-20T22:30:00-05:00') };
const base = { windowStart: null, windowEnd: null, frequency: null, options: {} };
const rules: Rule[] = [
  { ...base, id: 1, position: 1, action: 'ig_comment', maxCount: 1, options: { requireTag: true } },
  { ...base, id: 2, position: 2, action: 'ig_story', maxCount: 1 },
  { ...base, id: 3, position: 3, action: 'ig_story', maxCount: 5, windowStart: event.s, windowEnd: event.e },
];
const at = (s: string) => new Date(s);
const pick = (ctx: any, prior: any[] = [], rs: Rule[] = rules) => chooseRule(rs, ctx, g, prior)?.id ?? null;

test('comment with tag counts', () => assert.equal(pick({ action: 'ig_comment', at: at('2026-10-20T12:00:00-04:00'), taggedFriend: true }), 1));
test('comment without tag earns nothing', () => assert.equal(pick({ action: 'ig_comment', at: at('2026-10-20T12:00:00-04:00'), taggedFriend: false }), null));
test('second comment earns nothing', () => assert.equal(pick({ action: 'ig_comment', at: at('2026-10-21T12:00:00-04:00'), taggedFriend: true }, [{ ruleId: 1, at: g.start }]), null));
test('story online uses general rule', () => assert.equal(pick({ action: 'ig_story', at: at('2026-10-25T12:00:00-04:00') }), 2));
test('second story online earns nothing', () => assert.equal(pick({ action: 'ig_story', at: at('2026-10-26T12:00:00-04:00') }, [{ ruleId: 2, at: g.start }]), null));
test('story at event uses event rule first', () => assert.equal(pick({ action: 'ig_story', at: at('2026-11-20T19:00:00-05:00') }), 3));
const fiveAtEvent = Array.from({ length: 5 }, () => ({ ruleId: 3, at: at('2026-11-20T19:00:00-05:00') }));
test('6th event story falls back to general rule', () => assert.equal(pick({ action: 'ig_story', at: at('2026-11-20T20:00:00-05:00') }, fiveAtEvent), 2));
test('7th event story earns nothing', () => assert.equal(pick({ action: 'ig_story', at: at('2026-11-20T20:30:00-05:00') }, [...fiveAtEvent, { ruleId: 2, at: g.start }]), null));
test('story before giveaway earns nothing', () => assert.equal(pick({ action: 'ig_story', at: at('2026-10-18T12:00:00-04:00') }), null));
test('story after close earns nothing', () => assert.equal(pick({ action: 'ig_story', at: at('2026-11-20T22:31:00-05:00') }), null));

const weekly: Rule[] = [{ ...base, id: 9, position: 1, action: 'ig_story', maxCount: 5, frequency: 'week' }];
test('weekly: first in week counts', () => assert.equal(pick({ action: 'ig_story', at: at('2026-10-20T12:00:00-04:00') }, [], weekly), 9));
test('weekly: same week again earns nothing', () => assert.equal(pick({ action: 'ig_story', at: at('2026-10-25T23:00:00-04:00') }, [{ ruleId: 9, at: at('2026-10-20T12:00:00-04:00') }], weekly), null));
test('weekly: next Monday counts', () => assert.equal(pick({ action: 'ig_story', at: at('2026-10-26T00:30:00-04:00') }, [{ ruleId: 9, at: at('2026-10-20T12:00:00-04:00') }], weekly), 9));
const daily: Rule[] = [{ ...base, id: 8, position: 1, action: 'ig_story', maxCount: 30, frequency: 'day' }];
test('daily: 11:59 PM and 12:01 AM ET are different days', () => assert.equal(pick({ action: 'ig_story', at: at('2026-10-21T00:01:00-04:00') }, [{ ruleId: 8, at: at('2026-10-20T23:59:00-04:00') }], daily), 8));

test('event rule stops counting when the giveaway closes early', () => {
  const closedEarly = { start: g.start, end: new Date('2026-11-20T19:00:00-05:00') };
  assert.equal(chooseRule(rules, { action: 'ig_story', at: new Date('2026-11-20T19:30:00-05:00') }, closedEarly, [])?.id ?? null, null);
});
