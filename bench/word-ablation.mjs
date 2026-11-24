// Offline candidate feature experiment. Run sim.mjs with --engine bench/word-ablation.mjs.
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';

const source = readFileSync(new URL('../extension/feed.js', import.meta.url), 'utf8');
const marker = '    const len = post.text';
if (!source.includes(marker)) throw new Error('Update word ablation for the current feature extractor');
const words = `    if (nt <= 2) {
      for (const word of [...new Set((post.body ?? '').toLowerCase().match(/[a-z]{4,}/g) ?? [])].slice(0, 12)) {
        k.push('w:' + word);
        x.push(0.3);
      }
    }
`;
runInThisContext(source.replace(marker, words + marker));
