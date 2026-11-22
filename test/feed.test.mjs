import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../extension/feed.js';

const T = globalThis.TumblrNew;
const DAY = 864e5;
const now = Date.UTC(2026, 10, 18);
let n = 0;
const post = (tags, blog = `blog${n}`, extra = {}) => ({ id: `p${n++}`, tags, blog, ...extra });

// Run posts through the engine the way the content script does: observe, then decide.
function run(p, s, posts, pinned = [], t = now) {
  return posts.map((x) => {
    T.observe(p, x, t);
    return T.decide(p, s, x, pinned, t);
  });
}
const shownCount = (ds) => ds.filter((d) => d.action !== 'collapse').length;

function artMusicProfile() {
  const p = T.emptyProfile();
  const s = T.newSession();
  for (let i = 0; i < 10; i++) {
    T.recordInteraction(p, s, post(['art']), 'like', now - (i + 1) * DAY);
    T.recordInteraction(p, s, post(['music']), 'like', now - (i + 1) * DAY);
  }
  return p;
}

test('1. one like does not flood the feed', () => {
  const p = artMusicProfile();
  const s = T.newSession();
  const liked = post(['elden ring']);
  run(p, s, [liked]);
  T.recordInteraction(p, s, liked, 'like', now);
  const ds = run(p, s, Array.from({ length: 12 }, () => post(['elden ring'])));
  assert.ok(shownCount(ds) <= 2, `shown ${shownCount(ds)} of 12`);
  assert.match(ds.at(-1).reason, /#elden ring used \d\/\d of its recent slots/);
});

test('1b. fresh profile: a 12-post topic flood shows at most 3', () => {
  const ds = run(T.emptyProfile(), T.newSession(), Array.from({ length: 12 }, () => post(['space'])));
  assert.ok(shownCount(ds) <= 3, `shown ${shownCount(ds)}`);
});

test('2. a sustained new interest (3 distinct posts) gets real room', () => {
  const p = artMusicProfile();
  const s = T.newSession();
  const before = T.quotaFn(p, now)('elden ring');
  for (let i = 0; i < 3; i++) T.recordInteraction(p, s, post(['elden ring']), 'like', now);
  const after = T.quotaFn(p, now)('elden ring');
  assert.ok(before <= 2 && after >= 3, `quota ${before} -> ${after}`);
});

test('3. dormant interests are remembered, not wiped by recent ones', () => {
  const p = T.emptyProfile();
  const s = T.newSession();
  for (let i = 0; i < 30; i++) T.recordInteraction(p, s, post(['hollow knight']), 'like', now - 45 * DAY);
  for (let i = 0; i < 15; i++) T.recordInteraction(p, s, post(['f1']), 'like', now - (i % 14) * DAY);
  const ds = run(p, T.newSession(), [post(['f1']), post(['hollow knight']), post(['f1']), post(['hollow knight'])]);
  assert.deepEqual(ds.map((d) => d.action), ['show', 'show', 'show', 'show']);
  const [top] = T.topInterests(p, now);
  assert.ok(['hollow knight', 'f1'].includes(top.tag));
});

test('4. commentary and meta tags carry no weight and never collapse', () => {
  assert.deepEqual(T.cleanTags(['#i am literally screaming right now', '#mine', '#queued', '#sob', '#Black Holes', '#sobriety']), ['black hole', 'sobriety']);
  const p = T.emptyProfile();
  const s = T.newSession();
  T.recordInteraction(p, s, post(['i am literally screaming right now']), 'like', now);
  assert.equal(Object.keys(p.tags).length, 0);
  const ds = run(p, s, Array.from({ length: 6 }, () => post(['i am literally screaming right now'])));
  assert.ok(ds.every((d) => d.action === 'show'));
});

test('5. NPMI co-occurrence groups #black holes and #astrophysics under #space', () => {
  const p = T.emptyProfile();
  const s = T.newSession();
  for (let i = 0; i < 8; i++) T.observe(p, post(['black holes', 'space']), now);
  for (let i = 0; i < 6; i++) T.observe(p, post(['astrophysics', 'space']), now);
  for (let i = 0; i < 30; i++) T.observe(p, post([`topic ${i}`, `other ${i}`]), now);
  T.recluster(p);
  assert.equal(p.map['black hole'], 'space');
  assert.equal(p.map['astrophysics'], 'space');
  for (let i = 0; i < 3; i++) T.recordInteraction(p, s, post(['black holes']), 'like', now);
  assert.deepEqual(T.clustersOf(p, post(['astrophysics']), now), ['space']);
  assert.equal(T.topInterests(p, now)[0].tag, 'space');
});

test('6. quiet mutual beats a high-volume blog you rarely like', () => {
  const p = T.emptyProfile();
  const s = T.newSession();
  const start = now - 14 * DAY;
  for (let i = 0; i < 4; i++) {
    const x = post([], 'quiet-friend');
    T.observe(p, x, start + i * 3.5 * DAY);
    T.recordInteraction(p, s, x, 'like', start + i * 3.5 * DAY);
  }
  for (let i = 0; i < 200; i++) {
    const x = post([], 'spammy-reblogger');
    T.observe(p, x, start + i * 0.07 * DAY);
    if (i % 33 === 0) T.recordInteraction(p, s, x, 'like', start + i * 0.07 * DAY);
  }
  const quiet = T.tieStrength(p, 'quiet-friend', [], now);
  const spam = T.tieStrength(p, 'spammy-reblogger', [], now);
  assert.ok(quiet >= T.P.TIE && spam < T.P.TIE, `quiet ${quiet.toFixed(2)} spam ${spam.toFixed(2)}`);
  assert.deepEqual(T.favorites(p, [], now), ['quiet-friend']);
});

test('7. a pinned mutual is never quota-collapsed, but a 5-post burst is damped', () => {
  const p = T.emptyProfile();
  const s = T.newSession();
  const ao3 = run(p, s, Array.from({ length: 4 }, () => post(['ao3'])));
  const full = ao3.filter((d) => d.action === 'collapse').length;
  assert.ok(full >= 1);
  const bestie = run(p, s, Array.from({ length: 5 }, () => post(['ao3'], 'bestie')), ['bestie']);
  assert.deepEqual(bestie.map((d) => d.action), ['favorite', 'favorite', 'favorite', 'collapse', 'collapse']);
  assert.match(bestie[3].reason, /@bestie used 3\/2 recent author slots/);
});

test('8. reblogs of an already-seen post collapse, unless from a mutual', () => {
  const p = T.emptyProfile();
  const s = T.newSession();
  const [a, b, c] = run(p, s, [post(['x'], 'origin', { root: 'r1' }), post(['x'], 'random', { root: 'r1' }), post(['x'], 'bestie', { root: 'r1' })], ['bestie']);
  assert.equal(a.action, 'show');
  assert.equal(b.action, 'collapse');
  assert.match(b.reason, /already saw/);
  assert.equal(c.action, 'favorite');
});

test('9. a post with one full topic and one open topic is shown (multi-topic rescue)', () => {
  const p = T.emptyProfile();
  const s = T.newSession();
  for (let i = 0; i < 3; i++) T.recordInteraction(p, s, post(['oil painting']), 'like', now - DAY);
  const marvel = run(p, s, Array.from({ length: 6 }, () => post(['marvel'])));
  assert.equal(marvel.at(-1).action, 'collapse');
  const [mixed] = run(p, s, [post(['marvel', 'oil painting'])]);
  assert.equal(mixed.action, 'show');
  assert.match(mixed.reason, /#oil painting/);
});

test('10. fast-skipping a topic cools it down for the session', () => {
  const p = T.emptyProfile();
  const s = T.newSession();
  for (let i = 0; i < 30; i++) T.recordInteraction(p, s, post(['anime']), 'like', now - 3 * DAY);
  T.recordInteraction(p, s, post(['cats']), 'like', now - 3 * DAY);
  const before = T.quotaFn(p, now)('anime');
  for (let i = 0; i < 3; i++) T.recordInteraction(p, s, post(['anime']), 'skip', now);
  const after = T.quotaFn(p, now)('anime');
  assert.ok(after < before, `quota ${before} -> ${after}`);
  assert.ok(T.quotaFn(p, now + 3 * 60 * 6e4)('anime') === before, 'debt wears off after a few hours');
});

test('11. one exploration slot in ten rescues a novel topic', () => {
  const p = T.emptyProfile();
  const s = T.newSession();
  s.shown = 9; // next shown post is the 10th
  run(p, s, [post(['new thing']), post(['new thing'])]); // both topic slots used
  s.shown = 9;
  const [d] = run(p, s, [post(['new thing'])]);
  assert.equal(d.action, 'explore');
  assert.match(d.reason, /fresh pick: exploring #new thing/);
});

test('every decision explains itself in one line', () => {
  const ds = run(T.emptyProfile(), T.newSession(), Array.from({ length: 30 }, (_, i) => post([`t${i % 4}`, 'shared'], `b${i % 7}`)));
  for (const d of ds) assert.ok(d.reason && !d.reason.includes('\n') && !/undefined|NaN/.test(d.reason), d.reason);
});

test('12. mute list: blogs anywhere in the trail, exact tags, whole phrases', () => {
  const rules = T.parseMutes('@spoilerbot\n#visionquest spoilers, ship wars, c++');
  assert.equal(T.mutedBy(rules, { blog: 'a', trail: ['spoilerbot'], tags: [], text: '' }), '@spoilerbot');
  assert.equal(T.mutedBy(rules, { blog: 'a', tags: ['#VisionQuest Spoilers'], text: '' }), '#visionquest spoilers');
  assert.equal(T.mutedBy(rules, { blog: 'a', tags: [], text: 'no more ship wars please' }), '"ship wars"');
  assert.equal(T.mutedBy(rules, { blog: 'a', tags: [], text: 'shipwars' }), null);
  assert.equal(T.mutedBy(rules, { blog: 'a', tags: [], text: 'i love c++ a lot' }), '"c++"');
  assert.equal(T.mutedBy(T.parseMutes(''), { blog: 'a', tags: ['x'], text: 'x' }), null);
});

test('13. sentence-like tags ("#his baby!") never become topics', () => {
  assert.deepEqual(T.cleanTags(['#his baby!', '#so true', '#oh no', '#marvel']), ['marvel']);
});

test('14. the discovery slot waits for a novel post instead of needing an exact count', () => {
  const p = T.emptyProfile();
  const s = T.newSession();
  s.shown = 13; // past the 10th post, no novel post came along yet
  run(p, s, [post(['new thing']), post(['new thing'])]);
  const [d, again] = run(p, s, [post(['new thing']), post(['new thing'])]);
  assert.equal(d.action, 'explore');
  assert.equal(again.action, 'collapse', 'one discovery slot, not one per post');
});

test('15. a skip counts once per topic, however many tags the post has', () => {
  const p = T.emptyProfile();
  const s = T.newSession();
  p.map = { 'black hole': 'space', nebula: 'space', astronomy: 'space' };
  T.recordInteraction(p, s, post(['space', 'black holes', 'nebula', 'astronomy']), 'skip', now);
  const one = T.emptyProfile();
  T.recordInteraction(one, s, post(['space']), 'skip', now);
  assert.equal(p.debt.space.d, one.debt.space.d);
});

test('16. "less like this" cools a topic harder than a skip and fades its recent interest', () => {
  const p = T.emptyProfile();
  const s = T.newSession();
  for (let i = 0; i < 5; i++) T.recordInteraction(p, s, post(['anime']), 'like', now - DAY);
  const f = p.tags.anime.f;
  T.recordInteraction(p, s, post(['anime']), 'hide', now);
  assert.ok(p.debt.anime.d > 0.65 && p.tags.anime.f < f);
});

test('17. reading posts (dwell) never makes a blog a favorite on its own', () => {
  const p = T.emptyProfile();
  const s = T.newSession();
  for (let i = 0; i < 20; i++) {
    const x = post(['art'], 'reader');
    T.observe(p, x, now);
    T.recordInteraction(p, s, x, 'dwell', now);
  }
  assert.deepEqual(T.favorites(p, [], now), []);
  assert.ok(T.topInterests(p, now)[0].tag === 'art');
  assert.ok(!(p.boost.art > now), 'reading is not a new obsession');
});
