# Dashwell feed benchmark

Run `node bench/compare.mjs` to compare the frozen 1.2.0 and 1.3.0 engines with the working engine. The default seeds are 1, 7, 42, 5 and 99. Seeds 5 and 99 serve as held-out checks. Detailed per-seed and per-persona results are in [v2.json](v2.json). The comparison uses three users per persona and twenty sessions per user.

The generator groups actual Tumblr tag sets under the 60 most frequent eligible anchor tags and samples a complete observed set for ordinary tagged posts. Simulated spam draws tags from different anchors. The generator samples a heavy-tailed stream of blogs, reblogs and topic tags. Spam accounts mix familiar tags, ordinary creators sometimes promote their shops, and promotions can repeat across distinct roots. Some posts have a single tag or none. Body text comes from a small set of templates. There is no unique spam marker.

Twelve percent of candidates are preload-only. Every policy decides on those candidates, but their posts receive no feedback and do not enter the quality metrics. Show uses a fixed curiosity rate per user (3%, 4.5% or 6%). Labels arrive three candidates later. The frozen engines receive their historical expansion signal. The working engine learns from subsequent reading or actions. Flings, actual DOM behavior and the overhead of storage and shadow reporting are outside this simulation.

## Five-seed results

Lift divides the mean utility of initially shown posts by the mean utility of all viewed candidates. Recall measures the fraction of the highest-utility quarter shown by default. Spam measures the share of initially shown posts from simulated spam blogs. Adjacent folds measure the fraction of viewed candidates that are folded immediately after another fold in the same session. Wrong measures how often a simulated user would have liked or reblogged a folded post. These are predictions for synthetic users.

| Policy | Lift | Recall | Spam | Fold | Adjacent folds | Wrong | Fresh first 20 | Migrated first 20 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| No engine | 1.000 | 100.00% | 4.96% | 0.00% | 0.00% | 0.00% | 0.2173 | - |
| 1.2.0 | 1.118 | 62.07% | 6.77% | 44.80% | 21.64% | 6.45% | 0.2339 | 0.1901 |
| 1.3.0 | 1.346 | 77.24% | 7.02% | 44.79% | 20.91% | 3.30% | 0.2355 | 0.1973 |
| 1.3.1 | 1.330 | 79.21% | 3.12% | 42.85% | 18.99% | 3.07% | 0.2338 | 0.1956 |

First-20 columns give mean utility among initially shown posts within the first 20 viewed candidates. The migration probe trains a separate 1.2.0 profile on the first three sessions of the same user, round-trips it through JSON, and measures the following session. The fresh and migrated columns use different streams. Compare versions within a column.

| Seed | No-engine spam | 1.2.0 lift / spam | 1.3.0 lift / spam | 1.3.1 lift / spam |
|---:|---:|---:|---:|---:|
| 1 | 5.08% | 1.146 / 7.15% | 1.351 / 7.61% | 1.340 / 3.21% |
| 7 | 4.71% | 1.117 / 6.44% | 1.361 / 6.89% | 1.338 / 3.04% |
| 42 | 4.52% | 1.113 / 6.23% | 1.344 / 6.16% | 1.327 / 2.87% |
| 5 | 4.63% | 1.117 / 6.41% | 1.348 / 6.61% | 1.323 / 3.10% |
| 99 | 5.89% | 1.096 / 7.61% | 1.328 / 7.82% | 1.323 / 3.39% |

The gentler policy increased recall and reduced adjacent folds. The stricter 1.3.0 policy had higher utility lift and a higher fresh first-20 score. Spam fell below the no-engine rate on each seed. Approximately 0.12% of genuine viewed candidates received a spam-rule fold in 1.3.1. Tests also exercise repeated shop links alongside coherent Marvel, girlblog and autumn tag sets. Live false-positive rates remain unknown.

## Body words and payload

The optional experiment adds at most twelve distinct body words with feature weight 0.3 when a post has at most two cleaned tags. Reproduce it with `node bench/sim.mjs --seed 5 --engine bench/word-ablation.mjs` and repeat with seed 99.

- Seed 5: lift 1.3232 with sparse features and 1.3294 with words. Recall 76.79% and 77.51%. Mean profile 356.1 and 355.5 KiB.
- Seed 99: lift 1.3230 with sparse features and 1.3202 with words. Recall 81.46% and 81.36%. Mean profile 355.8 and 355.5 KiB.

Words improved lift and recall on one held-out seed and reduced both on the other. It stayed out of the release candidate. Embeddings were neither benchmarked nor shipped. The Android updater accepts up to 4 MiB for the entire signed content payload. No embedding uplift or on-device latency has been established.

The device report retains up to 512 For you decisions. Its older-rules comparison uses a separate rolling window with the current learned profile. Show measures an opened fold. Like/Reblog measures button or shortcut use, which can include opening a reblog composer and cancelling it. Neither signal establishes what would have happened under the other policy.

## Real-data replay

Use Node 22.13 or later with built-in SQLite, tar, and unzip on Unix. Place the archives in `.cache/datasets/`. The scripts print a download command if a file is missing and verify the source checksum before reading the archive. No raw posts, tag lists, identifiers or video logs are distributed with Dashwell.

- `node bench/tumblr-check.mjs` reads the SQL dump without a database server. Swati Agarwal and Ashish Sureka, *Semantically Analyzed Metadata of Tumblr Posts and Bloggers*, version 2 (2016), CC BY 4.0. [Mendeley Data](https://data.mendeley.com/datasets/hd3b6v659v/2)
- `node bench/kuai-replay.mjs` runs KuaiRand-Pure. Chongming Gao and colleagues, *KuaiRand: An Unbiased Sequential Recommendation Dataset with Randomly Exposed Videos*, CIKM 2022. [Dataset](https://zenodo.org/records/10439422) and [paper](https://doi.org/10.1145/3511808.3557624)
- `node bench/kuai-replay.mjs kuairec` runs the KuaiRec small matrix. Chongming Gao and colleagues, *KuaiRec: A Fully-Observed Dataset and Insights for Evaluating Recommender Systems*, CIKM 2022. [Dataset](https://zenodo.org/records/18164998) and [paper](https://doi.org/10.1145/3511808.3557220)

Both Zenodo records list CC BY 4.0 in their metadata. Both downloaded Kuaishou archives contain a LICENSE headed Attribution-ShareAlike 4.0 International.

KuaiRand merges both standard logs and the random-exposure log in timestamp order for each user. Profiles span sessions. A gap over 30 minutes starts a new session. The video identifies a root, the creator identifies a blog, and numeric categories become prefixed tags. A like or follow maps to a like, a forward to a reblog, a comment to a comment, and a hate to a hide. Long view or a play ratio of at least 0.8 supplies dwell. A positive play under 300 ms supplies a skip when there was no stronger signal. Only initially shown items teach the engine. Every logged outcome scores the decision.

The KuaiRand positive outcome for evaluation is a recorded like or long view. KuaiRec supplies watch ratios and no like/hate field, so 0.8 defines its positive outcome. Results pool impressions. Wrong is the positive share of folded items, recall is the share of positives shown, and lift divides the positive rate among shown items by the rate among all logged items. Hates shown uses the number of recorded hates as its denominator.

KuaiRand includes every logged user. IDs divisible by five form the preselected held-out split. KuaiRec uses the same untouched split, the small matrix, and rows with a usable timestamp. No engine tuning used either dataset. Kuaishou is short video. These measurements test whether learned choices transfer to real human viewing behavior. They cannot establish the effect on a Tumblr reader. The publisher describes KuaiRec's small matrix as 99.6% observed, with some deliberate blocks. [KuaiRec documentation](https://kuairec.com/)

### Tumblr tag checks

Across 3,083 distinct archived posts, all 19,038 parsed tag occurrences agreed with the published per-post counts. Cleaning removed or merged 3,752 occurrences. Spot checks cover first-person commentary, personal/meta tags, and generic tags such as `rant`. The current profile marked 28 tags generic. Broad association can also suppress a meaningful subject.

The 1.3.0 spam rule flagged two posts. The 1.3.1 rule flagged zero, including among 170 posts with a detected external link or promotional wording. The archive has no ground-truth spam labels. These counts bound observed flags on this sample, without measuring spam recall or establishing a population false-positive rate. Its 2016 bootstrapped sample has a narrow subject distribution.

### KuaiRand-Pure

| Split | Version | Lift | Recall | Wrong | Hates shown | Fold | Adjacent folds |
|---|---|---:|---:|---:|---:|---:|---:|
| All | 1.2.0 | 1.0266 | 94.45% | 15.60% | 91.75% | 8.00% | 1.92% |
| All | 1.3.0 | 1.0198 | 94.00% | 17.25% | 88.65% | 7.82% | 1.24% |
| All | 1.3.1 | 1.0082 | 94.70% | 19.62% | 89.91% | 6.07% | 0.92% |
| Held-out | 1.2.0 | 1.0252 | 94.48% | 15.97% | 93.15% | 7.84% | 1.86% |
| Held-out | 1.3.0 | 1.0189 | 94.00% | 17.59% | 91.78% | 7.75% | 1.21% |
| Held-out | 1.3.1 | 1.0078 | 94.73% | 19.95% | 91.51% | 6.00% | 0.89% |
| Random held-out | 1.2.0 | 1.0233 | 95.25% | 6.06% | 93.78% | 6.92% | 1.59% |
| Random held-out | 1.3.0 | 1.0177 | 95.27% | 6.53% | 95.11% | 6.39% | 0.88% |
| Random held-out | 1.3.1 | 1.0103 | 97.69% | 6.15% | 95.11% | 3.31% | 0.34% |

The full replay covered 2,622,668 exposures from 27,285 users. The held-out 5,457 users contributed 530,002 exposures. The current policy showed more of their positive items and folded fewer items. Its shown-item lift was lower than either frozen engine.

Among 236,987 randomly assigned held-out exposures, 20,897 (8.82%) were positive. Discovery/second-chance exposures were positive on 50/1,126 in 1.2.0, 36/983 in 1.3.0 and 26/500 in 1.3.1. The explicit second-chance subset had 0/6 positives in 1.3.0 and 1/13 in 1.3.1. Random assignment helps check the available items independently of the original recommender. Each engine still selects its own exploration subset, and these small second-chance samples cannot establish a benefit.

### KuaiRec small matrix

| Version | Lift | Recall | Wrong | Fold | Adjacent folds |
|---|---:|---:|---:|---:|---:|
| 1.2.0 | 0.9686 | 45.16% | 48.80% | 53.38% | 35.56% |
| 1.3.0 | 1.0148 | 82.31% | 44.47% | 18.90% | 4.27% |
| 1.3.1 | 1.0054 | 90.83% | 45.08% | 9.66% | 1.51% |

The held-out users contributed 933,417 timestamped observations from 293 people; 37,772 observations lacked a usable timestamp and were excluded. There were 443,361 positive watch ratios. The gentler engine retained 90.8% of these and folded 9.7% of all items. Its remaining folds still included positive watch ratios about 45% of the time. This benchmark supplies no explicit hate outcome.
