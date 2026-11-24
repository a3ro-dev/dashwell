# Feed engine v2: learned value model on top of calibration

Decided by: Opus 5.5 (Astra was out of quota). Implementer: follow this; where the bench numbers argue
against a parameter, tune it and say so in the commit.

## 1. What the big feeds do (and what we can copy client-side)

- **X For You** (github.com/xai-org/x-algorithm): Phoenix predicts P(action) per post for ~25 actions,
  positives (favorite, reply, repost, dwell, profile click) and negatives (not interested, mute, block,
  report, *not dwelled*). Final score = Σ wᵢ·P(actionᵢ), negative actions with negative weights. Then
  author diversity (each later post by an author × decaying factor down to a floor), out-of-network
  discount, new-author boost, DPP reorder for diversity, seen-post dedup.
- **Instagram Explore/Feed** (about.instagram.com/blog/engineering/designing-a-constrained-exploration-system,
  engineering.fb.com/2023/08/09/ml-applications/scaling-instagram-explore-recommendations-system/):
  "value model" Value = P(like)^w · (1 − P(not interested))^w′, or the linear Σ w·P form;
  multi-task heads; then rule-based reranking ("no two from the same author in a row"). arXiv 2610.27423
  on the same VM.
- **TikTok Monolith** (arXiv 2209.07663): the edge is *real-time online training* on a
  *collisionless* sparse-feature table with eviction of stale features. Feedback changes the model
  within minutes.
- **FTRL-Proximal** (McMahan et al., "Ad Click Prediction: a View from the Trenches", KDD 2013):
  per-coordinate learning rates + L1 gives sparse, well-calibrated online logistic regression over
  hashed/sparse features. This is the cheapest serious online learner and runs fine in JS.
- **Thompson sampling** (Chapelle & Li, "An Empirical Evaluation of Thompson Sampling", NeurIPS 2011):
  sampling from an approximate Gaussian posterior over logistic weights beats ε-greedy exploration
  with no tuning of an exploration rate.
- **Calibration** (Steck, "Calibrated Recommendations", RecSys 2018) and **xQuAD**: our current quota
  layer. Keep it: it's the diversity/re-rank stage the big feeds also run after scoring.
- **Dwell** (Yi et al., "Beyond Clicks: Dwell Time for Personalization", RecSys 2014): dwell is a
  weak positive; very short dwell is X's "not dwelled" negative head.

**What v1 is missing vs. all of these:** it has no per-post *value*. It only folds for *crowding*
(topic quota full, author cap, dup). A topic you scroll past every day still gets its share of slots;
a blog you always skip is never folded; a non-mutual blog you always like is folded as soon as its
topic is full. Negative feedback is session-only (25-min debt) except `hide` halving the fast weight.

## 2. Weak spots / bugs in v1 feed.js

1. Long-term dislike is never learned (`recordInteraction` skip → debt only, half-life 25 min,
   lines 199-203). Hiding the same topic daily keeps it at full quota every new session.
2. No blog-level negative: skip/hide never touch `p.blogs`, so a firehose you always skip keeps its
   2-per-16 author slots forever (lines 264-265).
3. `tieStrength` uses `b.seen`, which counts *folded* posts too (observe(), line 111): folding a blog
   lowers its engagement rate, which keeps it folded. Self-reinforcing.
4. Folds ignore how good the post is: a loved-topic post from a loved (non-mutual) blog is folded
   exactly like a meh one once the topic quota is full (lines 273-295).
5. `clusterScores` is recomputed 2× per decision (clustersOf + quotaFn), O(#tags). Fine at 1500 tags,
   but compute once per decide().
6. Exploration is a fixed 1-in-10 slot on "novel" clusters only; nothing explores *blogs* or recovers
   a topic after a bad patch.

## 3. v2 design

### 3.1 Data (added to the profile, `p.m`)

```js
p.m = {
  f: {},        // feature -> [zE, nE, zD, nD, zN, nN, c, t]   (FTRL state per head, update count, last-seen day)
  th: 0,        // adaptive fold threshold on value V (tracked quantile)
  hi: 0,        // tracked high quantile of V (rescue line)
  k: 0,         // number of labeled impressions (warmth)
}
```
Arrays, not objects, to keep JSON small. Round stored floats to 4 significant digits on update
(`Math.round(x*1e4)/1e4`). Cap `MAX_FEATS = 2500`; on `recluster()` evict features with smallest
`c`, ties broken by oldest `t`, and any feature unseen for 120 days. Target: serialized `p.m` ≤ 150 KB.

Migration: `p.m ??= emptyModel()` at the top of observe/decide/learnImpression. Old profiles keep
working; the model starts cold.

### 3.2 Features of a post (collisionless string keys, Monolith-style)

```
'b'                         bias
't:'+tag      x=1/√nTags    every cleaned tag (≤12)
'c:'+cluster  x=1           every distinct cluster of the cleaned tags
'a:'+blog     x=1           poster
'r:'+blog     x=0.5         reblog-trail blogs other than the poster (≤4)
'ac:'+blog+'|'+topCluster   poster × top cluster
'l:'+bucket                 text length: 0 (<200 chars), 1 (<1000), 2 (≥1000) — post-type proxy
'nt:'+min(nTags,5)          tag count bucket (0 tags = untagged personal post)
```

### 3.3 Three heads, FTRL-Proximal (McMahan 2013)

Heads: **E** = engaged (like, reblog, comment, or expand of a fold), **D** = dwell (4–60 s),
**N** = negative (fast skip <300 ms outside a fling, or "less like this").

Per head, per feature i with value xᵢ:
```
wᵢ = |zᵢ| ≤ L1 ? 0 : −(zᵢ − sign(zᵢ)·L1) / ((β + √nᵢ)/α + L2)
p  = σ(Σ wᵢ xᵢ)
g  = (p − y)·xᵢ·sampleWeight
σᵢ = (√(nᵢ + g²) − √nᵢ)/α
zᵢ += g − σᵢ·wᵢ ;  nᵢ += g²
```
α = 0.15, β = 1, L1 = 0.3, L2 = 1. Bias feature exempt from L1. Sample weight: hide = 3 on N,
expand = 0.5 on E, else 1. Initialise bias z so that p₀ ≈ priors: E 0.08, D 0.25, N 0.1
(set `zBias = −logit(prior)·((β+0)/α + L2)` on first creation).

### 3.4 Value and Thompson exploration

```
V = 1.0·pE + 0.3·pD − 1.2·pN
```
Thompson (Chapelle & Li 2011): add Gaussian noise to the **E logit** only,
`sd = TS · √(Σ xᵢ² / (1 + cᵢ))`, TS = 0.6, one N(0,1) draw per post. Unseen features (cᵢ=0) get
the most noise, so new blogs/topics get tried; known-bad ones settle. RNG: `session.rand ?? Math.random`
(the bench passes a seeded one; never call Math.random directly elsewhere).

### 3.5 Labels: one per impression, from content.js

New export `learnImpression(p, session, post, out, now)`, `out = { engaged, dwell, skip, hide }` (booleans).
content.js calls it **once per post**, the first time a *shown* (or expanded) post leaves the
viewport or is hidden:
- flings (the existing ≥4-in-700 ms batch) → no label at all (not seen ≠ not liked);
- `engaged` = a like/reblog/comment/expand was learned for that post id;
- `dwell` = 4–60 s visible; `skip` = <300 ms and not a fling; `hide` = Less like this.
Folded, never-expanded posts get **no** label (we don't know the counterfactual). `recordInteraction`
stays as is for the tag/blog/cluster profile; learnImpression only trains `p.m` and bumps `p.m.k`.
Also fix bug 3: `observe()` stops counting `b.seen`; count it in learnImpression (shown posts only).
Also fix bugs 1-2 for free: the N head learns per tag, cluster and blog across sessions.

### 3.6 Tracked thresholds

Stochastic quantile tracking on every decided post that reaches the scoring step:
```
th += η·(Q_FOLD − [V < th])      Q_FOLD = 0.15   (fold the bottom 15% by value)
hi += η·(Q_HI  − [V < hi])       Q_HI   = 0.85   (top 15% can break a full quota)
η = 0.02
```
Initialise both from the first 30 V values (sort, pick quantiles) instead of 0.

### 3.7 decide() order (keeps every v1 guarantee)

1. mutual fast-lane, dup-reblog, author cap — unchanged (X keeps these as filters too).
2. clusters/quota exactly as v1 — compute `clusterScores` once and pass it in.
3. `warm = p.m.k ≥ 150`. If not warm → v1 behaviour exactly (all 17 tests keep passing).
4. If warm:
   - `V < th` and no open-quota cluster is one of the user's top-3 interests →
     **fold**, reason: `folded: you usually pass on <top negative feature>` where the feature is the one
     with the most negative contribution to V (e.g. "#hazbin hotel", "@blogname", "long text posts").
     `say`: `You usually scroll past posts like this`.
   - quota full but `V ≥ hi` → **show** (rescue), reason `shown: strong match (top 15%) though
     #x is full`. Still consumes the slot.
   - otherwise v1 logic (open slot → show, discovery slot → explore, else collapse).
5. Every return keeps `reason` and `say` one line, and includes V in `reason` as `v=0.42`.

### 3.8 What we keep from v1
Tag hygiene, NPMI clustering, dual-timescale interest, satiation debt, sustained-intent boost,
mutual tie strength + fast lane, author cap, reblog dedup, discovery slot, mutes, every explanation.
v2 is a scoring stage plus a value-aware fold, the same split as X/Instagram: learned score first,
then rules for diversity.

## 4. Evaluation (bench/sim.mjs)

Run `node bench/sim.mjs --engine extension/feed.js` before/after, 3 seeds. v2 passes if, averaged
over seeds and personas:
- utility lift of shown posts ≥ baseline + 10% (relative), and recall of top-quartile posts not worse
  than baseline − 2 points;
- wrongly-folded rate ≤ baseline;
- persona "hates a popular topic": its share of shown posts drops ≥ 40% vs baseline by session 5;
- persona "loves a non-mutual blog": that blog's shown rate ≥ baseline;
- drift persona: time-to-adapt not worse than baseline;
- topic Gini/diversity within 10% of baseline (we're not allowed to buy lift with a filter bubble);
- p95 decide() < 1 ms, serialized profile ≤ 400 KB after 30 simulated days.
Plus `npm test` green: all 17 old tests unchanged, new tests for 3.5–3.7 and migration.

## 5. Phase B (only if the bench says it pays): semantic taste from Hugging Face

Candidate: **minishlab/potion-base-2M** (Model2Vec static embeddings, MIT, 64-dim, bge-base-en-v1.5
WordPiece vocab, 7.5 MB fp32 → ~1.9 MB int8). Static embeddings = tokenize + mean of rows, so it runs
in pure JS with no ONNX/WASM runtime, in the extension and the Android WebView alike. MTEB quality is
far below a transformer, but it is ~1000x cheaper and its job here is only "is this post near what I
like", which tags + text do well enough.

Use: post vector e = normalize(mean of token rows of cleaned tags + first 300 chars of text).
User taste vectors (EMA, half-life 30 days): `u+` over engaged/dwelled posts, `u−` over skipped/hidden.
Add two numeric features to every head: `s+ = cos(e,u+)`, `s− = cos(e,u−)`. This is the cheap
two-tower: it generalises to tags the user has never seen (cold start, fandom renames, synonyms),
which pure tag features can't. Store the model as `extension/model/potion2m.i8` + vocab; it ships
in the APK assets and extension, not OTA (OTA is text-only) → needs an APK release and a minApp bump.

Accept phase B only if, on a sim world whose topics use real English tag vocabularies, it improves
cold-start (first 3 sessions) utility lift by ≥ 5% and unseen-tag recall, with decide() p95 < 2 ms.
Otherwise drop it and say so.
