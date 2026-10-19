// End-to-end test of the giveaway engine + admin API against a THROWAWAY database.
// No Discord login: the web server runs on its own. It wipes and rebuilds the database it's given.
//
//   docker run -d --rm --name synapse-testdb -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test -p 127.0.0.1:5434:5432 postgres:18
//   npm run test:e2e
//   docker rm -f synapse-testdb
import fs from 'fs';
import os from 'os';
import path from 'path';

const repo = process.cwd();

// A fake Instagram: three of our posts, and errors for everything else (comment/tag reads fail
// harmlessly, so recorded activity is never touched by a background sync).
process.env.IG_ACCESS_TOKEN ??= 'e2e-fake-token';
const FAKE_POSTS = [
  { id: '1000', permalink: 'https://www.instagram.com/p/P1/', media_type: 'IMAGE', timestamp: new Date(Date.now() - 2 * 3600e3).toISOString() },
  { id: '1001', permalink: 'https://www.instagram.com/p/MAIN1/', media_type: 'IMAGE', timestamp: new Date(Date.now() - 3600e3).toISOString() },
  { id: '1002', permalink: 'https://www.instagram.com/reel/REEL1/', media_type: 'VIDEO', timestamp: new Date(Date.now() - 1800e3).toISOString() },
];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  if (url.hostname !== 'graph.instagram.com') return realFetch(input, init);
  const path = url.pathname.replace(/^\/v[\d.]+/, '');
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (path === '/me/media') return json({ data: FAKE_POSTS });
  const post = FAKE_POSTS.find(p => path === `/${p.id}`);
  if (post) return json(post);
  return json({ error: { message: 'fake Instagram: not available in tests' } }, 400);
}) as typeof fetch;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-e2e-'));
const { db, pool } = await import(`${repo}/src/db/client.ts`);
await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;');
const { migrate } = await import('drizzle-orm/node-postgres/migrator');


let fails = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) fails++;
  console.log(cond ? 'PASS' : 'FAIL', name, cond ? '' : JSON.stringify(extra));
};

// --- 1. Migrate to the pre-engine schema and create old-style GTA data -----------
const oldDir = path.join(scratch, 'drizzle-old');
fs.rmSync(oldDir, { recursive: true, force: true });
fs.mkdirSync(path.join(oldDir, 'meta'), { recursive: true });
const journal = JSON.parse(fs.readFileSync(`${repo}/drizzle/meta/_journal.json`, 'utf8'));
journal.entries = journal.entries.slice(0, 3);
fs.writeFileSync(path.join(oldDir, 'meta/_journal.json'), JSON.stringify(journal));
for (const e of journal.entries) fs.copyFileSync(`${repo}/drizzle/${e.tag}.sql`, path.join(oldDir, `${e.tag}.sql`));
await migrate(db, { migrationsFolder: oldDir });
await pool.query(`INSERT INTO giveaways (slug, closes_at) VALUES ('gta6-2026', '2026-11-20T22:30:00-05:00')`);
await pool.query(`INSERT INTO entrants (giveaway_id, discord_id, discord_username, ig_username) VALUES (1, 'd1', 'jay', 'jay_ig')`);
await pool.query(`INSERT INTO bonuses (giveaway_id, ig_username, type, source, source_ref) VALUES (1, 'jay_ig', 'COMMENT', 'ig_webhook', 'c-legacy')`);

// --- 2. Run the new migrations ---------------------------------------------------
// Up to just before posts moved onto rules; GTA gets a saved post the old way, then the last migration runs.
const almostDir = path.join(scratch, 'drizzle-almost');
fs.mkdirSync(path.join(almostDir, 'meta'), { recursive: true });
const fullJournal = JSON.parse(fs.readFileSync(`${repo}/drizzle/meta/_journal.json`, 'utf8'));
const almost = { ...fullJournal, entries: fullJournal.entries.slice(0, fullJournal.entries.findIndex((e: any) => e.tag === '0015_rule_posts')) };
fs.writeFileSync(path.join(almostDir, 'meta/_journal.json'), JSON.stringify(almost));
for (const e of almost.entries) fs.copyFileSync(`${repo}/drizzle/${e.tag}.sql`, path.join(almostDir, `${e.tag}.sql`));
await migrate(db, { migrationsFolder: almostDir });
await pool.query(`UPDATE giveaways SET platform_settings = jsonb_set(platform_settings, '{instagram}', $1::jsonb) WHERE slug = 'gta6-2026'`,
  [JSON.stringify({ posts: [{ id: '1000', permalink: 'https://www.instagram.com/p/P1/', postedAt: '2026-10-19T20:00:00.000Z' }] })]);
await migrate(db, { migrationsFolder: `${repo}/drizzle` });
const gta = (await pool.query(`SELECT * FROM giveaways WHERE slug='gta6-2026'`)).rows[0];
ok('GTA becomes giveaway #1 with settings', gta.id === 1 && gta.name === 'GTA VI Giveaway' && JSON.stringify(gta.platform_settings.discord) === '{"channels":["gta-giveaway"]}', gta);
const gtaEnter = (await pool.query(`SELECT options FROM giveaway_rules WHERE giveaway_id=1 AND action='enter'`)).rows[0];
ok('GTA channel moved onto its enter rule', gtaEnter?.options.channel === 'gta-giveaway', gtaEnter);
ok('GTA form: Instagram account field, locked', gta.form_fields[0].type === 'account' && gta.form_fields[0].locked === true, gta.form_fields);
const gtaRules = (await pool.query(`SELECT * FROM giveaway_rules WHERE giveaway_id=1 ORDER BY position`)).rows;
const sig = (r: any) => `${r.platform}:${r.action}:${r.type}`;
ok('GTA rules: Discord enter + member required, IG comment + story bonus',
  gtaRules.some(r => sig(r) === 'discord:enter:required') && gtaRules.some(r => sig(r) === 'discord:member:required')
  && gtaRules.some(r => sig(r) === 'instagram:comment:bonus' && r.options.requireTag === true) && gtaRules.some(r => sig(r) === 'instagram:story:bonus'), gtaRules.map(sig));
const acts = (await pool.query(`SELECT * FROM activities WHERE giveaway_id=1 ORDER BY id`)).rows;
ok('entrant → Discord enter activity (with its channel); legacy bonus → comment activity',
  acts.some(a => a.platform === 'discord' && a.action === 'enter' && a.discord_id === 'd1' && a.details.channel === 'gta-giveaway' && a.source_ref === 'd1:gta-giveaway') && acts.some(a => a.action === 'comment' && a.source_ref === 'c-legacy'), acts);
const gtaComment = (await pool.query(`SELECT options FROM giveaway_rules WHERE giveaway_id=1 AND action='comment'`)).rows[0];
const gtaSettings = (await pool.query(`SELECT platform_settings FROM giveaways WHERE id=1`)).rows[0].platform_settings;
ok('GTA post moved onto its comment rule', gtaComment?.options.post?.id === '1000' && JSON.stringify(gtaSettings.instagram) === '{}', { gtaComment, gtaSettings });
const oldTables = (await pool.query(`SELECT to_regclass('bonuses') AS b`)).rows[0].b;
ok('v1 bonuses table dropped', oldTables === null, oldTables);

// The upgraded GTA giveaway runs Oct 19 – Nov 20, 2026. Close it so the tests' own
// "starting now" giveaways never overlap it, whatever today's date is.
await pool.query(`UPDATE giveaways SET closed_at = now(), close_reason = 'early' WHERE slug = 'gta6-2026'`);

// --- 3. Admin API -----------------------------------------------------------------
const { createWebServer } = await import(`${repo}/src/web/server.ts`);
const srv = createWebServer().listen(0);
const base = `http://localhost:${(srv.address() as any).port}/admin`;
const KEY = process.env.ADMIN_API_KEY!;
const api = async (method: string, p: string, body?: unknown, opts: { key?: string; actor?: string | null } = {}) => {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.key ?? KEY}`, 'content-type': 'application/json' };
  if (opts.actor !== null) headers['x-admin-user'] = opts.actor ?? 'tester@bostonblerds.com';
  const r = await fetch(base + p, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
};

ok('wrong key → 401', (await api('GET', '/giveaways', undefined, { key: 'nope' })).status === 401);
const list = await api('GET', '/giveaways');
ok('list giveaways', list.status === 200 && list.json.some((g: any) => g.name === 'GTA VI Giveaway'), list.json);

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const discordReq = [{ action: 'enter', type: 'required' }, { action: 'member', type: 'required' }];
const testGiveaway = {
  name: 'Test Giveaway',
  startsAt: iso(now - 60 * 60e3),
  endsAt: iso(now + 20 * 60 * 60e3),
  baseWeight: 1,
  platforms: [
    { platform: 'discord', rules: [{ action: 'enter', type: 'required', options: { channel: '#Test-Giveaway' } }, { action: 'member', type: 'required' }] },
    { platform: 'instagram', rules: [
      { action: 'story', type: 'bonus', weight: 1, maxCount: 1 },
      { action: 'comment', type: 'bonus', weight: 1, maxCount: 1, options: { requireTag: true, post: 'https://www.instagram.com/p/P1/?igsh=xyz' } },
    ] },
  ],
  formFields: [{ id: 'platform', label: 'What do you play on?', type: 'select', required: true, options: ['PS5', 'Xbox', 'PC'] }],
  reminderText: "Don't forget to follow [@BostonBlerds](https://instagram.com/bostonblerds)!",
};
const igRules = (j: any) => j.platforms.find((p: any) => p.platform === 'instagram').rules;

ok('create without X-Admin-User → 400', (await api('POST', '/giveaways', testGiveaway, { actor: null })).status === 400);
const noChannel = await api('POST', '/giveaways', { ...testGiveaway, platforms: [{ platform: 'discord', rules: discordReq }] });
ok('Discord enter without a channel → 400', noChannel.status === 400 && /channel/.test(noChannel.json.error), noChannel.json);
const wrongAction = await api('POST', '/giveaways', { ...testGiveaway, platforms: [{ platform: 'discord', settings: { channel: 'x' }, rules: [{ action: 'story' }] }] });
ok('action on the wrong platform → 400', wrongAction.status === 400 && /isn't a discord action/.test(wrongAction.json.error), wrongAction.json);
const noRules = await api('POST', '/giveaways', { ...testGiveaway, platforms: [{ platform: 'discord', settings: { channel: 'x' }, rules: [] }] });
ok('platform without rules → 400', noRules.status === 400, noRules.json);
const badLink = await api('GET', '/instagram/resolve?url=not-a-link');
ok('resolve: garbage link → 404 with a clear message', badLink.status === 404 && /instagram\.com\/p/.test(badLink.json.error), badLink.json);
const noPost = await api('POST', '/giveaways', { ...testGiveaway, platforms: [testGiveaway.platforms[0], { platform: 'instagram', rules: [{ action: 'comment', type: 'bonus' }] }] });
ok('comment rule without a post → 400', noPost.status === 400 && /need a post/.test(noPost.json.error), noPost.json);
const unknownPost = await api('POST', '/giveaways', { ...testGiveaway, platforms: [testGiveaway.platforms[0], { platform: 'instagram', rules: [{ action: 'comment', type: 'bonus', options: { post: 'https://www.instagram.com/p/NOPE/' } }] }] });
ok("post that isn't ours → 400", unknownPost.status === 400 && /Couldn't find that post/.test(unknownPost.json.error), unknownPost.json);
const badDates = await api('POST', '/giveaways', { ...testGiveaway, endsAt: iso(now - 2 * 60 * 60e3) });
ok('end before start → 400', badDates.status === 400, badDates.json);

const created = await api('POST', '/giveaways', testGiveaway);
ok('create giveaway → 201, open, 2 platforms', created.status === 201 && created.json.status === 'open' && created.json.platforms.length === 2, created.json);
ok('channel normalized, on the enter rule', created.json.platforms[0].rules[0].options.channel === 'test-giveaway' && /in #test-giveaway/.test(created.json.platforms[0].rules[0].label), created.json.platforms[0]);
ok('Instagram account field added + locked (Discord entry + Instagram)',
  created.json.formFields[0].type === 'account' && created.json.formFields[0].locked === true && created.json.formFields.length === 2, created.json.formFields);
ok('rules have labels', igRules(created.json).every((r: any) => r.label?.startsWith('Instagram:')), igRules(created.json));
const savedPost = igRules(created.json).find((r: any) => r.action === 'comment').options.post;
ok('comment rule post link resolved and stored with the rule', savedPost?.id === '1000' && savedPost.permalink === 'https://www.instagram.com/p/P1/' && !!savedPost.postedAt, savedPost);
const gid = created.json.id;

const overlap = await api('POST', '/giveaways', { ...testGiveaway, name: 'Overlapping' });
ok('overlapping giveaway → 409', overlap.status === 409, overlap.json);

// Add an "event" window rule: 5 Stories during the next 2 hours.
const keepRules = (j: any) => j.platforms.map((p: any) => ({ platform: p.platform, settings: p.settings, rules: p.rules.map(({ label, description, position, ...r }: any) => r) }));
const withEvent = keepRules((await api('GET', `/giveaways/${gid}`)).json);
withEvent[1].rules.push({ action: 'story', type: 'bonus', weight: 1, maxCount: 5, windowStart: iso(now - 30 * 60e3), windowEnd: iso(now + 2 * 60 * 60e3) });
const patched = await api('PATCH', `/giveaways/${gid}`, { platforms: withEvent });
ok('add event rule via PATCH (post kept)', patched.status === 200 && igRules(patched.json).length === 3 && igRules(patched.json).find((r: any) => r.action === 'comment').options.post?.id === '1000', patched.json);
ok('rule descriptions are readable', igRules(patched.json).some((r: any) => /bonus ×1, max 5, /.test(r.description)), igRules(patched.json).map((r: any) => r.description));

// Dashboard forms often send null for empty optional fields.
const nullPatch = await api('PATCH', `/giveaways/${gid}`, {
  reminderText: null, maxParticipants: null, testMode: null, announcements: null,
  winnerNotify: null, claimHours: null, formFields: null, platforms: null, baseWeight: null,
});
ok('PATCH with nulls → 200, nulls clear or keep', nullPatch.status === 200 && nullPatch.json.reminderText === null && igRules(nullPatch.json).length === 3 && nullPatch.json.formFields.length === 2 && nullPatch.json.claimHours === 12, nullPatch.json);

// --- 4. Engine: entries + Instagram activity -------------------------------------
const svc = await import(`${repo}/src/giveaway/service.ts`);
const open = await svc.getOpenGiveaway();
ok('open giveaway is the test one', open?.id === gid, open);
const e1 = await svc.submitEntry({ channel: svc.enterChannels(open)[0] ?? 'none', giveaway: open, discordId: 'u1', discordUsername: 'alex', values: { ig: '@Alex.Plays', platform: 'PS5' } });
ok('entry with form answers', e1.status === 'created' && e1.entrant.igUsername === 'alex.plays' && e1.entrant.answers.platform === 'PS5', e1);
const e1b = await svc.submitEntry({ channel: svc.enterChannels(open)[0] ?? 'none', giveaway: open, discordId: 'u1', discordUsername: 'alex', values: { ig: 'alex.plays', platform: 'PC' } });
ok('edit answer → updated', e1b.status === 'updated' && e1b.entrant.answers.platform === 'PC', e1b);
const badSelect = await svc.submitEntry({ channel: svc.enterChannels(open)[0] ?? 'none', giveaway: open, discordId: 'u2', discordUsername: 'sam', values: { ig: 'sam', platform: 'Switch' } });
ok('invalid dropdown value rejected', badSelect.status === 'invalid', badSelect);
const conflict = await svc.submitEntry({ channel: svc.enterChannels(open)[0] ?? 'none', giveaway: open, discordId: 'u2', discordUsername: 'sam', values: { ig: 'alex.plays', platform: 'PS5' } });
ok('IG username already claimed → conflict', conflict.status === 'conflict', conflict);
await svc.submitEntry({ channel: svc.enterChannels(open)[0] ?? 'none', giveaway: open, discordId: 'u2', discordUsername: 'sam', values: { ig: 'sam_ig', platform: 'Xbox' } });

const record = (action: string, ig: string, ref: string, details: Record<string, unknown> = {}) =>
  svc.recordInstagramActivity({ giveaway: open, action, igUsername: ig, at: new Date(), sourceRef: ref, details });
ok('comment w/o tag → recorded', (await record('comment', 'alex.plays', 'c1', { taggedFriend: false, mediaId: '1000' })) === 'recorded');
ok('comment with tag → recorded', (await record('comment', 'alex.plays', 'c2', { taggedFriend: true, mediaId: '1000' })) === 'recorded');
ok('same comment again → duplicate', (await record('comment', 'alex.plays', 'c2', { taggedFriend: true, mediaId: '1000' })) === 'duplicate');
for (let i = 1; i <= 7; i++) await record('story', 'alex.plays', `s${i}`);
ok('comment from before the start → not recorded', (await svc.recordInstagramActivity({ giveaway: open, action: 'comment', igUsername: 'old_fan', at: new Date(now - 2 * 60 * 60e3), sourceRef: 'c-old', details: { mediaId: '1000' } })) === 'before-start');
ok('own account never recorded', (await record('story', 'bostonblerds', 'own1')) === 'own-account');
ok('story from someone not entered yet → recorded', (await record('story', 'newfan', 'n1')) === 'recorded');

// --- 5. People, overrides, dry run, exports --------------------------------------
let people = await api('GET', `/giveaways/${gid}/people`);
const find = (name: string) => people.json.find((p: any) => p.discord?.username === name || p.accounts.instagram === name);
let alex = find('alex');
let sam = find('sam');
ok('alex: 1 base + 1 tagged comment + 1 story + 5 event stories = 8', alex.eligible && alex.entries.total === 8 && alex.entries.base === 1 && alex.entries.bonus === 7, alex);
ok('breakdown has labels', alex.breakdown.length === 3 && alex.breakdown.every((b: any) => b.label), alex.breakdown);
ok('sam: base entry only', sam.eligible && sam.entries.total === 1, sam);
const newfan = find('newfan');
ok('Instagram-only person listed, not eligible, missing the Discord entry', newfan && !newfan.eligible && newfan.discord === null && newfan.missing.some((m: string) => /Discord: entered/.test(m)), newfan);

const v1Ents = await api('GET', `/giveaways/${gid}/entrants`);
ok('v1 /entrants still works', v1Ents.json.entrants.find((e: any) => e.discordUsername === 'alex').totalEntries === 8 && v1Ents.json.unmatched.length === 1, v1Ents.json);

const manual = await api('POST', `/giveaways/${gid}/people/${sam.id}/overrides`, { kind: 'manual_entry', label: 'Helped run the event', weight: 2 });
ok('manual entry added', manual.status === 201 && manual.json.label === 'Helped run the event', manual.json);
people = await api('GET', `/giveaways/${gid}/people`);
ok('sam: 1 + 2 manual = 3', find('sam').entries.total === 3 && find('sam').overrides.length === 1, find('sam'));
const removed = await api('DELETE', `/giveaways/${gid}/overrides/${manual.json.id}`);
ok('manual entry removed', removed.status === 200 && removed.json.revokedAt, removed.json);
ok('v1 bonus endpoint maps to a manual entry', (await api('POST', `/giveaways/${gid}/bonuses`, { entrantId: sam.id, label: 'x' })).status === 201);
const v1b = (await pool.query(`SELECT id FROM overrides WHERE giveaway_id=$1 AND revoked_at IS NULL`, [gid])).rows[0].id;
ok('v1 bonus delete', (await api('DELETE', `/giveaways/${gid}/bonuses/${v1b}`)).status === 200);
ok('disqualify requires reason', (await api('POST', `/giveaways/${gid}/people/${sam.id}/disqualify`, {})).status === 400);
ok('disqualify', (await api('POST', `/giveaways/${gid}/people/${sam.id}/disqualify`, { reason: 'Alt account' })).status === 200);
people = await api('GET', `/giveaways/${gid}/people`);
ok('disqualified → 0 entries', find('sam').entries.total === 0 && find('sam').disqualified?.reason === 'Alt account', find('sam'));
ok('restore', (await api('POST', `/giveaways/${gid}/entrants/${sam.id}/restore`)).status === 200);

// Dry run: make the tagged comment required. Alex stays eligible (6 left: comment moves to base), sam drops out.
const proposal = keepRules((await api('GET', `/giveaways/${gid}`)).json);
proposal[1].rules = proposal[1].rules.map((r: any) => (r.action === 'comment' ? { ...r, type: 'required' } : r));
const preview = await api('POST', `/giveaways/${gid}/preview`, { platforms: proposal });
ok('preview: sam becomes ineligible, alex loses the comment bonus', preview.status === 200 && preview.json.becomeIneligible === 1 && preview.json.entriesBefore === 9 && preview.json.entriesAfter === 7, preview.json);
ok('preview saved nothing', igRules((await api('GET', `/giveaways/${gid}`)).json).every((r: any) => r.type === 'bonus'));
// Grandfather sam: count the would-be requirement as met... only works on required rules.
const notRequired = await api('POST', `/giveaways/${gid}/people/${sam.id}/overrides`, { kind: 'requirement_met', ruleId: igRules(created.json)[1].id });
ok('requirement override on a bonus rule → 400', notRequired.status === 400, notRequired.json);

const entriesCsv = await api('GET', `/giveaways/${gid}/export/entries.csv`);
const lines = entriesCsv.text.trim().split('\n');
ok('entries.csv: header + 8 alex + 1 sam rows', lines.length === 1 + 8 + 1, lines);
ok('entries.csv named after giveaway', /Test-Giveaway-entries\.csv/.test(entriesCsv.headers.get('content-disposition') ?? ''), entriesCsv.headers.get('content-disposition'));
const entrantsCsv = await api('GET', `/giveaways/${gid}/export/entrants.csv`);
ok('entrants.csv has form answer + rule columns', /What do you play on\?/.test(entrantsCsv.text) && /max 5/.test(entrantsCsv.text), entrantsCsv.text.split('\n')[0]);
const activityCsv = await api('GET', `/giveaways/${gid}/export/activity.csv`);
ok('activity.csv: every recorded action', activityCsv.text.trim().split('\n').length === 1 + 2 /* enters */ + 2 + 7 + 1, activityCsv.text);
const auditCsv = await api('GET', `/giveaways/${gid}/export/audit.csv`);
ok('audit.csv records the admin email', /admin:tester@bostonblerds\.com/.test(auditCsv.text));

// Deleted comments stop counting; seen again, they count again.
await svc.markMissingRemoved(gid, 'comment', new Set(['c1']), 'deleted');
people = await api('GET', `/giveaways/${gid}/people`);
ok('deleted comment → alex 7', find('alex').entries.total === 7, find('alex'));
await record('comment', 'alex.plays', 'c2', { taggedFriend: true, mediaId: '1000' });
people = await api('GET', `/giveaways/${gid}/people`);
ok('comment seen again → alex 8', find('alex').entries.total === 8, find('alex'));

ok('pick a winner while open → 409', (await api('POST', `/giveaways/${gid}/winners`, { personId: alex.id })).status === 409);
const closed = await api('POST', `/giveaways/${gid}/close`);
ok('close early → closed', closed.status === 200 && closed.json.status === 'closed', closed.json);

// Winners (no Discord connection in tests, so nothing is posted or DMed).
const pick = await api('POST', `/giveaways/${gid}/winners`, { personId: alex.id });
ok('manual pick → 201 pending', pick.status === 201 && pick.json.status === 'pending' && pick.json.entriesAtDraw === 8 && pick.json.personId === alex.id, pick.json);
ok('second pick with 1 slot → 409', (await api('POST', `/giveaways/${gid}/winners`, { entrantId: sam.id })).status === 409);
ok('notify without Discord → 503', (await api('POST', `/giveaways/${gid}/winners/${pick.json.id}/notify`)).status === 503);
const declined = await api('POST', `/giveaways/${gid}/winners/${pick.json.id}/outcome`, { outcome: 'declined' });
ok('report declined → winner kept as declined', declined.status === 200 && declined.json.status === 'declined', declined.json);
people = await api('GET', `/giveaways/${gid}/people`);
ok('declined winner is disqualified', find('alex').entries.total === 0);
ok('cannot pick a disqualified person', (await api('POST', `/giveaways/${gid}/winners`, { personId: alex.id })).status === 400);
const drawn = await api('POST', `/giveaways/${gid}/winners/draw`);
ok('draw → the only eligible person (sam)', drawn.status === 201 && drawn.json.entrantId === sam.id, drawn.json);
const accepted = await api('POST', `/giveaways/${gid}/winners/${drawn.json.id}/outcome`, { outcome: 'accepted' });
ok('report accepted', accepted.status === 200 && accepted.json.status === 'accepted', accepted.json);
const history = await api('GET', `/giveaways/${gid}/winners`);
ok('winner history: declined then accepted', history.json.map((w: any) => w.status).join(',') === 'declined,accepted' && history.json[1].entrant.discordUsername === 'sam', history.json);
ok('draw with no slot left → 409', (await api('POST', `/giveaways/${gid}/winners/draw`)).status === 409);
ok('no open giveaway after close', (await svc.getOpenGiveaway()) === null);

// Cap: a giveaway with max 2 participants closes itself on the 2nd entry. (v1 fields still accepted.)
const capped = await api('POST', '/giveaways', {
  name: 'Capped', startsAt: iso(now - 60e3), endsAt: iso(now + 60 * 60e3), maxParticipants: 2, entryChannel: 'capped',
  formFields: null, rules: null, igPost: null, reminderText: null,
  announcements: null, testMode: null, winnerNotify: null, claimHours: null,
});
ok('v1 create (entryChannel only) → Discord enter + member required',
  capped.status === 201 && capped.json.platforms.length === 1 && capped.json.platforms[0].rules.map((r: any) => `${r.action}:${r.type}`).join() === 'enter:required,member:required' && capped.json.entryMethods.join() === 'discord', capped.json);
const winnerSettings = await api('POST', '/giveaways', {
  name: 'Winner Settings', startsAt: '2027-03-01T12:00:00-05:00', endsAt: '2027-03-02T12:00:00-05:00', testMode: true,
  platforms: [{ platform: 'discord', settings: { channel: 'ws' }, rules: discordReq }],
  winnerCount: 2, winnerSelect: 'auto', winnerNotify: 'auto', notifyDelayMinutes: 1, winnerMessage: 'Hi {name}', claimHours: 3,
});
ok('create keeps winner settings', winnerSettings.status === 201 && winnerSettings.json.winners.count === 2 && winnerSettings.json.winners.select === 'auto' && winnerSettings.json.winners.notifyDelayMinutes === 1 && winnerSettings.json.winners.message === 'Hi {name}' && winnerSettings.json.winnerCount === 2, winnerSettings.json);
const grouped = await api('PATCH', `/giveaways/${winnerSettings.json.id}`, { winners: { ...winnerSettings.json.winners, count: 3, message: null } });
ok('PATCH grouped winners (read-only fields sent back are ignored)', grouped.status === 200 && grouped.json.winners.count === 3 && grouped.json.winners.message === null && grouped.json.winners.claimHours === 3, grouped.json);
ok('create with nulls → defaults', capped.json.testMode === false && capped.json.winnerNotify === 'manual' && capped.json.claimHours === 12 && capped.json.formFields.length === 0 && capped.json.baseWeight === 1, capped.json);
ok('delete an open giveaway → 409', (await api('DELETE', `/giveaways/${capped.json.id}?confirm=Capped`)).status === 409);
const cg = await svc.getOpenGiveaway();
await svc.submitEntry({ channel: svc.enterChannels(cg)[0] ?? 'none', giveaway: cg, discordId: 'a', discordUsername: 'a', values: {} });
await svc.submitEntry({ channel: svc.enterChannels(cg)[0] ?? 'none', giveaway: cg, discordId: 'b', discordUsername: 'b', values: {} });
ok('cap reached → closes automatically', (await svc.getOpenGiveaway()) === null && (await svc.getGiveaway(cg.id)).closeReason === 'cap');
const reopened = await svc.extendGiveaway(await svc.getGiveaway(cg.id), { spots: 1 }, 'tester');
ok('extend a full giveaway with spots → reopens', reopened.ok && reopened.giveaway.maxParticipants === 3 && (await svc.getOpenGiveaway())?.id === cg.id, reopened);
const noCapSpots = await svc.extendGiveaway({ ...(await svc.getGiveaway(cg.id)), maxParticipants: null }, { spots: 5 }, 'tester');
ok('spots without a cap → refused', !noCapSpots.ok, noCapSpots);
await svc.closeGiveaway(cg.id, 'tester', 'early');
const earlyExtend = await svc.extendGiveaway(await svc.getGiveaway(cg.id), { hours: 2 }, 'tester');
ok('extend a giveaway an admin closed early → refused', !earlyExtend.ok, earlyExtend);

// Delete: closed giveaway with people needs ?confirm=<name>.
const noConfirm = await api('DELETE', `/giveaways/${gid}`);
ok('delete without confirm → 400 requiresConfirm', noConfirm.status === 400 && noConfirm.json.requiresConfirm === true && noConfirm.json.entrants === 3, noConfirm.json);
ok('delete with wrong confirm → 400', (await api('DELETE', `/giveaways/${gid}?confirm=nope`)).status === 400);
const del = await api('DELETE', `/giveaways/${gid}?confirm=${encodeURIComponent('Test Giveaway')}`);
ok('delete with confirm → 200', del.status === 200 && del.json.deleted === true, del.json);
ok('deleted giveaway → 404', (await api('GET', `/giveaways/${gid}`)).status === 404);
const leftovers = (await pool.query(
  `SELECT (SELECT count(*) FROM entrants WHERE giveaway_id=$1) + (SELECT count(*) FROM activities WHERE giveaway_id=$1)
        + (SELECT count(*) FROM overrides WHERE giveaway_id=$1) + (SELECT count(*) FROM winners WHERE giveaway_id=$1)
        + (SELECT count(*) FROM giveaway_rules WHERE giveaway_id=$1) + (SELECT count(*) FROM audit_log WHERE giveaway_id=$1) AS n`, [gid])).rows[0].n;
ok('nothing left behind', Number(leftovers) === 0, leftovers);
const summary = (await pool.query(`SELECT * FROM audit_log WHERE action='giveaway.deleted' AND details->>'id' = $1`, [String(gid)])).rows[0];
ok('deletion summary kept in audit log', summary?.actor_id === 'admin:tester@bostonblerds.com', summary);
ok('GTA giveaway untouched', (await api('GET', '/giveaways/1')).status === 200);

// ----- Instagram only: first required rule enters; bonuses add entries.
const igOnly = await api('POST', '/giveaways', {
  name: 'IG Only', startsAt: iso(Date.now() - 60e3), endsAt: iso(Date.now() + 30 * 60e3),
  platforms: [{ platform: 'instagram', rules: [
    { action: 'comment', type: 'required', options: { post: 'https://www.instagram.com/p/MAIN1/' } },
    { action: 'tag', type: 'bonus', weight: 3, options: { captionIncludes: '#bbtest' } },
  ] }],
});
ok('instagram-only giveaway created (no form needed)', igOnly.status === 201 && igOnly.json.formFields.length === 0, igOnly.json);
const igG = await svc.getOpenGiveaway();
const igRec = (action: string, ig: string, ref: string, details: Record<string, unknown> = {}) =>
  svc.recordInstagramActivity({ giveaway: igG, action, igUsername: ig, at: new Date(), sourceRef: ref, details });
await igRec('comment', 'fan_one', 'igc1', { mediaId: '1001' });
await igRec('tag', 'fan_one', 'igt1', { caption: 'hi' });
await igRec('tag', 'fan_one', 'igt2', { caption: 'entering #BBTest!' });
await igRec('tag', 'lurker', 'igt3', { caption: '#bbtest' });
ok('Discord entries refused in instagram-only giveaways', (await svc.submitEntry({ channel: svc.enterChannels(igG)[0] ?? 'none', giveaway: igG, discordId: 'dz', discordUsername: 'z', values: {} })).status === 'closed');
const igPeople = (await api('GET', `/giveaways/${igOnly.json.id}/people`)).json;
const fan = igPeople.find((p: any) => p.accounts.instagram === 'fan_one');
ok('fan: base 1 + tag ×3 = 4 (tag without the caption text ignored)', fan?.eligible && fan.discord === null && fan.entries.total === 4, fan);
const lurker = igPeople.find((p: any) => p.accounts.instagram === 'lurker');
ok('tag without the required comment → not eligible', lurker && !lurker.eligible && lurker.entries.total === 0, lurker);
await api('POST', `/giveaways/${igOnly.json.id}/close`);

// ----- No required rules: any counted action qualifies (OR). Instagram first, then Discord → one linked person.
const either = await api('POST', '/giveaways', {
  name: 'Either Way', startsAt: iso(Date.now() - 60e3), endsAt: iso(Date.now() + 30 * 60e3),
  platforms: [
    { platform: 'discord', settings: { channel: 'either' }, rules: [{ action: 'enter', type: 'bonus' }] },
    { platform: 'instagram', rules: [{ action: 'comment', type: 'bonus', options: { post: '1001' } }] },
  ],
});
ok('either giveaway created, IG field auto-added', either.status === 201 && either.json.formFields[0]?.locked === true, either.json);
const eg = await svc.getOpenGiveaway();
await svc.recordInstagramActivity({ giveaway: eg, action: 'comment', igUsername: 'both_ways', at: new Date(), sourceRef: 'c-both', details: { mediaId: '1001' } });
await svc.recordInstagramActivity({ giveaway: eg, action: 'comment', igUsername: 'ig_only', at: new Date(), sourceRef: 'c-ig', details: { mediaId: '1001' } });
const linked = await svc.submitEntry({ channel: svc.enterChannels(eg)[0] ?? 'none', giveaway: eg, discordId: 'd-both', discordUsername: 'bothways', values: { ig: 'both_ways' } });
ok('Discord entry links to the Instagram person', linked.status !== 'conflict' && linked.entrant?.discordId === 'd-both', linked);
const ePeople = (await api('GET', `/giveaways/${either.json.id}/people`)).json;
const both = ePeople.find((p: any) => p.accounts.instagram === 'both_ways');
ok('linked person: one row, 1 base + enter + comment = 3', ePeople.length === 2 && both.discord?.id === 'd-both' && both.entries.total === 3, ePeople);
ok('Instagram-only person qualifies too: 1 base + comment = 2', ePeople.find((p: any) => p.accounts.instagram === 'ig_only')?.entries.total === 2, ePeople);
await api('POST', `/giveaways/${either.json.id}/close`);

// ----- Winner checks: "follows @BostonBlerds" is confirmed for winners before they're contacted.
const follow = await api('POST', '/giveaways', {
  name: 'Follow Check', startsAt: iso(Date.now() - 60e3), endsAt: iso(Date.now() + 30 * 60e3), winnerCount: 2,
  platforms: [
    { platform: 'discord', settings: { channel: 'follow' }, rules: discordReq },
    { platform: 'instagram', rules: [{ action: 'follow', type: 'required' }] },
  ],
});
const followRule = follow.json.platforms[1].rules[0];
ok('follow rule defaults to check: winners', follow.status === 201 && followRule.check === 'winners', follow.json);
const fg = await svc.getOpenGiveaway();
await svc.submitEntry({ channel: svc.enterChannels(fg)[0] ?? 'none', giveaway: fg, discordId: 'f1', discordUsername: 'f1', values: { ig: 'f1_ig' } });
await svc.submitEntry({ channel: svc.enterChannels(fg)[0] ?? 'none', giveaway: fg, discordId: 'f2', discordUsername: 'f2', values: { ig: 'f2_ig' } });
const fPeople = (await api('GET', `/giveaways/${follow.json.id}/people`)).json;
ok('eligible before the check, with the check listed', fPeople.every((p: any) => p.eligible && p.winnerChecks.length === 1), fPeople);
await api('POST', `/giveaways/${follow.json.id}/close`);
const f1 = fPeople.find((p: any) => p.discord.id === 'f1');
const f2 = fPeople.find((p: any) => p.discord.id === 'f2');
const w1 = await api('POST', `/giveaways/${follow.json.id}/winners`, { personId: f1.id });
ok('winner with a check → status checking', w1.status === 201 && w1.json.status === 'checking' && w1.json.checks.length === 1, w1.json);
const conf = await api('POST', `/giveaways/${follow.json.id}/winners/${w1.json.id}/checks/${followRule.id}`, { confirmed: true });
ok('check confirmed → pending (ready to notify)', conf.status === 200 && conf.json.status === 'pending' && conf.json.checks[0].confirmed === true, conf.json);
const w2 = await api('POST', `/giveaways/${follow.json.id}/winners`, { personId: f2.id });
const rej = await api('POST', `/giveaways/${follow.json.id}/winners/${w2.json.id}/checks/${followRule.id}`, { confirmed: false });
ok('check rejected → declined', rej.status === 200 && rej.json.status === 'declined', rej.json);

// ----- Several enter rules, each in its own channel: an enter rule counts entries made in its channel.
const chan = (ch: string, type = 'required') => ({ action: 'enter', type, options: { channel: ch } });
const twoBase = { name: 'Two Channels', startsAt: iso(Date.now() - 60e3), endsAt: iso(Date.now() + 30 * 60e3) };
ok('enter rule without a channel → 400', (await api('POST', '/giveaways', { ...twoBase, platforms: [{ platform: 'discord', rules: [{ action: 'enter', type: 'required' }] }] })).status === 400);
ok('channel on a non-enter rule → 400', (await api('POST', '/giveaways', { ...twoBase, platforms: [{ platform: 'discord', rules: [chan('a'), { action: 'member', type: 'required', options: { channel: 'a' } }] }] })).status === 400);
ok('two enter rules in the same channel → 400', (await api('POST', '/giveaways', { ...twoBase, platforms: [{ platform: 'discord', rules: [chan('a'), chan('#A', 'bonus')] }] })).status === 400);
const two = await api('POST', '/giveaways', { ...twoBase, platforms: [{ platform: 'discord', rules: [chan('main-chan'), chan('second-chan', 'bonus')] }] });
ok('two entry channels saved', two.status === 201 && two.json.platforms[0].rules.map((r: any) => r.options.channel).join() === 'main-chan,second-chan', two.json);
const tg = await svc.getOpenGiveaway();
ok('giveaway knows both entry channels', svc.enterChannels(tg).join() === 'main-chan,second-chan', tg.platformSettings);
await svc.submitEntry({ giveaway: tg, channel: 'main-chan', discordId: 't1', discordUsername: 't1', values: {} });
await svc.submitEntry({ giveaway: tg, channel: 'main-chan', discordId: 't2', discordUsername: 't2', values: {} });
const again = await svc.submitEntry({ giveaway: tg, channel: 'second-chan', discordId: 't2', discordUsername: 't2', values: {} });
ok('entering in the second channel too → updated', again.status === 'updated', again);
await svc.submitEntry({ giveaway: tg, channel: 'second-chan', discordId: 't3', discordUsername: 't3', values: {} });
const tPeople = (await api('GET', `/giveaways/${two.json.id}/people`)).json;
const tp = (id: string) => tPeople.find((p: any) => p.discord.id === id);
ok('main channel only → 1', tp('t1').eligible && tp('t1').entries.total === 1, tp('t1'));
ok('both channels → 1 + 1 bonus = 2', tp('t2').entries.total === 2, tp('t2'));
ok('second channel only → not eligible (main entry missing)', !tp('t3').eligible && tp('t3').missing.some((m: string) => /#main-chan/.test(m)), tp('t3'));
await api('POST', `/giveaways/${two.json.id}/close`);

// ----- Each comment rule has its own post: a bonus for the main post and another for the promo Reel.
const reelG = await api('POST', '/giveaways', {
  name: 'Reel Bonus', startsAt: iso(Date.now() - 60e3), endsAt: iso(Date.now() + 30 * 60e3),
  platforms: [
    { platform: 'discord', settings: { channel: 'reel' }, rules: discordReq },
    { platform: 'instagram', rules: [{ action: 'comment', type: 'bonus', options: { post: 'https://www.instagram.com/p/MAIN1/' } }] },
  ],
});
const reelRules = keepRules(reelG.json);
const badPost = structuredClone(reelRules);
badPost[0].rules[0].options = { post: '1002' };
ok('"post" on a non-comment rule → 400', (await api('PATCH', `/giveaways/${reelG.json.id}`, { platforms: badPost })).status === 400);
reelRules[1].rules.push({ action: 'comment', type: 'bonus', options: { post: 'https://www.instagram.com/reel/REEL1/?igsh=abc' } });
const reelPatched = await api('PATCH', `/giveaways/${reelG.json.id}`, { platforms: reelRules });
const reelRule = igRules(reelPatched.json)[1];
ok('Reel rule: link saved as the post, label names it', reelPatched.status === 200 && reelRule?.options.post?.id === '1002' && /instagram\.com\/reel\/REEL1/.test(reelRule.label), reelPatched.json);
ok('main post rule kept its post', igRules(reelPatched.json)[0].options.post?.id === '1001', igRules(reelPatched.json));
const rg = await svc.getOpenGiveaway();
await svc.submitEntry({ channel: svc.enterChannels(rg)[0] ?? 'none', giveaway: rg, discordId: 'r1', discordUsername: 'r1', values: { ig: 'r1_ig' } });
await svc.submitEntry({ channel: svc.enterChannels(rg)[0] ?? 'none', giveaway: rg, discordId: 'r2', discordUsername: 'r2', values: { ig: 'r2_ig' } });
const rc = (ig: string, ref: string, mediaId: string) => svc.recordInstagramActivity({ giveaway: rg, action: 'comment', igUsername: ig, at: new Date(), sourceRef: ref, details: { mediaId } });
await rc('r1_ig', 'rc1', '1001');
await rc('r1_ig', 'rc2', '1002');
await rc('r2_ig', 'rc3', '1001');
await rc('r2_ig', 'rc4', '1001');
const rPeople = (await api('GET', `/giveaways/${reelG.json.id}/people`)).json;
ok('main + Reel comments → 1 + 1 + 1 = 3', rPeople.find((p: any) => p.discord.id === 'r1').entries.total === 3, rPeople);
ok('two main-post comments → 1 + 1 = 2 (no Reel bonus)', rPeople.find((p: any) => p.discord.id === 'r2').entries.total === 2, rPeople);
await api('POST', `/giveaways/${reelG.json.id}/close`);

// ----- Retention: 90 days after the end, personal data goes; setup, stats and winners stay.
const ret = await import(`${repo}/src/giveaway/retention.ts`);
const fid = follow.json.id;
const before = await api('GET', `/giveaways/${fid}`);
ok('closed giveaway shows when personal data will be deleted', !!before.json.personalDataDeletesAt && before.json.personalDataDeletedAt === null, before.json);
await ret.runRetention(undefined, new Date(Date.now() + 80 * 864e5));
const early = await api('GET', `/giveaways/${fid}`);
ok('before 90 days: stats snapshot taken, people kept', early.json.stats?.entrants === 2 && early.json.stats.byRule.length === 3 && (await api('GET', `/giveaways/${fid}/people`)).json.length === 2, early.json.stats);
await ret.runRetention(undefined, new Date(Date.now() + 91 * 864e5));
const after = await api('GET', `/giveaways/${fid}`);
ok('after 90 days: personal data deleted, setup + stats kept', !!after.json.personalDataDeletedAt && after.json.stats?.eligible === 1 && after.json.platforms.length === 2, after.json);
ok('after 90 days: no people', (await api('GET', `/giveaways/${fid}/people`)).json.length === 0);
const left = (await pool.query(`SELECT (SELECT count(*) FROM entrants WHERE giveaway_id=$1) + (SELECT count(*) FROM activities WHERE giveaway_id=$1) + (SELECT count(*) FROM audit_log WHERE giveaway_id=$1 AND action LIKE 'entry.%') AS n`, [fid])).rows[0].n;
ok('after 90 days: entrants, activity, per-person audit gone', Number(left) === 0, left);
const kept = (await api('GET', `/giveaways/${fid}/winners`)).json;
ok('after 90 days: winners keep who won', kept.length === 2 && kept[0].entrantId === null && kept[0].person?.discordId === 'f1', kept);
ok('admin history kept', (await api('GET', `/giveaways/${fid}/audit`)).json.some((a: any) => a.action === 'giveaway.personal_data_deleted'));
await ret.runRetention(undefined, new Date(Date.now() + 366 * 864e5));
const anon = (await api('GET', `/giveaways/${fid}/winners`)).json;
ok('after a year: winners anonymized', anon.every((w: any) => w.person === null && w.anonymizedAt), anon);

srv.close();
await pool.end();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
