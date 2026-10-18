import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePerson, type EngineActivity, type EngineInput, type EngineRule } from '../src/giveaway/engine.js';

const g = { start: new Date('2026-10-19T16:00:00-04:00'), end: new Date('2026-11-20T22:30:00-05:00'), baseWeight: 1, firstPostAt: new Date('2026-10-19T16:05:00-04:00') };
const rule = (r: Partial<EngineRule> & Pick<EngineRule, 'id' | 'platform' | 'action' | 'type'>): EngineRule => ({
  position: r.id, weight: 1, min: 1, check: null, maxCount: 1, windowStart: null, windowEnd: null, frequency: null, options: {}, ...r,
});
let nextId = 1;
const act = (platform: EngineActivity['platform'], action: EngineActivity['action'], at: string, details: EngineActivity['details'] = {}): EngineActivity =>
  ({ id: nextId++, platform, action, at: new Date(at), details });

// GTA in v2: Discord enter + member required, follow required (winners), comment/story/event-story bonuses.
const gta: EngineRule[] = [
  rule({ id: 1, platform: 'discord', action: 'enter', type: 'required' }),
  rule({ id: 2, platform: 'discord', action: 'member', type: 'required' }),
  rule({ id: 3, platform: 'instagram', action: 'follow', type: 'required', check: 'winners' }),
  rule({ id: 4, platform: 'instagram', action: 'comment', type: 'bonus', options: { requireTag: true } }),
  rule({ id: 5, platform: 'instagram', action: 'story', type: 'bonus' }),
  rule({ id: 6, platform: 'instagram', action: 'story', type: 'bonus', maxCount: 5, windowStart: new Date('2026-11-20T19:00:00-05:00'), windowEnd: new Date('2026-11-20T22:30:00-05:00') }),
];
const run = (over: Partial<EngineInput>) =>
  evaluatePerson({ giveaway: g, rules: gta, person: { discordId: 'd1', disqualified: false }, activities: [], overrides: [], isMember: true, ...over });

test('GTA: entered on Discord and in the server → eligible, base 1, follow left for the winner check', () => {
  const r = run({ activities: [act('discord', 'enter', '2026-10-20T12:00:00-04:00')] });
  assert.equal(r.eligible, true);
  assert.deepEqual(r.entries, { base: 1, bonus: 0, manual: 0, total: 1 });
  assert.deepEqual(r.winnerChecks, [3]);
});

test('GTA: left the server → not eligible (member missing)', () => {
  const r = run({ activities: [act('discord', 'enter', '2026-10-20T12:00:00-04:00')], isMember: false });
  assert.equal(r.eligible, false);
  assert.deepEqual(r.missing, [2]);
  assert.equal(r.entries.total, 0);
});

test('GTA: Instagram first, Discord later → bonuses count once they enter (order does not matter)', () => {
  const ig = [act('instagram', 'comment', '2026-10-20T10:00:00-04:00', { taggedFriend: true }), act('instagram', 'story', '2026-10-21T10:00:00-04:00')];
  const before = run({ person: { discordId: null, disqualified: false }, activities: ig, isMember: null });
  assert.equal(before.eligible, false);
  assert.deepEqual(before.missing, [1, 2]);
  assert.equal(before.entries.bonus, 2, 'bonuses are tracked even before qualifying');
  assert.equal(before.entries.total, 0);
  const after = run({ activities: [...ig, act('discord', 'enter', '2026-11-01T12:00:00-04:00')] });
  assert.deepEqual(after.entries, { base: 1, bonus: 2, manual: 0, total: 3 });
});

test('GTA: 6 Stories at the event (none before) → 5 event + 1 anytime; 7th earns nothing', () => {
  const stories = Array.from({ length: 7 }, (_, i) => act('instagram', 'story', `2026-11-20T${19 + Math.floor(i / 3)}:${String((i % 3) * 15).padStart(2, '0')}:00-05:00`));
  const r = run({ activities: [act('discord', 'enter', '2026-10-20T12:00:00-04:00'), ...stories] });
  assert.equal(r.entries.bonus, 6);
  assert.deepEqual(r.breakdown.map(b => [b.ruleId, b.count]), [[5, 1], [6, 5]]);
});

test('Story before the giveaway post went up does not count', () => {
  const r = run({ activities: [act('discord', 'enter', '2026-10-20T12:00:00-04:00'), act('instagram', 'story', '2026-10-19T16:01:00-04:00')] });
  assert.equal(r.entries.bonus, 0);
});

test('Required comment (tagged) is part of the base; later comments are bonuses', () => {
  const rules = [
    rule({ id: 10, platform: 'instagram', action: 'comment', type: 'required', options: { requireTag: true } }),
    rule({ id: 11, platform: 'instagram', action: 'comment', type: 'bonus', maxCount: 3 }),
  ];
  const r = evaluatePerson({
    giveaway: g, rules, person: { discordId: null, disqualified: false }, overrides: [], isMember: null,
    activities: [
      act('instagram', 'comment', '2026-10-20T10:00:00-04:00', { taggedFriend: false }), // not tagged → bonus, not the requirement
      act('instagram', 'comment', '2026-10-21T10:00:00-04:00', { taggedFriend: true }),  // meets the requirement
      act('instagram', 'comment', '2026-10-22T10:00:00-04:00', { taggedFriend: true }),  // bonus
    ],
  });
  assert.equal(r.eligible, true);
  assert.deepEqual(r.entries, { base: 1, bonus: 2, manual: 0, total: 3 });
});

test('No required rules = OR: any counted action qualifies', () => {
  const rules = [rule({ id: 20, platform: 'discord', action: 'enter', type: 'bonus' }), rule({ id: 21, platform: 'instagram', action: 'comment', type: 'bonus' })];
  const base = { giveaway: g, rules, overrides: [], isMember: null } as const;
  assert.equal(evaluatePerson({ ...base, person: { discordId: null, disqualified: false }, activities: [act('instagram', 'comment', '2026-10-20T10:00:00-04:00')] }).eligible, true);
  assert.equal(evaluatePerson({ ...base, person: { discordId: 'd2', disqualified: false }, activities: [act('discord', 'enter', '2026-10-20T10:00:00-04:00')] }).entries.total, 2);
  assert.equal(evaluatePerson({ ...base, person: { discordId: null, disqualified: false }, activities: [] }).eligible, false);
});

test('Weights and base weight', () => {
  const rules = [rule({ id: 30, platform: 'discord', action: 'enter', type: 'required' }), rule({ id: 31, platform: 'instagram', action: 'story', type: 'bonus', weight: 3, maxCount: 2 })];
  const r = evaluatePerson({
    giveaway: { ...g, baseWeight: 2 }, rules, person: { discordId: 'd3', disqualified: false }, overrides: [], isMember: true,
    activities: [act('discord', 'enter', '2026-10-20T10:00:00-04:00'), act('instagram', 'story', '2026-10-21T10:00:00-04:00'), act('instagram', 'story', '2026-10-22T10:00:00-04:00')],
  });
  assert.deepEqual(r.entries, { base: 2, bonus: 6, manual: 0, total: 8 });
});

test('Overrides: requirement met (grandfathered) and manual entries; disqualified = 0', () => {
  const rules = [rule({ id: 40, platform: 'instagram', action: 'comment', type: 'required' })];
  const base = { giveaway: g, rules, activities: [], isMember: null } as const;
  const r = evaluatePerson({ ...base, person: { discordId: null, disqualified: false }, overrides: [{ kind: 'requirement_met', ruleId: 40 }, { kind: 'manual_entry', weight: 2, label: 'Helped out' }] });
  assert.deepEqual(r.entries, { base: 1, bonus: 0, manual: 2, total: 3 });
  const dq = evaluatePerson({ ...base, person: { discordId: null, disqualified: true }, overrides: [{ kind: 'requirement_met', ruleId: 40 }] });
  assert.equal(dq.eligible, false);
  assert.equal(dq.entries.total, 0);
});

test('Manual check for everyone blocks eligibility until confirmed', () => {
  const rules = [rule({ id: 50, platform: 'discord', action: 'enter', type: 'required' }), rule({ id: 51, platform: 'instagram', action: 'follow', type: 'required', check: 'everyone' })];
  const acts = [act('discord', 'enter', '2026-10-20T10:00:00-04:00')];
  const base = { giveaway: g, rules, person: { discordId: 'd5', disqualified: false }, activities: acts, isMember: true } as const;
  assert.deepEqual(evaluatePerson({ ...base, overrides: [] }).missing, [51]);
  assert.equal(evaluatePerson({ ...base, overrides: [{ kind: 'requirement_met', ruleId: 51 }] }).eligible, true);
});

test('min: required twice', () => {
  const rules = [rule({ id: 60, platform: 'instagram', action: 'comment', type: 'required', min: 2 })];
  const base = { giveaway: g, rules, person: { discordId: null, disqualified: false }, overrides: [], isMember: null } as const;
  assert.equal(evaluatePerson({ ...base, activities: [act('instagram', 'comment', '2026-10-20T10:00:00-04:00')] }).eligible, false);
  assert.equal(evaluatePerson({ ...base, activities: [act('instagram', 'comment', '2026-10-20T10:00:00-04:00'), act('instagram', 'comment', '2026-10-21T10:00:00-04:00')] }).eligible, true);
});
