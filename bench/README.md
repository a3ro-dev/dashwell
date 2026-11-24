# Dashwell feed benchmark

Run `node bench/compare.mjs` to compare the frozen 1.2.0 and 1.3.0 engines with the working engine. The default seeds are 1, 7, 42, 5 and 99. Seeds 5 and 99 serve as held-out checks. Detailed per-seed and per-persona results are in [v2.json](v2.json). The comparison uses three users per persona and twenty sessions per user.

The generator samples a heavy-tailed stream of blogs, reblogs and topic tags. Spam accounts mix familiar tags, ordinary creators sometimes promote their shops, and promotions can repeat across distinct roots. Some posts have a single tag or none. Body text comes from a small set of templates. There is no unique spam marker.

Twelve percent of candidates are preload-only. Every policy decides on those candidates, but their posts receive no feedback and do not enter the quality metrics. Show uses a fixed curiosity rate per user (3%, 4.5% or 6%). Labels arrive three candidates later. The frozen engines receive their historical expansion signal. The working engine learns from subsequent reading or actions. Flings, actual DOM behavior and the overhead of storage and shadow reporting are outside this simulation.

## Five-seed results

Lift divides the mean utility of initially shown posts by the mean utility of all viewed candidates. Recall measures the fraction of the highest-utility quarter shown by default. Spam measures the share of initially shown posts from simulated spam blogs. Adjacent folds measure the fraction of viewed candidates that are folded immediately after another fold in the same session. Wrong measures how often a simulated user would have liked or reblogged a folded post. These are predictions for synthetic users.

| Policy | Lift | Recall | Spam | Fold | Adjacent folds | Wrong | Fresh first 20 | Migrated first 20 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| No engine | 1.000 | 100.00% | 5.28% | 0.00% | 0.00% | 0.00% | 0.2233 | - |
| 1.2.0 | 1.114 | 60.41% | 9.25% | 45.69% | 22.79% | 6.74% | 0.2457 | 0.2021 |
| 1.3.0 | 1.382 | 79.71% | 8.71% | 44.41% | 20.54% | 2.85% | 0.2455 | 0.2028 |
| 1.3.1 | 1.364 | 81.79% | 4.10% | 42.35% | 18.58% | 2.62% | 0.2406 | 0.2024 |

First-20 columns give mean utility among initially shown posts within the first 20 viewed candidates. The migration probe trains a separate 1.2.0 profile on the first three sessions of the same user, round-trips it through JSON, and measures the following session. The fresh and migrated columns use different streams. Compare versions within a column.

| Seed | No-engine spam | 1.2.0 lift / spam | 1.3.0 lift / spam | 1.3.1 lift / spam |
|---:|---:|---:|---:|---:|
| 1 | 4.81% | 1.160 / 8.46% | 1.395 / 8.34% | 1.366 / 3.95% |
| 7 | 5.00% | 1.110 / 8.46% | 1.380 / 8.16% | 1.355 / 3.87% |
| 42 | 5.20% | 1.092 / 9.05% | 1.374 / 8.16% | 1.357 / 4.19% |
| 5 | 5.19% | 1.087 / 9.41% | 1.360 / 8.70% | 1.348 / 3.99% |
| 99 | 6.19% | 1.120 / 10.87% | 1.400 / 10.18% | 1.392 / 4.49% |

The gentler policy increased recall and reduced adjacent folds. The stricter 1.3.0 policy had higher utility lift and a higher fresh first-20 score. Spam fell below the no-engine rate on each seed. Approximately 0.06% of genuine viewed candidates received a spam-rule fold in 1.3.1. Tests also exercise repeated shop links alongside coherent Marvel, girlblog and autumn tag sets. Live false-positive rates remain unknown.

## Body words and payload

The optional experiment adds at most twelve distinct body words with feature weight 0.3 when a post has at most two cleaned tags. Reproduce it with `node bench/sim.mjs --seed 5 --engine bench/word-ablation.mjs` and repeat with seed 99.

- Seed 5: lift 1.3476 with sparse features and 1.3478 with words. Recall 80.48% and 80.32%. Mean profile 191.8 and 201.3 KiB.
- Seed 99: lift 1.3916 with sparse features and 1.3933 with words. Recall 80.78% and 81.23%. Mean profile 193.9 and 204.0 KiB.

The word experiment increased profile size and gave inconsistent recall changes. It stayed out of the release candidate. Embeddings were neither benchmarked nor shipped. The Android updater accepts up to 4 MiB for the entire signed content payload. No embedding uplift or on-device latency has been established.

The device report retains up to 512 For you decisions. Its older-rules comparison uses a separate rolling window with the current learned profile. Show measures an opened fold. Like/Reblog measures button or shortcut use, which can include opening a reblog composer and cancelling it. Neither signal establishes what would have happened under the other policy.
