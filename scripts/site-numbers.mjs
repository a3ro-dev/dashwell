// Builds the data the website reads: docs/bench.json (from bench/baseline.json and bench/v2.json)
// and docs/changelog.json (from CHANGELOG.md). Run: node scripts/site-numbers.mjs
// A bench file is one sim.mjs --json run, an array of runs, or {runs: [...]}; several runs are averaged.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const write = (p, o) => writeFileSync(join(root, p), JSON.stringify(o, null, 2).replace(/\n/g, '\r\n') + '\r\n');

// sim.mjs "overall" keys -> site keys. Fractions become percent; lift and adapt stay as they are.
const KEYS = { lift: 'lift', prec: 'precision', recall: 'recall', fold: 'foldPct', wrong: 'wrongPct',
  spam: 'spamPct', mutual: 'mutualPct', hate: 'hatePct', adapt: 'adaptSessions' };
const PLAIN = new Set(['lift', 'adapt']);

const runsOf = (file) => {
  const j = JSON.parse(read(file));
  return Array.isArray(j) ? j : j.runs || [j];
};
const mean = (xs) => { xs = xs.filter((x) => typeof x === 'number'); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
const round = (x, d) => x == null ? null : Math.round(x * 10 ** d) / 10 ** d;

function pick(runs, policy, label) {
  const out = { label };
  for (const [src, dst] of Object.entries(KEYS)) {
    const m = mean(runs.map((r) => r.results[policy].overall[src]));
    out[dst] = round(PLAIN.has(src) ? m : m == null ? null : m * 100, PLAIN.has(src) ? 2 : 1);
  }
  return out;
}

const base = runsOf('bench/baseline.json');
const hasV2 = existsSync(join(root, 'bench/v2.json'));
// bench/compare.mjs writes {summary: {baseline, v1, v2, oracle}} already averaged over its seeds
const v2json = hasV2 ? JSON.parse(read('bench/v2.json')) : null;
// so every column comes from the same seeds
const sum = v2json?.summary;
const one = (engine) => [{ seed: v2json.seeds.join(','), results: { baseline: sum.baseline, engine: sum[engine], oracle: sum.oracle } }];
const v2 = sum ? one('v2') : hasV2 ? runsOf('bench/v2.json') : null;
if (sum) base.splice(0, base.length, ...one('v1'));
const seedsOf = (runs) => runs.map((r) => r.seed);

write('docs/bench.json', {
  note: 'Simulator with synthetic users and a synthetic Tumblr. It compares engines on the same posts and the same users; it does not predict your feed.',
  seeds: { v1: seedsOf(base), v2: v2 ? seedsOf(v2) : null },
  engines: {
    none: pick(base, 'baseline', 'no engine'),
    v1: pick(base, 'engine', 'v1 (1.2.0)'),
    v2: v2 ? pick(v2, 'engine', 'v2 (1.3.0)') : null,
    oracle: pick(v2 || base, 'oracle', 'oracle'),
  },
});

// CHANGELOG.md: "## 1.2.0 · 2026-11-22 · title", bullets (indented lines continue the bullet), **Group** lines.
const strip = (s) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1').replace(/\[(.+?)\]\(.+?\)/g, '$1');
const releases = [];
let cur = null, group = '';
for (const line of read('CHANGELOG.md').split('\n')) {
  const h = line.match(/^## (\d+\.\d+\.\d+) · (\d{4}-\d{2}-\d{2})(?: · (.+))?$/); // "Unreleased" doesn't match: not a release
  if (h) { cur = { version: h[1], date: h[2], title: h[3] || '', items: [] }; releases.push(cur); group = ''; continue; }
  if (/^## /.test(line)) { cur = null; continue; }
  if (!cur) continue;
  const g = line.match(/^\*\*(.+)\*\*$/);
  if (g) { group = g[1] === 'Fixes' ? 'Fix' : g[1]; continue; }
  if (line.startsWith('- ')) cur.items.push((group ? group + ': ' : '') + strip(line.slice(2)));
  else if (/^\s+\S/.test(line) && cur.items.length) cur.items[cur.items.length - 1] += ' ' + strip(line.trim());
}
write('docs/changelog.json', releases);

console.log(`docs/bench.json: v1 seeds [${seedsOf(base)}], v2 ${v2 ? `seeds [${seedsOf(v2)}]` : 'null'}; docs/changelog.json: ${releases.length} releases`);
