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
await migrate(db, { migrationsFolder: `${repo}/drizzle` });
const gta = (await pool.query(`SELECT * FROM giveaways WHERE slug='gta6-2026'`)).rows[0];
ok('GTA becomes giveaway #1 with settings', gta.name === 'GTA VI Giveaway' && gta.entry_channel === 'gta-giveaway' && gta.form_fields[0].type === 'ig_username', gta);
const gtaRules = (await pool.query(`SELECT * FROM giveaway_rules WHERE giveaway_id=1 ORDER BY position`)).rows;
ok('GTA gets comment + story rules', gtaRules.length === 2 && gtaRules[0].action === 'ig_comment' && gtaRules[0].options.requireTag === true && gtaRules[1].action === 'ig_story', gtaRules);
const legacy = (await pool.query(`SELECT * FROM bonuses WHERE source_ref='c-legacy'`)).rows[0];
ok('legacy comment bonus mapped to the comment rule', legacy.action === 'ig_comment' && legacy.rule_id === gtaRules[0].id, legacy);

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
ok('list giveaways', list.status === 200 && list.json[0].name === 'GTA VI Giveaway' && list.json[0].status === 'scheduled', list.json);

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const testGiveaway = {
  name: 'Test Giveaway',
  startsAt: iso(now - 60 * 60e3),
  endsAt: iso(now + 20 * 60 * 60e3),
  entryChannel: 'test-giveaway',
  formFields: [
    { id: 'ig', label: 'Instagram username', type: 'ig_username', required: true },
    { id: 'platform', label: 'What do you play on?', type: 'select', required: true, options: ['PS5', 'Xbox', 'PC'] },
  ],
  reminderText: "Don't forget to follow [@BostonBlerds](https://instagram.com/bostonblerds)!",
  rules: [
    { action: 'ig_story', maxCount: 1 },
    { action: 'ig_comment', maxCount: 1, options: { requireTag: true } },
  ],
};

ok('create without X-Admin-User → 400', (await api('POST', '/giveaways', testGiveaway, { actor: null })).status === 400);
const noIgField = await api('POST', '/giveaways', { ...testGiveaway, formFields: [testGiveaway.formFields[1]] });
ok('IG rules without an IG username field → 400', noIgField.status === 400 && /Instagram username field/.test(noIgField.json.error), noIgField.json);
const badLink = await api('GET', '/instagram/resolve?url=not-a-link');
ok('resolve: garbage link → 404 with a clear message', badLink.status === 404 && /instagram\.com\/p/.test(badLink.json.error), badLink.json);
const badDates = await api('POST', '/giveaways', { ...testGiveaway, endsAt: iso(now - 2 * 60 * 60e3) });
ok('end before start → 400', badDates.status === 400, badDates.json);

const created = await api('POST', '/giveaways', testGiveaway);
ok('create giveaway → 201, open', created.status === 201 && created.json.status === 'open' && created.json.rules.length === 2, created.json);
const gid = created.json.id;

const overlap = await api('POST', '/giveaways', { ...testGiveaway, name: 'Overlapping' });
ok('overlapping giveaway → 409', overlap.status === 409, overlap.json);

// Add an "event" window rule: 5 Stories during the next 2 hours.
const eventRule = { action: 'ig_story', maxCount: 5, windowStart: iso(now - 30 * 60e3), windowEnd: iso(now + 2 * 60 * 60e3) };
const patched = await api('PATCH', `/giveaways/${gid}`, {
  rules: [...created.json.rules.map((r: any) => ({ id: r.id, action: r.action, maxCount: r.maxCount, options: r.options })), eventRule],
});
ok('add event rule via PATCH', patched.status === 200 && patched.json.rules.length === 3, patched.json);
ok('rule descriptions are readable', patched.json.rules.some((r: any) => /Story mention \(max 5, /.test(r.description)), patched.json.rules.map((r: any) => r.description));

// Dashboard forms often send null for empty optional fields.
const nullPatch = await api('PATCH', `/giveaways/${gid}`, {
  reminderText: null, maxParticipants: null, testMode: null, announcements: null,
  winnerNotify: null, claimHours: null, formFields: null, rules: null,
});
ok('PATCH with nulls → 200, nulls clear or keep', nullPatch.status === 200 && nullPatch.json.reminderText === null && nullPatch.json.rules.length === 3 && nullPatch.json.formFields.length === 2 && nullPatch.json.claimHours === 12, nullPatch.json);
const nullFieldPatch = await api('PATCH', `/giveaways/${gid}`, {
  formFields: [
    { id: 'ig', label: 'Instagram username', type: 'ig_username', required: true, placeholder: null, options: null },
    { id: 'platform', label: 'What do you play on?', type: 'select', required: true, placeholder: null, options: ['PS5', 'Xbox', 'PC'] },
  ],
  rules: nullPatch.json.rules.map((r: any) => ({ ...r, frequency: null, options: r.options.requireTag ? { requireTag: true } : null })),
});
ok('form fields + rules with null sub-fields → 200', nullFieldPatch.status === 200 && nullFieldPatch.json.rules.length === 3, nullFieldPatch.json);

// --- 4. Engine: entries + Instagram actions --------------------------------------
const svc = await import(`${repo}/src/giveaway/service.ts`);
const open = await svc.getOpenGiveaway();
ok('open giveaway is the test one', open?.id === gid, open);
const e1 = await svc.submitEntry({ giveaway: open, discordId: 'u1', discordUsername: 'alex', values: { ig: '@Alex.Plays', platform: 'PS5' } });
ok('entry with form answers', e1.status === 'created' && e1.entrant.igUsername === 'alex.plays' && e1.entrant.answers.platform === 'PS5', e1);
const e1b = await svc.submitEntry({ giveaway: open, discordId: 'u1', discordUsername: 'alex', values: { ig: 'alex.plays', platform: 'PC' } });
ok('edit answer → updated', e1b.status === 'updated' && e1b.entrant.answers.platform === 'PC', e1b);
const badSelect = await svc.submitEntry({ giveaway: open, discordId: 'u2', discordUsername: 'sam', values: { ig: 'sam', platform: 'Switch' } });
ok('invalid dropdown value rejected', badSelect.status === 'invalid', badSelect);
const conflict = await svc.submitEntry({ giveaway: open, discordId: 'u2', discordUsername: 'sam', values: { ig: 'alex.plays', platform: 'PS5' } });
ok('IG username already claimed → conflict', conflict.status === 'conflict', conflict);
await svc.submitEntry({ giveaway: open, discordId: 'u2', discordUsername: 'sam', values: { ig: 'sam_ig', platform: 'Xbox' } });

const award = (action: string, ig: string, ref: string, taggedFriend?: boolean) =>
  svc.awardAction({ giveaway: open, action, igUsername: ig, at: new Date(), sourceRef: ref, source: 'ig_webhook', ...(taggedFriend !== undefined ? { taggedFriend } : {}) });
ok('comment w/o tag → no-rule', (await award('ig_comment', 'alex.plays', 'c1', false)) === 'no-rule');
ok('comment with tag → awarded', (await award('ig_comment', 'alex.plays', 'c2', true)) === 'awarded');
ok('same comment again → duplicate', (await award('ig_comment', 'alex.plays', 'c2', true)) === 'duplicate');
const stories = [];
for (let i = 1; i <= 7; i++) stories.push(await award('ig_story', 'alex.plays', `s${i}`));
ok('7 stories during event: 5 event + 1 general + 1 nothing', JSON.stringify(stories) === JSON.stringify(['awarded', 'awarded', 'awarded', 'awarded', 'awarded', 'awarded', 'no-rule']), stories);
ok('own account never earns', (await award('ig_story', 'bostonblerds', 'own1')) === 'own-account');
ok('unmatched story (not entered yet) still recorded', (await award('ig_story', 'newfan', 'n1')) === 'awarded');

// --- 5. Admin actions + reporting ------------------------------------------------
let ents = await api('GET', `/giveaways/${gid}/entrants`);
const alex = ents.json.entrants.find((e: any) => e.discordUsername === 'alex');
const sam = ents.json.entrants.find((e: any) => e.discordUsername === 'sam');
ok('alex has 1 + 7 = 8 entries', alex.totalEntries === 8, alex);
ok('unmatched bonus listed', ents.json.unmatched.length === 1 && ents.json.unmatched[0].igUsername === 'newfan', ents.json.unmatched);

const manual = await api('POST', `/giveaways/${gid}/bonuses`, { entrantId: sam.id, label: 'Helped run the event' });
ok('manual bonus added', manual.status === 201 && manual.json.label === 'Helped run the event', manual.json);
const removed = await api('DELETE', `/giveaways/${gid}/bonuses/${manual.json.id}`, { reason: 'Test' });
ok('manual bonus removed', removed.status === 200 && removed.json.revokedReason === 'Test', removed.json);
ok('disqualify requires reason', (await api('POST', `/giveaways/${gid}/entrants/${sam.id}/disqualify`, {})).status === 400);
ok('disqualify', (await api('POST', `/giveaways/${gid}/entrants/${sam.id}/disqualify`, { reason: 'Alt account' })).status === 200);
ents = await api('GET', `/giveaways/${gid}/entrants`);
ok('disqualified → 0 entries', ents.json.entrants.find((e: any) => e.id === sam.id).totalEntries === 0);
ok('restore', (await api('POST', `/giveaways/${gid}/entrants/${sam.id}/restore`)).status === 200);

const entriesCsv = await api('GET', `/giveaways/${gid}/export/entries.csv`);
const lines = entriesCsv.text.trim().split('\n');
ok('entries.csv: header + 8 alex + 1 sam rows', lines.length === 1 + 8 + 1, lines);
ok('entries.csv named after giveaway', /Test-Giveaway-entries\.csv/.test(entriesCsv.headers.get('content-disposition') ?? ''), entriesCsv.headers.get('content-disposition'));
const entrantsCsv = await api('GET', `/giveaways/${gid}/export/entrants.csv`);
ok('entrants.csv has form answer + rule columns', /What do you play on\?/.test(entrantsCsv.text) && /Story mention \(max 5/.test(entrantsCsv.text), entrantsCsv.text.split('\n')[0]);
const auditCsv = await api('GET', `/giveaways/${gid}/export/audit.csv`);
ok('audit.csv records the admin email', /admin:tester@bostonblerds\.com/.test(auditCsv.text));

ok('pick a winner while open → 409', (await api('POST', `/giveaways/${gid}/winners`, { entrantId: alex.id })).status === 409);
const closed = await api('POST', `/giveaways/${gid}/close`);
ok('close early → closed', closed.status === 200 && closed.json.status === 'closed', closed.json);

// Winners (no Discord connection in tests, so nothing is posted or DMed).
const pick = await api('POST', `/giveaways/${gid}/winners`, { entrantId: alex.id });
ok('manual pick → 201 pending', pick.status === 201 && pick.json.status === 'pending' && pick.json.entriesAtDraw === 8, pick.json);
ok('second pick with 1 slot → 409', (await api('POST', `/giveaways/${gid}/winners`, { entrantId: sam.id })).status === 409);
ok('notify without Discord → 503', (await api('POST', `/giveaways/${gid}/winners/${pick.json.id}/notify`)).status === 503);
const declined = await api('POST', `/giveaways/${gid}/winners/${pick.json.id}/outcome`, { outcome: 'declined' });
ok('report declined → winner kept as declined', declined.status === 200 && declined.json.status === 'declined', declined.json);
ents = await api('GET', `/giveaways/${gid}/entrants`);
ok('declined winner is disqualified', ents.json.entrants.find((e: any) => e.id === alex.id).totalEntries === 0);
ok('cannot pick a disqualified entrant', (await api('POST', `/giveaways/${gid}/winners`, { entrantId: alex.id })).status === 400);
const drawn = await api('POST', `/giveaways/${gid}/winners/draw`);
ok('draw → the only eligible entrant (sam)', drawn.status === 201 && drawn.json.entrantId === sam.id, drawn.json);
const accepted = await api('POST', `/giveaways/${gid}/winners/${drawn.json.id}/outcome`, { outcome: 'accepted' });
ok('report accepted', accepted.status === 200 && accepted.json.status === 'accepted', accepted.json);
const history = await api('GET', `/giveaways/${gid}/winners`);
ok('winner history: declined then accepted', history.json.map((w: any) => w.status).join(',') === 'declined,accepted' && history.json[1].entrant.discordUsername === 'sam', history.json);
ok('draw with no slot left → 409', (await api('POST', `/giveaways/${gid}/winners/draw`)).status === 409);

ok('no open giveaway after close', (await svc.getOpenGiveaway()) === null);
ok('story after close earns nothing', (await award('ig_story', 'sam_ig', 'late1')) === 'no-rule');

// Cap: a giveaway with max 2 participants closes itself on the 2nd entry.
const capped = await api('POST', '/giveaways', {
  name: 'Capped', startsAt: iso(now - 60e3), endsAt: iso(now + 60 * 60e3), maxParticipants: 2,
  formFields: null, rules: null, entryChannel: null, igPost: null, reminderText: null,
  announcements: null, testMode: null, winnerNotify: null, claimHours: null,
});
const winnerSettings = await api('POST', '/giveaways', {
  name: 'Winner Settings', startsAt: '2027-03-01T12:00:00-05:00', endsAt: '2027-03-02T12:00:00-05:00', testMode: true,
  winnerCount: 2, winnerSelect: 'auto', winnerNotify: 'auto', notifyDelayMinutes: 1, winnerMessage: 'Hi {name}', claimHours: 3,
});
ok('create keeps winner settings', winnerSettings.status === 201 && winnerSettings.json.winnerCount === 2 && winnerSettings.json.winnerSelect === 'auto' && winnerSettings.json.notifyDelayMinutes === 1 && winnerSettings.json.winnerMessage === 'Hi {name}', winnerSettings.json);
ok('create with nulls everywhere → 201 with defaults', capped.status === 201 && capped.json.testMode === false && capped.json.winnerNotify === 'manual' && capped.json.claimHours === 12 && capped.json.formFields.length === 0, capped.json);
ok('delete an open giveaway → 409', (await api('DELETE', `/giveaways/${capped.json.id}?confirm=Capped`)).status === 409);
const cg = await svc.getOpenGiveaway();
await svc.submitEntry({ giveaway: cg, discordId: 'a', discordUsername: 'a', values: {} });
await svc.submitEntry({ giveaway: cg, discordId: 'b', discordUsername: 'b', values: {} });
ok('cap reached → closes automatically', (await svc.getOpenGiveaway()) === null && (await svc.getGiveaway(cg.id)).closeReason === 'cap');
const reopened = await svc.extendGiveaway(await svc.getGiveaway(cg.id), { spots: 1 }, 'tester');
ok('extend a full giveaway with spots → reopens', reopened.ok && reopened.giveaway.maxParticipants === 3 && (await svc.getOpenGiveaway())?.id === cg.id, reopened);
const noCapSpots = await svc.extendGiveaway({ ...(await svc.getGiveaway(cg.id)), maxParticipants: null }, { spots: 5 }, 'tester');
ok('spots without a cap → refused', !noCapSpots.ok, noCapSpots);
await svc.closeGiveaway(cg.id, 'tester', 'early');
const earlyExtend = await svc.extendGiveaway(await svc.getGiveaway(cg.id), { hours: 2 }, 'tester');
ok('extend a giveaway an admin closed early → refused', !earlyExtend.ok, earlyExtend);

// Delete: closed giveaway with entrants needs ?confirm=<name>.
const noConfirm = await api('DELETE', `/giveaways/${gid}`);
ok('delete without confirm → 400 requiresConfirm', noConfirm.status === 400 && noConfirm.json.requiresConfirm === true && noConfirm.json.entrants === 2, noConfirm.json);
ok('delete with wrong confirm → 400', (await api('DELETE', `/giveaways/${gid}?confirm=nope`)).status === 400);
const del = await api('DELETE', `/giveaways/${gid}?confirm=${encodeURIComponent('Test Giveaway')}`);
ok('delete with confirm → 200', del.status === 200 && del.json.deleted === true && del.json.entrants === 2, del.json);
ok('deleted giveaway → 404', (await api('GET', `/giveaways/${gid}`)).status === 404);
const leftovers = (await pool.query(
  `SELECT (SELECT count(*) FROM entrants WHERE giveaway_id=$1) + (SELECT count(*) FROM bonuses WHERE giveaway_id=$1)
        + (SELECT count(*) FROM giveaway_rules WHERE giveaway_id=$1) + (SELECT count(*) FROM audit_log WHERE giveaway_id=$1) AS n`, [gid])).rows[0].n;
ok('nothing left behind', Number(leftovers) === 0, leftovers);
const summary = (await pool.query(`SELECT * FROM audit_log WHERE action='giveaway.deleted' AND details->>'id' = $1`, [String(gid)])).rows[0];
ok('deletion summary kept in audit log', summary?.actor_id === 'admin:tester@bostonblerds.com' && summary.details.entrants === 2, summary);
ok('GTA giveaway untouched', (await api('GET', '/giveaways/1')).status === 200);

// ----- Instagram entry method
const igOnly = await api('POST', '/giveaways', {
  name: 'IG Only', startsAt: iso(Date.now() - 60e3), endsAt: iso(Date.now() + 30 * 60e3), entryMethods: ['instagram'],
  rules: [{ action: 'ig_comment', maxCount: 1 }, { action: 'ig_tag', maxCount: 1, options: { captionIncludes: '#bbtest' } }],
});
ok('instagram-entry giveaway created (no form needed)', igOnly.status === 201 && igOnly.json.entryMethods.join() === 'instagram', igOnly.json);
ok('instagram-entry without IG rules → 400', (await api('PATCH', `/giveaways/${igOnly.json.id}`, { rules: [] })).status === 400);
const igG = await svc.getOpenGiveaway();
const igAward = (action: string, ig: string, ref: string, extra: Record<string, unknown> = {}) =>
  svc.awardAction({ giveaway: igG, action, igUsername: ig, at: new Date(), sourceRef: ref, source: 'ig_webhook', ...extra });
ok('first comment enters an Instagram-only person', (await igAward('ig_comment', 'fan_one', 'igc1')) === 'awarded');
ok('tagged post without the caption text → no entry', (await igAward('ig_tag', 'fan_one', 'igt1', { caption: 'hi' })) === 'no-rule');
ok('tagged post with the caption text → entry', (await igAward('ig_tag', 'fan_one', 'igt2', { caption: 'entering #BBTest!' })) === 'awarded');
ok('Discord entries refused in instagram-only giveaways', (await svc.submitEntry({ giveaway: igG, discordId: 'dz', discordUsername: 'z', values: {} })).status === 'closed');
let igEnts = await api('GET', `/giveaways/${igOnly.json.id}/entrants`);
const fan = igEnts.json.entrants.find((e: any) => e.igUsername === 'fan_one');
ok('instagram-only entrant: no Discord, entries = actions (2)', fan && fan.discordId === null && fan.totalEntries === 2 && fan.inServer === null, igEnts.json);
await api('POST', `/giveaways/${igOnly.json.id}/close`);

// "Either": Instagram first, then Discord with the same IG username → one linked entrant.
const either = await api('POST', '/giveaways', {
  name: 'Either Way', startsAt: iso(Date.now() - 60e3), endsAt: iso(Date.now() + 30 * 60e3), entryMethods: ['discord', 'instagram'],
  formFields: [{ id: 'ig', label: 'Instagram username', type: 'ig_username', required: true }],
  rules: [{ action: 'ig_story', maxCount: 1 }],
});
ok('discord + instagram giveaway created', either.status === 201 && either.json.entryMethods.join() === 'discord,instagram', either.json);
ok('no entry methods → 400', (await api('PATCH', `/giveaways/${either.json.id}`, { entryMethods: [] })).status === 400);
const eg = await svc.getOpenGiveaway();
await svc.awardAction({ giveaway: eg, action: 'ig_story', igUsername: 'both_ways', at: new Date(), sourceRef: 's-both', source: 'ig_webhook' });
const linked = await svc.submitEntry({ giveaway: eg, discordId: 'd-both', discordUsername: 'bothways', values: { ig: 'both_ways' } });
ok('Discord entry links to the Instagram entrant', linked.status !== 'conflict' && linked.entrant?.discordId === 'd-both', linked);
const eEnts = await api('GET', `/giveaways/${either.json.id}/entrants`);
ok('linked entrant: 1 base + 1 story = 2 entries, one row', eEnts.json.entrants.length === 1 && eEnts.json.entrants[0].totalEntries === 2, eEnts.json);
await api('POST', `/giveaways/${either.json.id}/close`);

srv.close();
await pool.end();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
