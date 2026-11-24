// v1 vs v2 on several seeds: node bench/compare.mjs [--seeds 1,7,42]   writes bench/v2.json, prints the tables
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const i = process.argv.indexOf('--seeds');
const seeds = (i > 0 ? process.argv[i + 1] : '1,7,42,5,99').split(',').map(Number);
const ENGINES = { v1: join(dir, 'feed.v1.js'), v13: join(dir, 'feed.v13.js'), v2: join(dir, '../extension/feed.js') };
// target, direction: [metric, op, limit, label]
const TARGETS = [['lift', '>=', 1.4], ['recall', '>=', 0.72], ['wrong', '<=', 0.035], ['spam', '<=', 0.05], ['mutual', '>=', 0.93], ['hate', '<=', 0.09], ['adapt', '<=', 1.7], ['recov', '<=', 2.7], ['topics', '>=', 22], ['p95', '<', 1000], ['kb', '<=', 400]];
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const runs = {};
for (const [name, path] of Object.entries(ENGINES)) {
  runs[name] = seeds.map((seed) => {
    const out = join(dir, `.tmp-${name}-${seed}.json`);
    execFileSync('node', [join(dir, 'sim.mjs'), '--seed', seed, '--engine', path, '--json', out], { stdio: 'ignore' });
    const r = JSON.parse(readFileSync(out, 'utf8'));
    unlinkSync(out);
    return r.results;
  });
}
const avg = (rs, pick) => {
  const keys = Object.keys(pick(rs[0]));
  return Object.fromEntries(keys.map((k) => [k, mean(rs.map((r) => pick(r)[k]).filter((v) => v != null))]));
};
const personas = Object.keys(runs.v2[0].engine.personas);
const summary = {};
for (const name of Object.keys(ENGINES))
  summary[name] = {
    overall: avg(runs[name], (r) => r.engine.overall),
    perSeed: Object.fromEntries(seeds.map((s, k) => [s, runs[name][k].engine.overall])),
    personas: Object.fromEntries(personas.map((p) => [p, avg(runs[name], (r) => r.engine.personas[p])])),
  };
summary.baseline = { overall: avg(runs.v2, (r) => r.baseline.overall), perSeed: Object.fromEntries(seeds.map((s,i) => [s, runs.v2[i].baseline.overall])) };
summary.oracle = { overall: avg(runs.v2, (r) => r.oracle.overall) };
const ok = (m, op, lim, v) => (op === '>=' ? v >= lim : op === '<=' ? v <= lim : v < lim);
const targets = TARGETS.map(([m, op, lim]) => ({ metric: m, op, limit: lim, v1: summary.v1.overall[m], v2: summary.v2.overall[m], pass: ok(m, op, lim, summary.v2.overall[m]), perSeedPass: seeds.every((s) => ok(m, op, lim, summary.v2.perSeed[s][m])) }));
writeFileSync(join(dir, 'v2.json'), JSON.stringify({ seeds, usersPerPersona: 3, summary, targets }, null, 2).replace(/\n/g, '\r\n') + '\r\n');

const COLS = [['lift', 'lift', 2], ['prec', 'prec', 2], ['recall', 'recall', 2], ['fold', 'fold%', 'p'], ['wrong', 'wrong%', 'p'], ['topics', 'topics', 1], ['real', 'real', 1], ['gini', 'gini', 2], ['mutual', 'mut%', 'p'], ['hate', 'hate%', 'p'], ['adapt', 'adapt', 1], ['recov', 'recov', 1], ['spam', 'spam%', 'p'], ['fire', 'fire%', 'p'], ['eng', 'eng', 3], ['us', 'us', 0], ['p95', 'p95us', 0], ['kb', 'KB', 0]];
const f = (v, d) => (v == null ? '-' : d === 'p' ? (v * 100).toFixed(1) : v.toFixed(d)).padStart(7);
const row = (label, m) => label.padEnd(20) + COLS.map(([k, , d]) => f(m[k], d)).join('');
console.log(`seeds ${seeds.join(', ')}, ${3} users per persona, mean over seeds\n`);
console.log('policy'.padEnd(20) + COLS.map(([, h]) => h.padStart(7)).join(''));
for (const [label, m] of [['baseline (no engine)', summary.baseline.overall], ['1.2.0', summary.v1.overall], ['1.3.0', summary.v13.overall], ['1.3.1', summary.v2.overall], ['oracle (v2 rate)', summary.oracle.overall]]) console.log(row(label, m));
for (const s of seeds) console.log(row(`  v2 seed ${s}`, summary.v2.perSeed[s]));
for (const p of personas) {
  console.log('');
  console.log(row(`${p}/v1`, summary.v1.personas[p]));
  console.log(row(`${p}/v2`, summary.v2.personas[p]));
}
console.log('\ntargets (v2, mean over seeds; "all seeds" = every seed passes alone)');
for (const t of targets) console.log(`${t.pass ? 'PASS' : 'FAIL'}  ${t.metric.padEnd(7)} ${t.op} ${String(t.limit).padEnd(6)} v1 ${t.v1?.toFixed(3).padStart(8)}  v2 ${t.v2?.toFixed(3).padStart(8)}  ${t.perSeedPass ? 'all seeds' : 'not every seed'}`);
