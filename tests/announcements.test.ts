import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crossedCapacity, crossedCountdowns, formatDuration, reachedMilestone, resolveAnnouncements } from '../src/giveaway/announcementRules.js';

const H = 3_600_000;

test('countdowns: none before the first point, closest point first once several passed', () => {
  assert.deepEqual(crossedCountdowns([336, 72, 24, 5], 400 * H), []);
  assert.deepEqual(crossedCountdowns([336, 72, 24, 5], 300 * H), [336]);
  assert.deepEqual(crossedCountdowns([336, 72, 24, 5], 4 * H), [5, 24, 72, 336]);
  assert.deepEqual(crossedCountdowns([5], 0), []);
});

test('milestones: highest reached', () => {
  assert.equal(reachedMilestone(100, 99), null);
  assert.equal(reachedMilestone(100, 100), 100);
  assert.equal(reachedMilestone(100, 234), 200);
});

test('capacity: highest crossed first; nothing without a cap', () => {
  assert.deepEqual(crossedCapacity([50, 75, 90, 95, 99], 76, 100), [75, 50]);
  assert.deepEqual(crossedCapacity([50, 99], 99, 100), [99, 50]);
  assert.deepEqual(crossedCapacity([50], 10, null), []);
});

test('settings: defaults fill gaps, old v1 shape still read', () => {
  const r = resolveAnnouncements({ capacity: { enabled: false, percents: [] } });
  assert.equal(r.capacity.enabled, false);
  assert.equal(r.started, true);
  assert.deepEqual(resolveAnnouncements({ enabled: true, milestoneEvery: 25 }).milestones, { enabled: true, every: 25 });
});

test('formatDuration', () => {
  assert.equal(formatDuration(336), '14 days');
  assert.equal(formatDuration(24), '24 hours');
  assert.equal(formatDuration(1), '1 hour');
  assert.equal(formatDuration(0.5), '30 minutes');
});
