import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../extension/feed.js';

const T = globalThis.TumblrNew;
const DAY = 864e5;
const now = Date.UTC(2026, 10, 17);
let n = 0;
const post = (tags, blog = `blog${n++}`) => ({ tags, blog });

function history() {
  // months of varied likes, then ONE fresh black-holes like
  const p = T.emptyProfile();
  for (let d = 90; d > 0; d -= 3) {
    T.recordInteraction(p, post(['art', 'illustration']), 1, now - d * DAY);
    T.recordInteraction(p, post(['books']), 1, now - d * DAY);
    T.recordInteraction(p, post(['cats']), 1, now - d * DAY);
  }
  T.recordInteraction(p, post(['black holes', 'space']), 1, now);
  return p;
}

test('one like does not flood the feed with that topic', () => {
  const p = history();
  const recent = [];
  const actions = Array.from({ length: 6 }, () => T.decide(p, [], recent, post(['black holes']), now).action);
  assert.deepEqual(actions, ['show', 'show', 'collapse', 'collapse', 'collapse', 'collapse']);
});

test('long-term interests get more room than a one-off like', () => {
  const p = history();
  const recent = [];
  const shown = Array.from({ length: 12 }, () => T.decide(p, [], recent, post(['cats']), now).action).filter((a) => a !== 'collapse');
  assert.ok(shown.length > 2, `cats shown ${shown.length}`);
});

test('favorite blogs are never collapsed, and are learned from interactions', () => {
  const p = history();
  for (let i = 0; i < 4; i++) T.recordInteraction(p, post(['black holes'], 'mutual'), 1, now);
  const recent = [];
  const actions = Array.from({ length: 6 }, () => T.decide(p, [], recent, post(['black holes'], 'mutual'), now).action);
  assert.ok(actions.every((a) => a === 'favorite'));
  assert.ok(T.favorites(p, ['pinnedblog'], now).includes('mutual'));
  assert.equal(T.favorites(p, ['pinnedblog'], now)[0], 'pinnedblog');
});

test('interest decays but is not forgotten', () => {
  const p = T.emptyProfile();
  T.recordInteraction(p, post(['old love']), 1, now - 60 * DAY);
  const [top] = T.topInterests(p, now);
  assert.equal(top.tag, 'old love');
  assert.ok(top.score > 0 && top.score < Math.log1p(1));
});

test('a 30-tag post counts as one interaction, not thirty', () => {
  const p = T.emptyProfile();
  T.recordInteraction(p, post(Array.from({ length: 30 }, (_, i) => `t${i}`)), 1, now);
  const total = Object.values(p.tags).reduce((s, e) => s + e.w, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test('posts without tags are always shown', () => {
  const recent = [];
  for (let i = 0; i < 20; i++) assert.equal(T.decide(T.emptyProfile(), [], recent, post([]), now).action, 'show');
});
