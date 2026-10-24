import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DISCORD_TOKEN ??= 'x';
process.env.CLIENT_ID ??= 'x';
process.env.SERVER_ID ??= 'x';
process.env.DATABASE_URL ??= 'postgresql://x@localhost:1/x';

const { giveawayFlags, globalFlags, flagActions } = await import('../src/flags/flags.js');

const now = new Date('2026-10-20T12:00:00-04:00');
const giveaway = (over: Record<string, unknown> = {}) =>
  ({ id: 6, name: 'GTA VI Giveaway', slug: 'gta', testMode: false, startsAt: new Date('2026-10-19T17:00:00-04:00'), endsAt: new Date('2026-11-20T22:30:00-05:00'), closedAt: null, personalDataDeletedAt: null, ...over }) as any;
const commentNoPost = { id: 27, position: 4, platform: 'instagram', action: 'comment', type: 'bonus', options: { requireTag: true } } as any;
const facts = (over: Record<string, unknown> = {}) =>
  ({ giveaway: giveaway(), status: 'open', rules: [commentNoPost], channelProblems: [], syncError: null, storyWebhookOn: true, commentsMissedByWebhook: 0, winnersWaiting: [], conflicts: [], now, ...over }) as any;

test('comment rule without a post: info (no alert) while scheduled, blocking + alert once open', () => {
  const scheduled = giveawayFlags(facts({ status: 'scheduled' }));
  assert.equal(scheduled[0]!.severity, 'info');
  assert.equal(scheduled[0]!.alert, false);
  const open = giveawayFlags(facts());
  assert.equal(open[0]!.severity, 'blocking');
  assert.equal(open[0]!.alert, true);
  assert.equal(open[0]!.key, 'comment_post_missing:6:27');
  assert.match(open[0]!.message, /Rule #4/);
});

test('test-mode giveaways show flags but never alert', () => {
  assert.equal(giveawayFlags(facts({ giveaway: giveaway({ testMode: true }) }))[0]!.alert, false);
});

test('closed giveaways: no post/channel flags; retention heads-up within 7 days', () => {
  const ended = giveaway({ endsAt: new Date(now.getTime() - 85 * 864e5) });
  const flags = giveawayFlags(facts({ giveaway: ended, status: 'closed', channelProblems: [{ channel: 'x', problem: 'missing' }] }));
  assert.deepEqual(flags.map(f => f.code), ['retention_upcoming']);
  assert.equal(flags[0]!.severity, 'info');
  const earlier = giveawayFlags(facts({ giveaway: giveaway({ endsAt: new Date(now.getTime() - 30 * 864e5) }), status: 'closed' }));
  assert.equal(earlier.length, 0);
});

test('channel problems, sync errors, waiting winners and conflicts', () => {
  const flags = giveawayFlags(
    facts({
      rules: [],
      channelProblems: [{ channel: 'gta-giveaway', problem: 'no-access' }],
      syncError: 'Instagram API 400',
      winnersWaiting: [{ id: 3, status: 'checking', who: '<@1>' }],
      conflicts: [{ igUsername: 'alex', attemptedBy: '2', claimedBy: '1' }],
    }),
  );
  assert.deepEqual(flags.map(f => `${f.code}:${f.severity}`), ['entry_channel_problem:blocking', 'ig_sync_failing:blocking', 'winner_waiting:warning', 'username_conflict:warning']);
  assert.equal(flags.find(f => f.code === 'username_conflict')!.alert, false);
});

test('webhooks: Story webhook off is blocking (only with a Story rule); missed comments are a warning', () => {
  const story = { id: 30, position: 5, platform: 'instagram', action: 'story', type: 'bonus', options: {} } as any;
  assert.deepEqual(giveawayFlags(facts({ rules: [story], storyWebhookOn: false })).map(f => `${f.code}:${f.severity}`), ['ig_story_webhook_off:blocking']);
  assert.equal(giveawayFlags(facts({ rules: [story], storyWebhookOn: null })).length, 0, 'unknown is not off');
  assert.equal(giveawayFlags(facts({ rules: [], storyWebhookOn: false })).length, 0, 'no Story rule, no flag');
  const missed = giveawayFlags(facts({ rules: [], commentsMissedByWebhook: 2 }));
  assert.deepEqual(missed.map(f => `${f.code}:${f.severity}`), ['ig_comment_webhook_missed:warning']);
  assert.match(missed[0]!.message, /2 comments/);
  assert.equal(giveawayFlags(facts({ rules: [], commentsMissedByWebhook: 2, status: 'scheduled' })).length, 0, 'only while open');
});

test('Instagram token: renewal failing or expiring within 2 weeks', () => {
  assert.equal(globalFlags({ configured: false }, now).length, 0);
  const flags = globalFlags({ configured: true, lastError: 'boom', expiresAt: new Date(now.getTime() + 5 * 864e5).toISOString() } as any, now);
  assert.deepEqual(flags.map(f => f.key), ['ig_token:renew_failed', 'ig_token:expiring']);
});

test('what each level allows besides fixing it', () => {
  assert.deepEqual(flagActions('blocking'), []);
  assert.deepEqual(flagActions('warning'), ['snooze']);
  assert.deepEqual(flagActions('info'), ['dismiss']);
});
