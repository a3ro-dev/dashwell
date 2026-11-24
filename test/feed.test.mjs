import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    const d = T.decide(p, s, x, pinned, t);
    if (d.action !== 'collapse') T.remember(p, x.root ?? x.id);
    return d;
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

// ---- v2: value model, impression labels, cross-session memory ----

const nothing = () => 0; // Thompson noise off: the same value every time
// One simulated session: decide each post, then label it the way content.js would. `react` maps a post to its label.
function session(p, posts, react, t, pinned = []) {
  const s = T.newSession();
  s.rand = nothing;
  return posts.map((x, i) => {
    const at = t + i * 1e4;
    T.observe(p, x, at);
    const d = T.decide(p, s, x, pinned, at);
    if (d.action !== 'collapse') T.remember(p, x.root ?? x.id);
    if (d.action !== 'collapse') T.learnImpression(p, s, x, react(x), at);
    return d;
  });
}
const folded = (ds) => ds.filter((d) => d.action === 'collapse');

test('18. a topic you keep skipping is folded for good, in a later session, by value', () => {
  const p = T.emptyProfile();
  const react = (x) => (x.tags.includes('hazbin hotel') ? { skip: true } : x.tags.includes('jazz') ? { engaged: true, dwell: true } : {});
  const mix = (k) => Array.from({ length: 30 }, (_, i) => post([['hazbin hotel', 'jazz', `filler ${i % 9}`][i % 3]], `b${(i * 7 + k) % 23}`));
  for (let day = 0; day < 20; day++) session(p, mix(day), react, now + day * DAY);
  assert.ok(p.m.k >= T.P.WARM + T.P.VALUE_AFTER, `warm after ${p.m.k} labels`);
  const ds = session(p, mix(21), react, now + 21 * DAY);
  const [hazbin, jazz] = [0, 1].map((o) => ds.filter((_, i) => i % 3 === o));
  assert.ok(folded(hazbin).length >= 8, `hazbin folded ${folded(hazbin).length}/10`);
  assert.ok(folded(hazbin).some((d) => /^folded: you usually pass on .*hazbin hotel/.test(d.reason)), folded(hazbin).map((d) => d.reason).join('\n'));
  assert.ok(folded(jazz).length <= 2, `jazz folded ${folded(jazz).length}/10`);
  assert.ok(folded(hazbin).every((d) => d.say && !d.reason.includes('\n')));
});

test('19. a strong match is shown past a full quota; a weak one is not', () => {
  const p = T.emptyProfile();
  const react = (x) => (x.tags.includes('jazz') ? { engaged: true, dwell: true } : { skip: true });
  const train = (k) => Array.from({ length: 30 }, (_, i) => post(i % 3 === 0 ? ['jazz'] : [`other ${i % 7}`], `b${(i * 5 + k) % 29}`));
  for (let day = 0; day < 6; day++) session(p, train(day), react, now + day * DAY);
  const ds = session(p, Array.from({ length: 8 }, () => post(['jazz'])), react, now + 7 * DAY);
  assert.ok(shownCount(ds) >= 6, ds.map((d) => d.reason).join('\n'));
  assert.ok(ds.some((d) => d.action === 'show' && /^shown: strong match \(top \d+%\) though #jazz is full/.test(d.reason)), ds.map((d) => d.reason).join('\n'));
  const weak = session(p, Array.from({ length: 8 }, () => post(['other 1'])), react, now + 7 * DAY + 1e6);
  assert.ok(folded(weak).length >= 5, 'a topic you always skip gets no such rescue');
});

test('20. learnImpression: one label trains the heads it names, hide counts triple, a bare view is a mild no', () => {
  const state = (out) => {
    const p = T.emptyProfile();
    const x = post(['art'], 'friend');
    T.observe(p, x, now);
    T.learnImpression(p, T.newSession(), x, out, now);
    return { p, rec: p.m.f['a:friend'] };
  };
  const [zE, zD, zN] = [0, 2, 4];
  const base = state({}).rec;
  assert.ok(base[zE] > 0 && base[zD] > 0 && base[zN] > 0, 'seen and ignored: nothing positive');
  assert.ok(state({ engaged: true }).rec[zE] < 0, 'engaged pulls the E head up');
  assert.ok(state({ dwell: true }).rec[zD] < 0, 'dwell pulls the D head up');
  const skip = state({ skip: true }).rec, hide = state({ hide: true }).rec;
  assert.ok(skip[zN] < 0 && hide[zN] < skip[zN] * 2.5, `hide ${hide[zN]} vs skip ${skip[zN]}`);
  assert.ok(Math.abs(state({ engaged: true, expanded: true }).rec[zE]) < Math.abs(state({ engaged: true }).rec[zE]), 'an expanded fold is a softer yes');
  const { p } = state({ engaged: true });
  assert.equal(p.m.k, 1);
  assert.equal(p.blogs.friend.sh, 1, 'shown posts, not folded ones, count toward a blog');
  const once = JSON.stringify(p.m.f);
  T.decide(p, T.newSession(), post(['art'], 'friend'), [], now); // deciding alone never trains
  assert.equal(JSON.stringify(p.m.f), once);
});

test('21. reblogs of posts you were shown are collapsed in later sessions too', () => {
  const p = T.emptyProfile();
  const [first] = session(p, [post(['x'], 'origin', { root: 'r9' })], () => ({}), now);
  assert.equal(first.action, 'show');
  const stored = JSON.parse(JSON.stringify(p)); // what chrome.storage hands back next time
  const s2 = T.newSession();
  s2.rand = nothing;
  const again = post(['x'], 'random', { root: 'r9' });
  T.observe(stored, again, now + DAY);
  const d = T.decide(stored, s2, again, [], now + DAY);
  assert.equal(d.action, 'collapse');
  assert.match(d.reason, /already saw/);
  const friend = post(['x'], 'bestie', { root: 'r9' });
  T.observe(stored, friend, now + DAY);
  assert.equal(T.decide(stored, s2, friend, ['bestie'], now + DAY).action, 'favorite');
  for (let i = 0; i < T.P.MAX_ROOTS + 50; i++) T.remember(stored, 'root' + i);
  assert.ok(stored.rr.length <= T.P.MAX_ROOTS, `${stored.rr.length} roots remembered`);
});

test('22. a real v1 profile from storage keeps working, and the model starts cold on it', () => {
  const v1 = JSON.parse(readFileSync(new URL('./fixtures/v1-profile.json', import.meta.url), 'utf8'));
  assert.ok(!('m' in v1) && !('rr' in v1) && v1.n > 400);
  const when = 1793729993589.9956 + 3e5; // shortly after the last post in the fixture
  assert.deepEqual(T.favorites(v1, [], when), ['mossyarchive', 'rusttea'], 'friends survive the upgrade');
  assert.ok(T.topInterests(v1, when).length > 3);
  const tags = Object.keys(v1.tags).length;
  const ds = session(v1, Array.from({ length: 40 }, (_, i) => post([`t${i % 5}`, 'shared'], `b${i % 11}`)), (x) => ({ engaged: x.tags[0] === 't1' }), when);
  assert.ok(v1.m && v1.rr && v1.m.k > 0 && v1.m.k < T.P.WARM, 'model created cold');
  assert.ok(Object.keys(v1.tags).length >= tags, 'v1 statistics are kept');
  for (const d of ds) assert.ok(d.reason && !d.reason.includes('\n') && !/undefined|NaN/.test(d.reason), d.reason);
  const back = JSON.parse(JSON.stringify(v1));
  assert.ok(T.decide(back, T.newSession(), post(['t1'], 'b1'), [], when + 1e6).action);
  T.recordInteraction(back, T.newSession(), post(['t1'], 'b1'), 'hide', when + 1e6); // v1-era calls keep working
  assert.ok(Object.values(back.hid).some((h) => h[0] > 0) && T.quotaFn(back, when + 1e6)('t1') >= 0);
});

test('23. the stored profile stays bounded for a heavy long-tail user', () => {
  const p = T.emptyProfile();
  let a = 1;
  const rnd = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
  const tail = (n) => Math.min(n - 1, Math.floor(n ** rnd() - 1));
  let s = T.newSession();
  s.rand = rnd;
  for (let i = 0; i < 6000; i++) {
    const at = now + (i / 200) * DAY;
    if (i % 100 === 0) ((s = T.newSession()), (s.rand = rnd));
    const x = { id: `q${i}`, blog: `blog${tail(3000)}`, tags: Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => `tag ${tail(4000)}`), text: 'x', trail: rnd() < 0.3 ? [`blog${tail(3000)}`] : [], root: String(1700000000000000000n + BigInt(tail(100000)) * 123457n) };
    T.observe(p, x, at);
    const d = T.decide(p, s, x, [], at);
    if (d.action !== 'collapse' || rnd() < 0.2) T.learnImpression(p, s, x, { engaged: rnd() < 0.1, dwell: rnd() < 0.2, skip: rnd() < 0.3 }, at);
    if (rnd() < 0.05) T.recordInteraction(p, s, x, 'like', at);
  }
  const kb = JSON.stringify(p).length / 1024;
  assert.ok(kb < 400, `${kb.toFixed(0)} KB`);
  assert.ok(Object.keys(p.m.f).length <= T.P.MAX_FEATS + 20, `${Object.keys(p.m.f).length} features`);
  assert.ok(p.rr.length <= T.P.MAX_ROOTS && Object.keys(p.blogs).length <= T.P.MAX_BLOGS + T.P.RECLUSTER_EVERY && Object.keys(p.pairs).length <= T.P.MAX_PAIRS + 2000);
  assert.ok('b' in p.m.f, 'the bias is never evicted');
});

test('24. well-known tags from unrelated topics stuffed into one post are tag spam; new tags are not', () => {
  const p = T.emptyProfile();
  const s = T.newSession();
  const topics = [['space', 'nebula'], ['cats', 'kitten'], ['marvel', 'mcu'], ['baking', 'bread'], ['chess', 'openings']];
  for (let i = 0; i < 40; i++) run(p, s, topics.map((t, j) => post(t, `b${j}_${i % 9}`)));
  const campaign = { destination: 'https://prints.example/shop' };
  const [first, spam] = run(p, T.newSession(), [
    post(['space', 'cats', 'marvel', 'baking', 'chess'], 'spammer', campaign),
    post(['space', 'cats'], 'spammer', campaign),
  ]);
  assert.doesNotMatch(first.reason, /tag-stuffed/);
  assert.equal(spam.action, 'collapse');
  assert.match(spam.reason, /tag-stuffed/);
  const [ok] = run(p, T.newSession(), [post(['space', 'nebula'], 'honest')]);
  assert.notEqual(ok.action, 'collapse');
  // seen live on Tumblr: a coherent post whose tags are just new to us is not spam
  const [fandom] = run(p, T.newSession(), [post(['visionquest', 'marvel', 'wandavision', 'wanda maximoff', 'vision marvel', 'tommy maximoff'], 'fan')]);
  assert.doesNotMatch(fandom.reason, /tag-stuffed/);
});

test('25. "less like this" outlasts the session: the topic gets no slots for weeks, a pinned blog still passes', () => {
  const p = T.emptyProfile();
  const s = T.newSession();
  for (let i = 0; i < 12; i++) T.observe(p, post(['anime'], `b${i}`), now);
  T.recordInteraction(p, s, post(['anime']), 'hide', now);
  T.recordInteraction(p, s, post(['anime']), 'hide', now);
  const later = now + 7 * DAY;
  assert.equal(T.quotaFn(p, later)('anime'), 0);
  const [d] = run(p, T.newSession(), [post(['anime'], 'someone')], [], later);
  assert.equal(d.action, 'collapse');
  assert.match(d.reason, /you asked for less #anime/);
  const [pin] = run(p, T.newSession(), [post(['anime'], 'bestie')], ['bestie'], later);
  assert.equal(pin.action, 'favorite');
  assert.ok(T.quotaFn(p, now + 90 * DAY)('anime') > 0, 'and it fades');
});

test('26. a value-folded topic gets a rare second chance, but not one you asked for less of', () => {
  const p = T.emptyProfile();
  const react = (x) => (x.tags.includes('hazbin hotel') ? { skip: true } : x.tags.includes('jazz') ? { engaged: true, dwell: true } : {});
  const mix = (k) => Array.from({ length: 30 }, (_, i) => post([['hazbin hotel', 'jazz', `filler ${i % 9}`][i % 3]], `b${(i * 7 + k) % 23}`));
  for (let day = 0; day < 20; day++) session(p, mix(day), react, now + day * DAY);
  const long = [21, 22, 23, 24, 25].flatMap(mix);
  const hazbin = session(p, long, react, now + 21 * DAY).filter((_, i) => i % 3 === 0);
  const chances = hazbin.filter((d) => d.reason.startsWith('second chance'));
  assert.ok(chances.length >= 1 && chances.length <= 3, `second chances ${chances.length}/${hazbin.length}`);
  assert.ok(folded(hazbin).length >= hazbin.length * 0.75, `still mostly folded: ${folded(hazbin).length}/${hazbin.length}`);
  // after "less like this", no second chances for it
  for (let i = 0; i < 3; i++) T.recordInteraction(p, T.newSession(), post(['hazbin hotel']), 'hide', now + 26 * DAY);
  const after = session(p, [26, 27, 28, 29, 30].flatMap(mix), react, now + 26 * DAY).filter((_, i) => i % 3 === 0);
  assert.equal(after.filter((d) => d.reason.startsWith('second chance')).length, 0);
});

test('preloading does not mark a root seen and JSON profiles accept inherited names', () => {
  const p = JSON.parse(JSON.stringify(T.emptyProfile()));
  const x = post(['constructor'], 'constructor');
  T.observe(p, x, now);
  T.decide(p, T.newSession(), x, [], now);
  assert.deepEqual(p.rr, []);
  assert.equal(p.tags.constructor.n, 1);
  assert.equal(p.blogs.constructor.seen, 1);
});

test('older learned model retains its weights on migration', () => {
  const p = JSON.parse(readFileSync(new URL('./fixtures/v13-profile.json', import.meta.url)));
  const k = p.m.k;
  T.observe(p, post(['girlblog', 'girl blogging', 'autumn aesthetic']), now);
  assert.equal(p.m.k, k);
  assert.ok(p.rr.includes('old'));
});

test('repeated shop links on coherent tag sets do not trigger spam folds', () => {
  for (const tags of [
    ['visionquest', 'marvel', 'wandavision', 'wanda maximoff'],
    ['girlblog', 'girl blogging', 'girl diary', 'digital diary'],
    ['fall aesthetic', 'autumn', 'cozy autumn', 'fall leaves'],
  ]) {
    const p = T.emptyProfile();
    for (let i = 0; i < 150; i++) {
      const x = post(tags, 'artist', { destination: 'https://prints.example/shop', body: 'Autumn prints' });
      const [d] = run(p, T.newSession(), [x]);
      assert.doesNotMatch(d.reason, /tag-stuffed/);
    }
  }
});
