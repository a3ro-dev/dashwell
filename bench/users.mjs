// Synthetic users: hidden true interests, true utility of a post, and how the user reacts to it.
import { makeRng } from './world.mjs';

export const PERSONAS = ['narrow', 'generalist', 'mutuals', 'drifter', 'hater'];
const START = Date.UTC(2026, 10, 1);
const DAY = 864e5;
const SESSIONS = 20; // over 14 days
const DAYS = 14;
export const DRIFT_AT = 10;

export function makeUser(world, persona, idx, seed) {
  const r = makeRng(`${seed}:user:${persona}:${idx}`);
  const base = () => world.topics.map(() => 0.03 + r() * 0.04);
  const set = (arr, ids, lo, hi) => ids.forEach((i) => (arr[i] = lo + r() * (hi - lo)));
  const hated = persona === 'hater' ? world.popular : null; // the topic everyone follows, and this user can't stand
  const ids = r.shuffle(world.topics.map((t) => t.id)).filter((id) => id !== hated);
  const normal = world.blogs.filter((b) => b.kind === 'normal');
  const firehose = world.blogs.filter((b) => b.kind === 'firehose');

  const before = base();
  let after = before;
  let liked, newTopics = [];
  if (persona === 'narrow') (set(before, ids.slice(0, 2), 0.9, 1), set(before, ids.slice(2, 5), 0.45, 0.6), (liked = ids.slice(0, 5)));
  if (persona === 'generalist') (set(before, ids.slice(0, 28), 0.35, 0.8), (liked = ids.slice(0, 12)));
  if (persona === 'mutuals') (set(before, ids.slice(0, 6), 0.4, 0.8), (liked = ids.slice(0, 6)));
  if (persona === 'hater') (set(before, ids.slice(0, 24), 0.3, 0.8), (before[hated] = 0), (liked = ids.slice(0, 12)));
  if (persona === 'drifter') {
    set(before, ids.slice(0, 4), 0.85, 1);
    after = [...before];
    set(after, ids.slice(0, 2), 0.05, 0.12); // two old loves fade
    set(after, ids.slice(4, 6), 0.85, 1); // two new obsessions arrive
    newTopics = ids.slice(4, 6);
    liked = ids.slice(0, 6); // they already follow blogs for the topics they will fall for
  }

  const aligned = (topicIds, k) => r.sample(normal.filter((b) => topicIds.includes(b.primary)), k);
  const mutualBlogs = persona === 'mutuals' ? r.sample(normal, 3).map((b) => ({ ...b, rate: 1 })) : [];
  const follows = [
    ...aligned(liked, 12),
    ...r.sample(normal, persona === 'generalist' ? 30 : 20),
    ...r.sample(firehose, persona === 'generalist' ? 2 : 1),
    ...(hated === null ? [] : aligned([hated], 15)),
    ...mutualBlogs,
  ];
  const sessions = Array.from({ length: SESSIONS }, (_, s) => ({
    start: START + Math.floor((s * DAYS) / SESSIONS) * DAY + (8 + r() * 15) * 36e5,
    len: 60 + r.int(91),
  })).sort((a, b) => a.start - b.start);

  return {
    persona, idx, hated, sessions,
    follows: [...new Map(follows.map((b) => [b.name, b])).values()], // mutuals override duplicates
    mutuals: new Set(mutualBlogs.map((b) => b.name)),
    newTopics: new Set(newTopics),
    interest: (topic, s) => (s >= DRIFT_AT ? after : before)[topic],
  };
}

// True value of a post to this user, 0..1. Friends' posts are loved whatever the topic.
export function utility(user, post, s) {
  const t = user.interest(post.topic, s);
  const a = user.mutuals.has(post.view.blog) ? 0.9 : 0;
  let u = 1 - (1 - t) * (1 - a);
  if (post.kind === 'spam') u *= 0.15;
  if (post.dup) u *= 0.4; // the same post again is worth little
  return Math.min(1, Math.max(0, u + post.q));
}

// What the user would do with the post if they saw it. `x` is six pre-drawn uniforms, so every
// policy (engine, baseline, oracle) meets exactly the same user.
export function react(user, post, x) {
  const u = post.u;
  const hide = x[1] < (post.topic === user.hated ? 0.2 : post.kind === 'spam' ? 0.04 : 0);
  const skip = !hide && x[0] < 0.6 * (1 - u) ** 2; // fast flick past
  const read = !hide && !skip;
  return {
    hide, skip,
    dwell: read && x[2] < 0.7 * u,
    like: read && x[3] < 0.6 * u ** 1.5,
    reblog: read && x[4] < 0.3 * u ** 2.5,
    expand: x[5] < 0.03 + 0.6 * u ** 2, // would press Show on a folded post
  };
}
