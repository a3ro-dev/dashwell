import assert from 'node:assert/strict';
import { tumblrPosts } from './tumblr-data.mjs';
const posts = tumblrPosts();
async function check(path) {
  await import(path);
  const T = globalThis.TumblrNew, profile = T.emptyProfile(), session = T.newSession();
  let removed = 0, raw = 0, folded = 0, mismatch = 0, signal = 0;
  session.rand = () => 0.5;
  for (const post of posts) {
    raw += post.tags.length;
    removed += post.tags.length - T.cleanTags(post.tags).length;
    mismatch += post.numTags !== post.tags.length;
    signal += Number(Boolean(post.destination || /\\b(shop|buy|sale|order|promo)\\b/i.test(post.body)));
    T.observe(profile, post, post.now);
    const d = T.decide(profile, session, post, [], post.now);
    if (d.reason.includes('tag-stuffed')) folded++;
    if (d.action !== 'collapse') T.remember?.(profile, post.id);
  }
  const vocabulary = new Set(posts.flatMap(p => p.tags.map(t => t.toLowerCase())));
  for (const t of ['personal','my life','i love this','lol']) {
    assert.ok(vocabulary.has(t));
    assert.deepEqual(T.cleanTags([t]),[]);
  }
  if (T.audit) for (const t of ['rant','important']) assert.equal(profile.tags[t]?.g,1);
  assert.equal(mismatch,0);
  return {posts:posts.length, raw, removedOrMerged:removed, mismatch, signal, genericTags:Object.values(profile.tags).filter(s => s.g).length, spamFolds:folded};
}
const output = {};
for (const [name,path] of [['1.2.0','./feed.v1.js'],['1.3.0','./feed.v13.js'],['1.3.1','../extension/feed.js']])
  output[name] = await check(path);
console.log(JSON.stringify(output,null,2));
