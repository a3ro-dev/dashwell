// Offline benchmark for the Dashwell feed engine.
//   node bench/sim.mjs [--seed N] [--json out.json] [--engine path/to/feed.js]
import { pathToFileURL } from 'node:url';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { makeWorld, makeFeed, makeRng } from './world.mjs';
import { PERSONAS, DRIFT_AT, makeUser, utility, react } from './users.mjs';

const USERS_PER_PERSONA = 3;
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const seed = Number(arg('seed', 1));
const enginePath = resolve(arg('engine', resolve(dirname(fileURLToPath(import.meta.url)), '../extension/feed.js')));
const jsonOut = arg('json', null);

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const quantile = (xs, q) => [...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))];
const gini = (counts) => {
  const xs = [...counts].sort((a, b) => a - b);
  const sum = xs.reduce((a, b) => a + b, 0);
  return xs.length > 1 && sum ? (2 * xs.reduce((a, x, i) => a + (i + 1) * x, 0)) / (xs.length * sum) - (xs.length + 1) / xs.length : 0;
};
// first session >= from where the 2-session rolling mean reaches thr (counted from `from`), else null
const firstAtLeast = (series, from, thr) => {
  for (let s = from; s < series.length - 1; s++) if ((series[s] + series[s + 1]) / 2 >= thr) return s - from;
  return null;
};

// The candidate stream and the user's hidden reactions: identical for every policy.
export function buildTrace(world, user) {
  const r = makeRng(`${seed}:trace:${user.persona}:${user.idx}`);
  const feed = makeFeed(world, user.follows, r);
  const trace = [];
  user.sessions.forEach((sess, s) => {
    let now = sess.start;
    for (let i = 0; i < sess.len; i++) {
      now += 3000 + r() * 12000;
      const post = feed.next();
      post.q = 0.07 * r.normal();
      post.u = utility(user, post, s);
      post.act = react(user, post, [r(), r(), r(), r(), r(), r()]);
      trace.push({ s, now, post, viewed: r() >= 0.12 });
    }
  });
  return trace;
}

// Drive the engine the way content.js does. Returns which posts it folded plus cost numbers.
// An engine that exports learnImpression also gets one label per post the user saw (shown, or folded
// then expanded), exactly as content.js sends it; flings are not modelled, so nothing is left unlabeled.
export function runEngine(T, trace, label = '', engine = T.emptyProfile()) {
  const delayed = [];
  const rand = makeRng(`${seed}:engine:${label}`);
  let session, lastS = -1, ms = 0;
  const times = [];
  const decisions = [];
  const folded = trace.map(({ s, now, post, viewed }, idx) => {
    while (delayed.length && delayed[0].at <= idx) delayed.shift().apply(now);
    if (s !== lastS) ((session = T.newSession()), (session.rand = rand), (lastS = s));
    const t0 = performance.now();
    T.observe(engine, post.view, now);
    const d = T.decide(engine, session, post.view, [], now);
    const dt = performance.now() - t0;
    ms += dt;
    times.push(dt);
    const fold = d.action === 'collapse';
    decisions.push(d);
    const a = post.act;
    const read = [a.dwell && 'dwell', a.like && 'like', a.reblog && 'reblog'].filter(Boolean);
    if (viewed && (!fold || a.expand)) {
      T.remember?.(engine, post.view.root);
      const current = session;
      const kinds = [...(fold ? ['expand'] : []), ...(a.hide ? ['hide'] : a.skip ? ['skip'] : read)];
      delayed.push({ at: idx + 3, apply(delivered) {
        for (const k of kinds) T.recordInteraction(engine, current, post.view, k, delivered);
        T.learnImpression?.(engine, current, post.view, { engaged: !!((fold && !T.remember) || a.like || a.reblog), expanded: fold, dwell: a.dwell, skip: a.skip, hide: a.hide }, delivered);
      } });
    }
    return fold;
  });
  for (const entry of delayed) entry.apply(trace.at(-1).now);
  times.sort((x, y) => x - y);
  return { folded, decisions, us: (ms * 1000) / trace.length, p95us: times[Math.floor(0.95 * (times.length - 1))] * 1000, kb: JSON.stringify(engine).length / 1024 };
}

// Fold the lowest-utility posts of each session, at the engine's overall fold rate.
function runOracle(trace, rate) {
  const folded = new Array(trace.length).fill(false);
  const bySession = new Map();
  trace.forEach((t, i) => bySession.set(t.s, [...(bySession.get(t.s) ?? []), i]));
  for (const idx of bySession.values()) {
    idx.sort((a, b) => trace[a].post.u - trace[b].post.u);
    for (const i of idx.slice(0, Math.round(rate * idx.length))) folded[i] = true;
  }
  return folded;
}

function evaluate(trace, folded, user) {
  folded = folded.filter((_, i) => trace[i].viewed);
  trace = trace.filter(t => t.viewed);
  const posts = trace.map((t) => t.post);
  const us = posts.map((p) => p.u);
  const med = quantile(us, 0.5), q75 = quantile(us, 0.75);
  const shown = trace.filter((_, i) => !folded[i]).map((t) => t.post);
  const shownSet = new Set(shown);
  const foldedPosts = trace.filter((_, i) => folded[i]).map((t) => t.post);
  const seen = trace.filter((t, i) => !folded[i] || t.post.act.expand).map((t) => t.post);
  const share = (xs, f) => (xs.length ? xs.filter(f).length / xs.length : 0);
  const liked = (p) => p.act.like || p.act.reblog;

  const sessions = [...new Set(trace.map((t) => t.s))];
  const per = sessions.map((s) => {
    const all = trace.filter((t, i) => t.s === s).map((t) => t.post);
    const sh = trace.filter((t, i) => t.s === s && !folded[i]).map((t) => t.post);
    const counts = new Map();
    for (const p of sh) counts.set(p.topic, (counts.get(p.topic) ?? 0) + 1);
    // a spam post carries a random topic in the sim; `real` leaves those out
    const real = new Set(sh.filter((p) => p.kind !== 'spam').map((p) => p.topic));
    return {
      real: real.size,
      lift: mean(sh.map((p) => p.u)) / mean(all.map((p) => p.u)),
      topics: counts.size,
      gini: gini(counts.values()),
      newShare: share(sh, (p) => user.newTopics.has(p.topic)),
    };
  });

  const m = {
    lift: mean(shown.map((p) => p.u)) / mean(us),
    first20: mean(posts.slice(0,20).filter(p => shownSet.has(p)).map(p => p.u)),
    consecutive: mean(folded.map((f,i) => Number(f && folded[i-1] && trace[i].s === trace[i-1].s))),
    prec: share(shown, (p) => p.u > med),
    recall: share(posts.filter((p) => p.u >= q75), (p) => shownSet.has(p)),
    fold: foldedPosts.length / posts.length,
    wrong: share(foldedPosts, liked),
    topics: mean(per.map((p) => p.topics)),
    real: mean(per.map((p) => p.real)),
    gini: mean(per.map((p) => p.gini)),
    mutual: user.mutuals.size ? share(posts.filter((p) => user.mutuals.has(p.view.blog)), (p) => shownSet.has(p)) : null,
    hate: user.hated === null ? null : share(shown, (p) => p.topic === user.hated),
    spam: share(shown, (p) => p.kind === 'spam'),
    fire: share(shown, (p) => p.kind === 'firehose'),
    eng: seen.filter(liked).length / seen.length,
    adapt: null,
    recov: null,
  };
  if (user.newTopics.size) {
    const eventual = mean(per.slice(-3).map((p) => p.newShare));
    m.adapt = firstAtLeast(per.map((p) => p.newShare), DRIFT_AT, 0.8 * eventual);
    const pre = mean(per.slice(DRIFT_AT - 5, DRIFT_AT).map((p) => p.lift));
    m.recov = firstAtLeast(per.map((p) => p.lift), DRIFT_AT, 0.9 * pre);
  }
  return m;
}

// Average metrics over users; a metric that is null for some personas averages over the rest.
function average(list) {
  const out = {};
  for (const k of Object.keys(list[0])) {
    const xs = list.map((m) => m[k]).filter((v) => v !== null && v !== undefined);
    out[k] = xs.length ? mean(xs) : null;
  }
  return out;
}

const COLS = [
  ['lift', 'lift', 2], ['prec', 'prec', 2], ['recall', 'recall', 2], ['fold', 'fold%', 'pct'], ['wrong', 'wrong%', 'pct'],
  ['topics', 'topics', 1], ['real', 'real', 1], ['gini', 'gini', 2], ['mutual', 'mut%', 'pct'], ['hate', 'hate%', 'pct'], ['adapt', 'adapt', 1],
  ['recov', 'recov', 1], ['spam', 'spam%', 'pct'], ['fire', 'fire%', 'pct'], ['eng', 'eng', 3], ['us', 'us', 0], ['p95', 'p95us', 0], ['kb', 'KB', 0],
];
const cell = (v, f) => (v === null || v === undefined ? '-' : f === 'pct' ? (v * 100).toFixed(1) : v.toFixed(f)).padStart(7);
const row = (label, m) => label.padEnd(18) + COLS.map(([k, , f]) => cell(m[k], f)).join('');

async function main() {
  await import(pathToFileURL(enginePath).href);
  const T = globalThis.TumblrNew;
  if (!T?.decide) throw new Error(`${enginePath} did not set globalThis.TumblrNew`);
  const legacy = (await import('./feed.v1.js'), globalThis.TumblrNew);
  const world = makeWorld(seed);
  const runs = Object.fromEntries(['baseline', 'engine', 'oracle'].map((p) => [p, Object.fromEntries(PERSONAS.map((x) => [x, []]))]));
  for (const persona of PERSONAS)
    for (let idx = 0; idx < USERS_PER_PERSONA; idx++) {
      const user = makeUser(world, persona, idx, seed);
      const trace = buildTrace(world, user);
      const eng = runEngine(T, trace, `${persona}:${idx}`);
      const rate = eng.folded.filter(Boolean).length / trace.length;
      runs.baseline[persona].push(evaluate(trace, trace.map(() => false), user));
      const profile = legacy.emptyProfile();
      runEngine(legacy, trace.filter(t => t.s < 3), 'migration', profile);
      const next = trace.filter(t => t.s === 3);
      const migrated = runEngine(T, next, 'migration', JSON.parse(JSON.stringify(profile)));
      const genuine = trace.filter(t => t.viewed && t.post.kind !== 'spam').length;
      const falseSpam = eng.decisions.filter((d,i) => trace[i].viewed && trace[i].post.kind !== 'spam' && /tag-stuffed/.test(d.reason)).length;
      runs.engine[persona].push({ falseSpam: falseSpam / genuine, migrated20: evaluate(next, migrated.folded, user).first20, ...evaluate(trace, eng.folded, user), us: eng.us, p95: eng.p95us, kb: eng.kb });
      runs.oracle[persona].push(evaluate(trace, runOracle(trace, rate), user));
    }
  const results = {};
  for (const [policy, byPersona] of Object.entries(runs)) {
    const personas = Object.fromEntries(PERSONAS.map((p) => [p, average(byPersona[p])]));
    results[policy] = { overall: average(Object.values(personas)), personas };
  }

  console.log(`dashwell feed sim  seed=${seed}  engine=${relative(process.cwd(), enginePath)}  ${USERS_PER_PERSONA} users per persona, 20 sessions each
`);
  console.log('policy'.padEnd(18) + COLS.map(([, h]) => h.padStart(7)).join(''));
  for (const policy of Object.keys(results)) console.log(row(`${policy} (all)`, results[policy].overall));
  for (const p of PERSONAS) {
    console.log('');
    for (const policy of Object.keys(results)) console.log(row(`${p}/${policy}`, results[policy].personas[p]));
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ seed, engine: relative(process.cwd(), enginePath).split('\\').join('/'), usersPerPersona: USERS_PER_PERSONA, results }, null, 2).replace(/\n/g, '\r\n') + '\r\n');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
