# Feed engine benchmark

Offline simulation of `extension/feed.js`: synthetic Tumblr world, synthetic users with hidden tastes, the engine driven the way `content.js` drives it (`observe` then `decide`, then `recordInteraction` for what the user does). No network, no `Date.now()`, seeded, so a run is reproducible (only the `us` column varies by machine).

```
node bench/sim.mjs [--seed N] [--json out.json] [--engine path/to/feed.js]
node bench/compare.mjs [--seeds 1,7,42]     # v1 vs v2, writes v2.json
```

`--engine` loads another file that sets `globalThis.TumblrNew`, so you can A/B one engine against another on the same world and the same users. Run it once per engine with the same `--seed` and diff the JSON. An engine that exports `learnImpression` also gets one impression label per post the user saw (shown, or folded then expanded), exactly as `content.js` sends it; flings are not modelled. Engines without it run as before, so v1 stays comparable.

Files: `world.mjs` (topics, blogs, reblog cascades, For-you-like stream), `users.mjs` (personas, true utility, reactions), `sim.mjs` (loop, metrics, table), `compare.mjs` (v1 vs v2 over seeds), `feed.v1.js` (frozen v1 engine, the reference), `baseline.json` (v1 at seed 1), `v2.json` (v1 vs v2 results and target check), `ALGO-V2.md` (the design).

## Model in one paragraph

60 topics (hub tag + 3-8 co-tags, a few shared generic tags, commentary like `#i'm screaming` and unknown ones like `#iconic`, meta like `#reblog`, 10% of posts untagged). 400 blogs: 5 firehose, 12 spam (tag-stuffed with 4-6 topics), the rest heavy-tailed. About a third of posts are reblogs of earlier roots. The stream is 70% followed blogs, 30% popularity-driven; it never depends on the engine, and every user reaction is pre-drawn per post, so baseline, engine and oracle see the same stream and the same user. 5 personas x 3 users x 20 sessions (60-150 posts) over 14 days: `narrow` fandom, `generalist`, `mutuals` (3 loved quiet blogs, not pinned), `drifter` (two new loves and two faded ones at session 10), `hater` (hates the most popular topic, which is everywhere).

## Policies

- `baseline`: no engine, show everything.
- `engine`: the feed.js under test.
- `oracle`: folds the truly lowest-utility posts of each session at the engine's own fold rate. The ceiling for a given amount of folding.

## Metrics

| col | meaning |
|---|---|
| lift | mean true utility of shown posts / mean over all candidates |
| prec | share of shown posts with utility above the user's median |
| recall | share of top-quartile posts that were shown (not folded) |
| fold% | share of posts folded |
| wrong% | share of folded posts the user would have liked or reblogged |
| topics, real, gini | distinct topics shown per session, the same without spam posts (a spam post carries a random topic in the sim, so every spam post shown inflates `topics`), Gini of topic counts within a session (higher = more concentrated) |
| mut% | share of loved-mutual posts shown (mutuals persona) |
| hate% | share of shown posts in the hated topic (hater persona) |
| adapt | sessions after the drift until the new topics reach 80% of their eventual shown share (drifter) |
| recov | sessions after the drift until lift is back to 90% of its pre-drift level (drifter) |
| spam%, fire% | share of shown posts from spam / firehose blogs |
| eng | likes + reblogs per post the user saw (shown, or folded then expanded) |
| us, p95us | microseconds per observe+decide: mean, and 95th percentile (per user, then averaged) |
| KB | `JSON.stringify(engine)` at the end of the run |

"Overall" is the mean over the five personas (metrics that don't apply to a persona are skipped).

## Baseline (v1 engine, seed 1)

```
policy               lift   prec recall  fold% wrong% topics   gini   mut%  hate%  adapt  recov  spam%  fire%    eng     us     KB
baseline (all)       1.00   0.50   1.00    0.0    0.0   28.9   0.48  100.0   24.7    0.3    0.0    5.2   20.8  0.077      -      -
engine (all)         1.20   0.53   0.63   46.8    5.2   26.6   0.34   85.2   13.5    1.7    2.7    9.0   15.0  0.103     ~90    113
oracle (all)         1.79   0.92   1.00   46.8    0.2   19.7   0.43   99.8    6.3    0.3    0.0    2.6   20.3  0.137      -      -

engine by persona
narrow               1.25   0.54   0.65   44.9    3.4   27.0   0.34      -      -      -      -    8.7   13.5  0.103
generalist           1.06   0.50   0.62   44.4    9.6   27.5   0.33      -      -      -      -    8.9   19.4  0.131
mutuals              1.22   0.53   0.69   43.3    5.5   26.4   0.35   85.2      -      -      -    8.4   12.9  0.127
drifter              1.27   0.53   0.60   48.7    3.2   25.8   0.35      -      -    1.7    2.7    8.8   14.5  0.081
hater                1.20   0.55   0.58   52.5    4.3   26.4   0.33      -   13.5      -      -   10.1   14.5  0.074
```

Seeds 7 and 42 give the same picture (lift 1.17-1.18, recall 0.68-0.69, fold 42%).

`baseline.json` was regenerated with the frozen `feed.v1.js` on the current sim, which added the `real` and `p95us` columns and the engine RNG hook. Every earlier metric came out identical, so the table above still stands (the world and the users did not change).

## v1 vs v2 (seeds 1, 7, 42)

Mean over three seeds, 3 users per persona, 20 sessions each. `node bench/compare.mjs` reproduces it and writes `v2.json`.

```
seeds 1, 7, 42, 3 users per persona, mean over seeds

policy                 lift   prec recall  fold% wrong% topics   real   gini   mut%  hate%  adapt  recov  spam%  fire%    eng     us  p95us     KB
baseline (no engine)   1.00   0.50   1.00    0.0    0.0   29.0   26.1   0.49  100.0   25.1    0.4    0.0    5.2   21.6  0.088      -      -      -
v1 engine              1.18   0.54   0.67   43.7    5.8   26.8   23.9   0.37   86.6   14.1    1.7    1.3    8.5   15.2  0.116     82    118    110
v2 engine              1.45   0.62   0.81   46.6    2.5   22.8   21.4   0.41   96.0    8.5    1.2    0.6    4.5   15.4  0.138     97     99    194
oracle (v2 rate)       1.80   0.91   1.00   46.6    0.1   19.6   18.7   0.45   99.9    6.5    0.4    0.0    2.7   19.3  0.156      -      -      -
  v2 seed 1            1.47   0.61   0.75   49.7    2.6   22.8   21.3   0.37   94.1    8.0    0.3    0.0    4.8   16.1  0.125     96     95    197
  v2 seed 7            1.45   0.62   0.83   45.2    2.4   22.7   21.3   0.43   96.6   10.0    2.3    1.0    4.1   14.5  0.144     98    100    197
  v2 seed 42           1.44   0.63   0.84   44.9    2.6   23.0   21.5   0.42   97.3    7.5    1.0    0.7    4.5   15.7  0.146     96    101    186

narrow/v1              1.22   0.54   0.69   41.5    4.5   26.8   23.9   0.38      -      -      -      -    8.2   13.7  0.123     82    117    109
narrow/v2              1.48   0.60   0.79   47.0    1.9   22.6   21.2   0.42      -      -      -      -    4.4   13.1  0.146    100    108    193

generalist/v1          1.09   0.52   0.67   42.7    9.5   28.4   25.6   0.35      -      -      -      -    8.7   20.0  0.135     89    128    116
generalist/v2          1.30   0.63   0.87   41.0    4.5   24.7   23.4   0.41      -      -      -      -    3.5   23.1  0.158    105    107    202

mutuals/v1             1.19   0.53   0.72   40.3    5.9   25.9   23.2   0.38   86.6      -      -      -    8.1   13.4  0.133     78    111    106
mutuals/v2             1.46   0.63   0.89   42.7    1.9   21.6   20.2   0.44   96.0      -      -      -    4.0   10.9  0.158     92     92    186

drifter/v1             1.22   0.54   0.66   43.1    4.5   26.7   23.9   0.38      -      -    1.7    1.3    8.1   14.3  0.106     78    116    109
drifter/v2             1.51   0.59   0.72   48.6    1.9   22.6   21.0   0.40      -      -    1.2    0.6    4.6   14.3  0.126     92     91    193

hater/v1               1.20   0.55   0.60   51.0    4.5   26.0   23.0   0.34      -   14.1      -      -    9.6   14.3  0.081     84    119    110
hater/v2               1.52   0.65   0.76   53.7    2.5   22.7   20.9   0.37      -    8.5      -      -    5.9   15.6  0.102     95     96    194

```

```
targets (v2, mean over seeds; "all seeds" = every seed passes alone)
PASS  lift    >= 1.4    v1    1.184  v2    1.454  all seeds
PASS  recall  >= 0.72   v1    0.669  v2    0.806  all seeds
PASS  wrong   <= 0.035  v1    0.058  v2    0.025  all seeds
PASS  spam    <= 0.05   v1    0.085  v2    0.045  all seeds
PASS  mutual  >= 0.93   v1    0.866  v2    0.960  all seeds
PASS  hate    <= 0.09   v1    0.141  v2    0.085  not every seed
PASS  adapt   <= 1.7    v1    1.667  v2    1.222  not every seed
PASS  recov   <= 2.7    v1    1.333  v2    0.556  all seeds
PASS  topics  >= 22     v1   26.757  v2   22.837  all seeds
PASS  p95     < 1000   v1  118.187  v2   98.782  all seeds
PASS  kb      <= 400    v1  109.996  v2  193.571  all seeds
```

All eleven targets hold on the mean. Two per-seed misses: the hated topic on seed 7 (10.0%; the mean is 8.5%) and adapt on seed 7 (2.3 sessions). Seeds 2, 3 and 11, which were not used while tuning, give lift 1.42-1.46, recall 0.77-0.82, wrongly folded 2.5-2.9%, loved-mutual 94-97%, hated topic 6.6-8.7%, spam 4.6-5.4% and adapt 0.3-2.7 (v1 on the same seeds: lift 1.15-1.19, spam 8.7-9.8%).

What the numbers say, per persona:

- **Generalist** gains least (lift 1.09 to 1.30) and still folds 4.5% of posts it should not have: with 28 interests there is little to separate, and the model has the least to say.
- **Hater**: the hated topic goes from 14.1% to 8.5% of shown posts (the stream is 25%); the oracle at the same fold rate reaches 6.5%. Most of what is left is posts with no usable tags and the first two or three sessions, while the model learns.
- **Mutuals**: loved-mutual shown 86.6% to 96.0%. The fast-lane burst limit (3 per 8 shown posts) costs most of the rest.
- **Drifter**: adapt and recovery are noisy by nature (a handful of posts a session in the new topics; per seed 0.3 to 2.7 sessions). Read the mean of 1.2 as "not worse than v1 (1.7)", not as a precise number.
- `topics` falls from 26.8 to 22.8 per session; without spam topics (`real`) 23.9 to 21.4. The oracle at the same fold rate shows 19.6, so v2 stays between v1 and an engine that folds with perfect knowledge. Dropping spam alone costs about 1.5 of those topics, which is the sim counting random spam topics as variety.

### As built vs ALGO-V2.md

The structure is the design: three FTRL-Proximal heads over sparse string-keyed features (`b`, `t:`, `c:`, `a:`, `r:`, `ac:`, `l:`, `nt:`, `stuff:`), V = pE + 0.3 pD - 1.2 pN, Thompson noise on the engaged logit, tracked quantile thresholds seeded from the first 30 values, `learnImpression` labels, bounded storage, migration by `ensure()`. Where the bench argued otherwise:

| design | built | why |
|---|---|---|
| feature values as listed | unit-normalised per post; topic features x2 | with ~9 correlated features per post the effective step was 9x too big and P(skip) saturated at 1.0 |
| alpha 0.15, L1 0.3 | alpha 1 (on unit vectors), L1 0.1 | the per-post step is alpha, not 9 alpha; sparse features learned too slowly at L1 0.3 |
| TS 0.6 | 0.2 | noise around a 15-20% quantile line leaks hated topics; unseen features still get the most |
| warm at 150 labels | 80 labels end the relaxed quota (a topic folds only past a third of the window, fading out as labels arrive) and start rescues; value folds start 80 labels later | first-session folding drops and the second session is gentler; test 1b still holds |
| Q_FOLD 0.15, Q_HI 0.85 | 0.2, 0.7 | the hated topic is 25% of the stream, so a 15% fold line cannot remove it; a 15% rescue line was too narrow for recall |
| FTRL state kept forever | halves per 14 days since a feature was last updated | an interest that changed can be relearned; the bias never fades |

Added because the findings demanded it:

- **Tag-stuffed posts** (4+ non-generic tags that never appear together, once 100 posts have been seen) fold outright; `stuff:` is also a feature. This is what moved spam from 8.5% to 4.5%. Before the model is warm, only a multi-topic post's strongest topic can open a slot.
- **Generic tags** (seen 12+ times, their top 3 co-tags cover under half their posts: `#art`, `#iconic`, `#unhinged`) carry no topic, like commentary.
- **Topic average value**: a topic whose last ~15 posts average below the fold line is "you usually pass on #x" (folds unless the post is a strong match). Per-post V is noisy; the topic mean is not.
- **"Less like this" memory**: a hide counts 1 split over the post's topics, fades with a 30-day half-life, and two of them leave a topic no slots (strong matches only). It outranks a friendship, except for pinned blogs.
- **Trusted blogs** (tie 0.8+, or learned P(engage) 0.3+) are never folded as duplicate, crowding or over the author cap, only for low value. The fast-lane starts at tie 1.5 (a favorite is still 1.8) and its burst limit counts the last 8 shown posts instead of 16. Engagement also credits the blogs in a post's reblog trail at 0.35, and a blog's engagement rate counts shown posts only, not folded ones.
- **Reblog roots** you were shown are remembered across sessions (last 1500).
- **Caps**: 1000 tags, 4000 pairs, 700 blogs, 1500 features, 1500 roots; floats stored at 4 digits. A 90-day heavy long-tail stress user stays under 400 KB.
