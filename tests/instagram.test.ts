import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DISCORD_TOKEN ??= 'x';
process.env.CLIENT_ID ??= 'x';
process.env.SERVER_ID ??= 'x';
process.env.DATABASE_URL ??= 'postgresql://x@localhost:1/x';

const { parseShortcode, toComment } = await import('../src/instagram/api.js');
const { commentsToRevoke, tagsAFriend } = await import('../src/instagram/comments.js');

test('parseShortcode: post, reel, share params, profile-style links', () => {
  assert.equal(parseShortcode('https://www.instagram.com/p/DeU57Lun84l/'), 'DeU57Lun84l');
  assert.equal(parseShortcode('https://www.instagram.com/reel/DectwEzp6f7/?igsh=MWx3b2x4'), 'DectwEzp6f7');
  assert.equal(parseShortcode('instagram.com/bostonblerds/p/Deh5vQnH9kZ'), 'Deh5vQnH9kZ');
  assert.equal(parseShortcode('https://www.instagram.com/bostonblerds/'), null);
  assert.equal(parseShortcode('not a link'), null);
});

test('commentsToRevoke: counted comments no longer visible lose their entry', () => {
  const counted = [
    { id: 1, sourceRef: 'c1' },
    { id: 2, sourceRef: 'c2' },
    { id: 3, sourceRef: null },
  ];
  assert.deepEqual(commentsToRevoke(counted, new Set(['c1'])).map(b => b.id), [2]);
  assert.deepEqual(commentsToRevoke(counted, new Set(['c1', 'c2'])), []);
});

test('tagsAFriend: needs someone other than BB or the commenter', () => {
  assert.equal(tagsAFriend('jay', 'yo @kia_b'), true);
  assert.equal(tagsAFriend('jay', '@BostonBlerds pick me'), false);
  assert.equal(tagsAFriend('jay', '@jay lol'), false);
});

test('toComment: real Instagram shape (username under from, sticker comments without text)', () => {
  const c = toComment({ id: '1', timestamp: '2026-10-13T21:53:05+0000', hidden: false, from: { id: '9', username: 'faith.fit.blerd' } });
  assert.deepEqual(c, { id: '1', username: 'faith.fit.blerd', text: '', timestamp: '2026-10-13T21:53:05+0000', hidden: false });
  assert.equal(toComment({ id: '2', text: 'hi', timestamp: 't' })?.username ?? null, null);
  assert.equal(toComment({ id: '3', text: 'hi', timestamp: 't', username: 'old_shape' })?.username, 'old_shape');
});
