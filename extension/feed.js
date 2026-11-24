// Dashwell feed engine v2: pure JS, no DOM or browser APIs, so it ports to a mobile app.
// Layer 1 (calibration, v1): slots with Dirichlet shrinkage, session satiation, NPMI tag clustering,
// frequency-normalized mutual tie strength, author spacing, reblog dedup, 1-in-10 exploration,
// implicit dwell (Yi et al. 2014) and explicit "less like this" feedback.
// Layer 2 (value, v2): an online model of what you do with each post. Three FTRL-Proximal logistic
// heads (engaged, dwelled, skipped) over sparse tag/topic/blog features (McMahan et al. 2013), combined
// into one value V, explored with Thompson sampling (Chapelle & Li 2011). V folds the posts you
// usually pass on and rescues strong matches past a full topic quota. Calibration still enforces variety.
(() => {
  const DAY = 864e5;
  const MIN = 6e4;
  const P = {
    W: 16, // recent shown posts we calibrate over
    KAPPA: 10, // Dirichlet prior: one like on a new topic can't claim the feed
    FAST_HL_DAYS: 14, // two exponentials approximate power-law memory:
    SLOW_HL_DAYS: 180, // recent spikes fade, old loves stay
    BLOG_HL_DAYS: 45,
    SAT_HL_MIN: 25, // session satiation debt half-life
    SAT_GAMMA: 0.35,
    NPMI: 0.32,
    MIN_COOC: 3,
    TIE: 1.8, // strong-tie (mutual) threshold: a favorite
    LANE: 1.5, // tie at which a blog skips the quotas (the mutual fast-lane)
    TRUST_TIE: 0.8, // tie at which a blog is never folded for crowding, only for low value
    MUTUAL_BURST: 3, // uncollapsible mutual posts per BURST_WINDOW shown posts
    BURST_WINDOW: 8,
    AUTHOR_CAP: 2, // posts per non-mutual author per window
    EXPLORE_EVERY: 10,
    CHANCE_EVERY: 40, // a value fold can't learn it was wrong, so one in this many shown posts lets one through
    NOVEL_IMPRESSIONS: 15,
    MAX_TAGS: 12, // authors put real topic tags first
    TOP_CLUSTERS: 3,
    RECLUSTER_EVERY: 50,
    MAX_TAG_STATS: 1000, // caps keep the stored profile under ~400 KB however long the tail of tags and blogs
    MAX_PAIRS: 4000,
    MAX_BLOGS: 700,
    GENERIC_MIN_N: 12, // a tag seen this often whose top 3 co-tags are in under GENERIC_TOP of its posts is generic
    GENERIC_TOP: 0.5,
    // value model
    ALPHA: 1, BETA: 1, L1: 0.1, L2: 1, // FTRL-Proximal
    X_TOPIC: 2, // feature value of a topic: how loud topic evidence is next to tag and blog evidence
    TS: 0.2, // Thompson noise scale on the engaged logit
    W_E: 1, W_D: 0.3, W_N: 1.2, // V = W_E*pE + W_D*pD - W_N*pN
    VALUE_AFTER: 80, // more labeled impressions after WARM before value folds start (quota and rescue use the model first)
    COLD_SHARE: 3, // before warm, a topic folds only once it takes more than 1/COLD_SHARE of the window
    WARM: 80, // labeled impressions before value folds start; before that the quota is relaxed
    Q_FOLD: 0.13, Q_HI: 0.55, ETA: 0.02, // tracked quantiles of V: fold below the first, rescue above the second
    CV_MIN: 4, // posts of a topic scored before its average value counts
    CV_WINDOW: 15, // and the average follows roughly this many recent posts
    MAX_TOPICS: 400,
    MODEL_HL_DAYS: 14, // evidence about a feature halves every two weeks it goes unseen, so changed tastes can be relearned
    MAX_FEATS: 1500,
    STALE_DAYS: 120,
    MAX_ROOTS: 1500,
    HIDE_HL_DAYS: 30, // "less like this" on a topic keeps it out for weeks, not minutes
    HIDE_OFF: 1.5, // decayed hides at which a topic gets no slots, only strong matches
    PARTNER: 3, // co-occurrences that make two tags partners
    KNOWN_TAG: 8, // times a tag must have been seen before its lack of partners means anything // posts seen before co-occurrence is known well enough to call that
    TRUST: 0.3, // learned P(engage) of a blog above which a full topic never folds its posts
  };
  const PRIORS = [0.08, 0.25, 0.1]; // engaged, dwelled, skipped
  const WEIGHTS = { like: 1, reblog: 2.2, comment: 2.5, dwell: 0.4 };
  const META = new Set(['reblog', 'reblogs', 'mine', 'queued', 'queue', 'long post', 'fy', 'fyp', 'personal', 'text', 'photo', 'video', 'tumblr', 'repost']);
  // matched against `tag + ' '`, so "sob" catches "#sob" but not "#sobriety"
  const COMMENTARY = /^(i|im|i'm|my|me|you|we|he|she|they|his|her|their|our|its|it's|this|that|so|just|not|no|yes|oh|ok|okay|why|what|how|wait|omg|lol|literally|screaming|crying|sob|help|op|bro|guys|also|anyway|update|real|mood|same) /;
  const NO_STEM = new Set(['series', 'species', 'news', 'glasses', 'aesthetics', 'physics', 'mathematics', 'pokemon']);

  const half = (dt, hlMs) => 0.5 ** (dt / hlMs);
  const logit = (x) => Math.log(x / (1 - x));
  const sigmoid = (x) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
  const sig4 = (x) => Number(x.toPrecision(4));

  function stem(word) {
    if (NO_STEM.has(word) || word.length <= 3) return word;
    if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
    if (/(ss|us|is|ics)$/.test(word)) return word;
    return word.endsWith('s') ? word.slice(0, -1) : word;
  }

  // Tag hygiene: normalize, drop meta and commentary tags ("#i am literally screaming"), stem plurals.
  function cleanTags(rawTags) {
    const out = [];
    for (const raw of rawTags.slice(0, P.MAX_TAGS)) {
      const t = raw.toLowerCase().replace(/^#+/, '').replace(/[^\p{L}\p{N}\s'-]/gu, '').replace(/\s+/g, ' ').trim();
      if (t.length < 2 || t.length > 32 || t.split(' ').length > 4 || META.has(t) || COMMENTARY.test(t + ' ')) continue;
      out.push(t.split(' ').map(stem).join(' '));
    }
    return [...new Set(out)];
  }

  // Value model state. f: feature -> [zE, nE, zD, nD, zN, nN, updates, last-seen day] (FTRL z and n per head).
  // The bias starts at the prior rate of each head. th/hi: tracked fold and rescue thresholds on V.
  // cv: topic -> [average V of its recent posts, how many]. k: labeled impressions so far. q: the first V values, until the thresholds can be seeded from them.
  const dict = () => Object.create(null);
  const biasRec = () => [...PRIORS.flatMap((pr) => [-logit(pr) * (P.BETA / P.ALPHA + P.L2), 0]), 0, 0];
  const emptyModel = () => ({ f: { b: biasRec() }, cv: {}, th: 0, hi: 0, k: 0, q: [] });
  const emptyProfile = () => ({ n: 0, boost: {}, tags: {}, pairs: {}, map: {}, blogs: {}, debt: {}, imp: {}, m: emptyModel(), rr: [] });
  const newSession = () => ({ window: [], shown: 0, lastExplore: 0, roots: new Set(), engaged: dict() });

  // Profiles written by v1 have no model and no root memory; both start empty.
  function ensure(p) {
    p.m ??= emptyModel();
    p.m.f ??= {};
    p.m.f.b ??= biasRec();
    p.m.cv ??= {};
    p.rr ??= [];
    for (const key of ['tags', 'blogs', 'pairs', 'map', 'debt', 'imp', 'hid', 'boost']) {
      p[key] ??= dict();
      if (Object.getPrototypeOf(p[key])) Object.setPrototypeOf(p[key], null);
    }
    Object.setPrototypeOf(p.m.cv, null);
    Object.setPrototypeOf(p.m.f, null);
    return p.m;
  }

  // Reblog roots the user has been shown, across sessions (bounded). A Set mirrors the array for lookups.
  const ROOTS = new WeakMap();
  function rootSet(p) {
    let s = ROOTS.get(p.rr);
    if (!s) ROOTS.set(p.rr, (s = new Set(p.rr)));
    return s;
  }
  function remember(p, root) {
    ensure(p);
    const s = rootSet(p);
    if (s.has(root)) return;
    s.add(root);
    p.rr.push(root);
    if (p.rr.length > P.MAX_ROOTS) s.delete(p.rr.shift());
  }

  const tagWeight = (s, now) => (s ? (s.f ?? 0) * half(now - s.t, P.FAST_HL_DAYS * DAY) + (s.s ?? 0) * half(now - s.t, P.SLOW_HL_DAYS * DAY) : 0);
  const clusterOf = (p, tag) => p.map[tag] ?? tag;

  function debtOf(p, cid, now) {
    const d = p.debt[cid];
    return d ? d.d * half(now - d.t, P.SAT_HL_MIN * MIN) : 0;
  }
  function addDebt(p, cid, amount, now) {
    p.debt[cid] = { d: Math.max(0, debtOf(p, cid, now) + amount), t: now };
  }

  // "Less like this" count per topic, fading over weeks. v1 only cooled a topic for 25 minutes.
  function hidOf(p, cid, now) {
    const h = p.hid?.[cid];
    return h ? h[0] * half(now - h[1], P.HIDE_HL_DAYS * DAY) : 0;
  }

  // Long-term interest per cluster = log1p(sum of member tag weights). Generic tags carry none.
  function clusterScores(p, now) {
    ensure(p);
    const sums = dict();
    for (const [tag, s] of Object.entries(p.tags)) {
      if (s.g) continue;
      const w = tagWeight(s, now);
      if (w > 1e-3) sums[clusterOf(p, tag)] = (sums[clusterOf(p, tag)] ?? 0) + w;
    }
    for (const k in sums) sums[k] = Math.log1p(sums[k]);
    return sums;
  }

  function quotaFn(p, now, scores = clusterScores(p, now)) {
    const vals = Object.values(scores);
    const total = vals.reduce((a, b) => a + b, 0);
    const p0 = 1 / Math.max(10, vals.length);
    // Narrow users (few interests) get a higher per-topic ceiling than broad ones (inverse Simpson).
    const h2 = total ? 1 / vals.reduce((a, v) => a + (v / total) ** 2, 0) : 0;
    const cap = h2 ? Math.min(6, Math.max(3, Math.ceil(P.W / h2))) : 3;
    return (cid) => {
      if (hidOf(p, cid, now) >= P.HIDE_OFF) return 0;
      const share = ((scores[cid] ?? 0) + P.KAPPA * p0) / (total + P.KAPPA);
      const q = Math.min(cap, Math.max(1, Math.round(P.W * share * Math.exp(-P.SAT_GAMMA * debtOf(p, cid, now)))));
      return (p.boost?.[cid] ?? 0) > now ? Math.max(q, 3) : q;
    };
  }

  // Record every post that scrolls by: tag frequencies, authors per tag, co-occurrence pairs.
  function observe(p, post, now) {
    ensure(p);
    const tags = cleanTags(post.tags);
    p.n++;
    for (const t of tags) {
      const s = (p.tags[t] ??= { n: 0, a: [], e: 0, f: 0, s: 0, t: now });
      s.n++;
      if (post.blog && !s.a.includes(post.blog) && s.a.length < 2) s.a.push(post.blog); // two blogs is all a topic needs
    }
    for (let i = 0; i < tags.length; i++)
      for (let j = i + 1; j < tags.length; j++) {
        const k = tags[i] < tags[j] ? `${tags[i]}|${tags[j]}` : `${tags[j]}|${tags[i]}`;
        p.pairs[k] = (p.pairs[k] ?? 0) + 1;
      }
    // seen = how often the blog posts (its rate); shown posts are counted in learnImpression
    if (post.blog) (p.blogs[post.blog] ??= { w: 0, t: now, seen: 0, eng: 0, first: now }).seen++;
    if (p.n % P.RECLUSTER_EVERY === 0) {
      recluster(p);
      // drop expired session state and impressions for topics we no longer track
      for (const k in p.debt) if (debtOf(p, k, now) < 0.01) delete p.debt[k];
      for (const k in p.boost) if (p.boost[k] <= now) delete p.boost[k];
      for (const k in p.hid) if (hidOf(p, k, now) < 0.2) delete p.hid[k];
      for (const k in p.imp) if (!p.tags[k]) delete p.imp[k];
    }
  }

  function pruneModel(p, now) {
    const f = p.m.f;
    const today = now / DAY;
    const keys = Object.keys(f);
    for (const k of keys) if (k !== 'b' && today - f[k][7] > P.STALE_DAYS) delete f[k];
    const topics = Object.keys(p.m.cv);
    if (topics.length > P.MAX_TOPICS) {
      topics.sort((a, b) => p.m.cv[a][1] - p.m.cv[b][1]);
      for (const k of topics.slice(0, topics.length - P.MAX_TOPICS)) delete p.m.cv[k];
    }
    const left = Object.keys(f);
    if (left.length > P.MAX_FEATS) {
      left.sort((a, b) => f[a][6] - f[b][6] || f[a][7] - f[b][7]);
      for (const k of left.slice(0, left.length - P.MAX_FEATS)) if (k !== 'b') delete f[k];
    }
  }

  function prune(p) {
    if (p.n > 4000) {
      // halve counts so co-occurrence stats track the recent stream
      p.n /= 2;
      for (const s of Object.values(p.tags)) s.n /= 2;
      for (const k in p.pairs) if ((p.pairs[k] /= 2) < 0.5) delete p.pairs[k];
    }
    const pairKeys = Object.keys(p.pairs);
    if (pairKeys.length > P.MAX_PAIRS) {
      pairKeys.sort((a, b) => p.pairs[a] - p.pairs[b]);
      for (const k of pairKeys.slice(0, pairKeys.length - P.MAX_PAIRS)) delete p.pairs[k];
    }
    const tagKeys = Object.keys(p.tags);
    if (tagKeys.length > P.MAX_TAG_STATS) {
      const keep = (s) => s.n + 50 * (s.f + s.s);
      tagKeys.sort((a, b) => keep(p.tags[a]) - keep(p.tags[b]));
      for (const k of tagKeys.slice(0, tagKeys.length - P.MAX_TAG_STATS)) delete p.tags[k];
    }
    const blogKeys = Object.keys(p.blogs);
    if (blogKeys.length > P.MAX_BLOGS) {
      const keep = (b) => 3 * b.eng + b.w + 0.05 * b.seen;
      blogKeys.sort((a, b) => keep(p.blogs[a]) - keep(p.blogs[b]));
      for (const k of blogKeys.slice(0, blogKeys.length - P.MAX_BLOGS)) delete p.blogs[k];
    }
  }

  // A tag whose co-tags are scattered over many unrelated topics (#iconic, #art) says nothing about
  // the post's topic, like commentary. Real topic tags keep most of their co-occurrences in a few partners.
  function markGeneric(p) {
    const partners = dict();
    for (const [k, c] of Object.entries(p.pairs)) {
      const [a, b] = k.split('|');
      (partners[a] ??= []).push(c);
      (partners[b] ??= []).push(c);
    }
    for (const [t, s] of Object.entries(p.tags)) {
      const cs = partners[t];
      delete s.g;
      if (!cs || s.n < P.GENERIC_MIN_N) continue;
      cs.sort((a, b) => b - a);
      if ((cs[0] + (cs[1] ?? 0) + (cs[2] ?? 0)) / s.n < P.GENERIC_TOP) s.g = 1;
    }
  }

  // NPMI graph + 3 rounds of label propagation; each cluster is named after its most frequent tag.
  function recluster(p) {
    ensure(p);
    prune(p);
    markGeneric(p);
    const adj = dict();
    for (const [k, c] of Object.entries(p.pairs)) {
      if (c < P.MIN_COOC) continue;
      const [a, b] = k.split('|');
      const na = p.tags[a]?.n, nb = p.tags[b]?.n;
      if (!na || !nb || p.tags[a].g || p.tags[b].g) continue;
      const pab = c / p.n;
      if (pab >= 1) continue;
      const npmi = Math.log(pab / ((na / p.n) * (nb / p.n))) / -Math.log(pab);
      if (npmi < P.NPMI) continue;
      (adj[a] ??= []).push([b, npmi]);
      (adj[b] ??= []).push([a, npmi]);
    }
    const label = dict();
    for (const t in adj) label[t] = t;
    for (let iter = 0; iter < 3; iter++)
      for (const t in adj) {
        const tally = dict();
        tally[label[t]] = 0.5 * Math.max(...adj[t].map(([, w]) => w));
        for (const [nb, w] of adj[t]) tally[label[nb]] = (tally[label[nb]] ?? 0) + w;
        label[t] = Object.keys(tally).reduce((x, y) => (tally[y] > tally[x] ? y : x));
      }
    const hub = dict();
    for (const [t, l] of Object.entries(label)) if (!hub[l] || p.tags[t].n > p.tags[hub[l]].n) hub[l] = t;
    p.map = dict();
    for (const [t, l] of Object.entries(label)) if (hub[l] !== t) p.map[t] = hub[l];
  }

  // Count familiar tags without a familiar partner in this post. Campaign evidence corroborates this signal.
  // Only well-known tags count: on real Tumblr most tag combinations are simply unseen yet, and unseen is
  // not unrelated. Spam stuffs popular tags to reach many feeds, so it still shows up as known strangers.
  function loners(p, all) {
    const tags = all.filter((t) => !p.tags[t]?.g && (p.tags[t]?.n ?? 0) >= P.KNOWN_TAG); // generic tags pair with everything and tell nothing
    if (tags.length < 2) return 0;
    // partners: seen together in at least one other post (observe() already counted this one), or in the same topic cluster
    const paired = (t, u) => (p.pairs[t < u ? `${t}|${u}` : `${u}|${t}`] ?? 0) >= 2 || clusterOf(p, t) === clusterOf(p, u);
    return tags.filter((t) => !tags.some((u) => u !== t && paired(t, u))).length;
  }

  function repeatedPromotion(p, post, unrelated) {
    const body = (post.body ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!post.destination && !/\b(shop|buy|sale|order|promo)\b/.test(body)) return false;
    const key = [post.blog, post.destination?.slice(0, 100), body.slice(0, 100)].join("|");
    if (!post.destination && body.length < 16) return false;
    const root = post.root ?? post.id;
    const campaigns = p.campaigns ??= [];
    const match = campaigns.find(entry => entry[0] === key);
    if (match && match[1] !== root && (match[2] || unrelated >= 2)) {
      match[2] = true;
      return true;
    }
    if (!match) {
      campaigns.push([key, root, unrelated >= 2]);
      if (campaigns.length > 128) campaigns.shift();
    }
    return false;
  }

  // What a post is about. `topic`: clusters that count as topics (a tag needs 2+ blogs using it or the
  // user's engagement, so one blog's personal tags never drive collapses), strongest interest first.
  // `all`: every non-generic cluster, for the model's features.
  function analyze(p, post, now) {
    const scores = clusterScores(p, now);
    const tags = cleanTags(post.tags);
    const topic = new Set(), all = new Set();
    for (const t of tags) {
      const s = p.tags[t];
      if (s?.g) continue;
      const c = clusterOf(p, t);
      all.add(c);
      if (s && (s.a.length >= 2 || s.e >= 1)) topic.add(c);
    }
    const rank = (a, b) => (scores[b] ?? 0) - (scores[a] ?? 0);
    return { tags, scores, topic: [...topic].sort(rank), all: [...all].sort(rank), loners: loners(p, tags) };
  }
  const clustersOf = (p, post, now) => analyze(p, post, now).topic.slice(0, P.TOP_CLUSTERS);

  // Gilbert & Karahalios-style tie strength, normalized by how often the blog posts:
  // a quiet friend you always like beats a firehose you sometimes like.
  function tieStrength(p, blog, pinned, now) {
    const pin = pinned.includes(blog) ? 10 : 0;
    const b = Object.hasOwn(p.blogs, blog) && p.blogs[blog];
    if (!b) return pin;
    const w = b.w * half(now - b.t, P.BLOG_HL_DAYS * DAY);
    // posts you were shown, not posts the engine folded: folding a blog must not lower its engagement rate
    const rate = Math.min(1, (b.eng + 1) / ((b.sh ? Math.max(b.sh, b.eng) : b.seen) + 4));
    const perDay = b.seen / Math.max(1, (now - b.first) / DAY);
    return pin + Math.log1p(w) * (0.5 + 1.5 * rate) * Math.min(2, Math.sqrt(3 / (perDay + 0.5)));
  }

  function recordInteraction(p, session, post, kind, now) {
    ensure(p);
    if (kind === 'expand') return;
    const tags = cleanTags(post.tags).filter((t) => !p.tags[t]?.g);
    // negatives count once per topic, not once per tag: a 6-tag post is one skip, not six
    if (kind === 'skip' || kind === 'hide') {
      const cids = new Set(tags.map((t) => clusterOf(p, t)));
      for (const cid of cids) {
        addDebt(p, cid, kind === 'hide' ? 2 : 0.65, now);
        // one "less like this" is split over the post's topics, so a tag-spam post can't blacklist five of them
        if (kind === 'hide') (p.hid ??= {})[cid] = [hidOf(p, cid, now) + 1 / cids.size, now];
      }
      // "less like this" also fades the recent interest, so it outlasts the session
      if (kind === 'hide') for (const t of tags) if (p.tags[t]) p.tags[t].f = sig4(p.tags[t].f * 0.5);
      return;
    }
    const w = WEIGHTS[kind] ?? 1;
    const weak = kind === 'dwell'; // reading is a hint about the topic, not about the blog or a new obsession
    if (post.blog && !weak) {
      const b = (p.blogs[post.blog] ??= { w: 0, t: now, seen: 1, eng: 0, first: now });
      b.w = sig4(b.w * half(now - b.t, P.BLOG_HL_DAYS * DAY) + w);
      b.t = now;
      b.eng++;
      // a post that came through a blog's reblog trail is a partial vote for that blog too
      for (const via of new Set(post.trail ?? [])) {
        const o = p.blogs[via];
        if (via === post.blog || !o) continue;
        o.w = sig4(o.w * half(now - o.t, P.BLOG_HL_DAYS * DAY) + 0.35 * w);
        o.t = now;
        o.eng = sig4(o.eng + 0.35);
      }
    }
    const split = 1 / Math.sqrt(Math.min(Math.max(tags.length, 1), 6));
    const touched = new Set();
    for (const t of tags) {
      const cid = clusterOf(p, t);
      const set = (session.engaged[cid] ??= new Set());
      if (!weak) set.add(post.root ?? post.id);
      // sustained intent: 3+ distinct posts in one topic this session is a real shift, follow it
      const sustained = set.size >= 3;
      const s = (p.tags[t] ??= { n: 1, a: [], e: 0, f: 0, s: 0, t: now });
      const add = w * split * (sustained ? 1.65 : 1);
      s.f = sig4(s.f * half(now - s.t, P.FAST_HL_DAYS * DAY) + add / 2);
      s.s = sig4(s.s * half(now - s.t, P.SLOW_HL_DAYS * DAY) + add / 2);
      s.t = now;
      s.e++;
      if (touched.has(cid)) continue;
      touched.add(cid);
      if (sustained) {
        p.debt[cid] = { d: 0, t: now };
        (p.boost ??= {})[cid] = now + 2 * 60 * MIN; // follow a real new obsession for the next 2h
      }
      else addDebt(p, cid, -0.35, now);
    }
  }

  // ---- value model ----

  // Collisionless sparse features of a post (Monolith-style string keys) and their values.
  function featuresOf(p, post, an) {
    const k = ['b'], x = [1];
    const nt = an.tags.length;
    for (const t of an.tags) (k.push(`t:${t}`), x.push(1 / Math.sqrt(nt)));
    for (const c of an.all) (k.push(`c:${c}`), x.push(P.X_TOPIC / Math.sqrt(an.all.length)));
    if (post.blog) (k.push(`a:${post.blog}`), x.push(1));
    let r = 0;
    for (const b of new Set(post.trail ?? [])) if (b !== post.blog && r++ < 4) (k.push(`r:${b}`), x.push(0.5));
    const top = an.topic[0] ?? an.all[0];
    if (post.blog && top) (k.push(`ac:${post.blog}|${top}`), x.push(1));
    const len = post.text?.length ?? 0;
    k.push(`l:${len < 200 ? 0 : len < 1000 ? 1 : 2}`, `nt:${Math.min(nt, 5)}`);
    x.push(1, 1);
    // tags that never appear together are a tag-stuffing signal
    if (an.loners >= 3) (k.push(`stuff:${Math.min(an.loners, 6)}`), x.push(1));
    // unit length, so the step size doesn't grow with the number of features a post happens to have
    const norm = 1 / Math.sqrt(x.reduce((a, v) => a + v * v, 0));
    return { k, x, u: x.map((v) => v * norm) };
  }
  const FEATS = new WeakMap(); // the features each post was scored with, reused when it is labeled

  const gauss = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  function weight(z, n, bias) {
    if (!bias && Math.abs(z) <= P.L1) return 0;
    return -(z - (bias ? 0 : Math.sign(z) * P.L1)) / ((P.BETA + Math.sqrt(n)) / P.ALPHA + P.L2);
  }

  // V = W_E pE + W_D pD - W_N pN. Thompson noise on the engaged logit: features the model has
  // rarely updated are uncertain, so new blogs and topics get tried and settled ones don't.
  function score(m, fv, rand) {
    let e = 0, d = 0, nn = 0, varsum = 0;
    for (let i = 0; i < fv.k.length; i++) {
      const r = m.f[fv.k[i]];
      const x = fv.x[i], u = fv.u[i];
      if (!r) {
        varsum += x * x;
        continue;
      }
      const bias = i === 0;
      e += u * weight(r[0], r[1], bias);
      d += u * weight(r[2], r[3], bias);
      nn += u * weight(r[4], r[5], bias);
      varsum += (x * x) / (1 + r[6]);
    }
    const pe = sigmoid(e + P.TS * Math.sqrt(varsum) * gauss(rand));
    const pd = sigmoid(d), pn = sigmoid(nn);
    return { v: P.W_E * pe + P.W_D * pd - P.W_N * pn, pe, pd, pn };
  }

  // Stochastic quantile tracking: th moves up when too few posts fall below it, down when too many.
  function track(m, v) {
    if (m.q) {
      m.q.push(v);
      if (m.q.length < 30) return;
      const s = [...m.q].sort((a, b) => a - b);
      m.th = s[Math.floor(P.Q_FOLD * 29)];
      m.hi = s[Math.floor(P.Q_HI * 29)];
      delete m.q;
      return;
    }
    m.th += P.ETA * (P.Q_FOLD - (v < m.th ? 1 : 0));
    m.hi += P.ETA * (P.Q_HI - (v < m.hi ? 1 : 0));
  }

  function nameOf(key) {
    const i = key.indexOf(':');
    const kind = key.slice(0, i), v = key.slice(i + 1);
    if (kind === 't' || kind === 'c') return `#${v}`;
    if (kind === 'a') return `@${v}`;
    if (kind === 'r') return `reblogs from @${v}`;
    if (kind === 'ac') return `@${v.split('|')[0]}'s #${v.split('|')[1]} posts`;
    if (kind === 'l') return ['short posts', 'medium-length posts', 'long text posts'][+v];
    if (kind === 'stuff') return 'posts stuffed with unrelated tags';
    return v === '0' ? 'untagged posts' : `posts with ${v}${v === '5' ? '+' : ''} tags`;
  }
  // The feature that pulls V down the most (linearized around the current prediction).
  function worstFeature(m, fv, sc) {
    let worst = null, low = 0;
    for (let i = 1; i < fv.k.length; i++) {
      const r = m.f[fv.k[i]];
      if (!r) continue;
      const c = fv.u[i] * (sc.pe * (1 - sc.pe) * P.W_E * weight(r[0], r[1]) + sc.pd * (1 - sc.pd) * P.W_D * weight(r[2], r[3]) - sc.pn * (1 - sc.pn) * P.W_N * weight(r[4], r[5]));
      if (c < low) (low = c), (worst = fv.k[i]);
    }
    return worst ? nameOf(worst) : 'posts like this';
  }

  // One label per impression (see content.js): out = { engaged, dwell, skip, hide, expanded }, booleans.
  // Trains the three heads on the post's features, then counts the impression toward warmth.
  function learnImpression(p, session, post, out, now) {
    const m = ensure(p);
    const fv = FEATS.get(post) ?? featuresOf(p, post, analyze(p, post, now));
    const day = Math.floor(now / DAY); // whole days, so a feature only fades once a day has passed
    const y = [out.engaged ? 1 : 0, out.dwell ? 1 : 0, out.skip || out.hide ? 1 : 0];
    const sw = [out.expanded ? 0.5 : 1, 1, out.hide ? 3 : 1];
    const recs = fv.k.map((key) => {
      const r = (m.f[key] ??= [0, 0, 0, 0, 0, 0, 0, day]);
      if (key !== 'b') {
        // old evidence fades, so an interest that changed can be relearned
        const d = half(Math.max(0, day - r[7]), P.MODEL_HL_DAYS);
        for (let j = 0; j < 6; j++) r[j] *= d;
      }
      return r;
    });
    for (let h = 0; h < 3; h++) {
      const zi = h * 2, ni = zi + 1;
      const ws = recs.map((r, i) => weight(r[zi], r[ni], i === 0));
      let dot = 0;
      for (let i = 0; i < ws.length; i++) dot += ws[i] * fv.u[i];
      const err = sigmoid(dot) - y[h];
      recs.forEach((r, i) => {
        const g = err * fv.u[i] * sw[h];
        const sigma = (Math.sqrt(r[ni] + g * g) - Math.sqrt(r[ni])) / P.ALPHA;
        r[zi] += g - sigma * ws[i];
        r[ni] += g * g;
      });
    }
    for (const r of recs) {
      for (let j = 0; j < 6; j++) r[j] = sig4(r[j]);
      r[6]++;
      r[7] = day;
    }
    m.k++;
    if (post.blog && p.blogs[post.blog]) p.blogs[post.blog].sh = (p.blogs[post.blog].sh ?? 0) + 1;
    if (m.k % 10 === 0) pruneModel(p, now);
  }

  const label = (cid) => `#${cid}`;
  const vText = (v) => ` · v=${v.toFixed(2)}`;

  // Decide one post against the session's sliding window. Returns { action, reason, clusters }.
  // action: favorite | show | explore | collapse
  function decide(p, session, post, pinned, now) {
    const m = ensure(p);
    const win = session.window;
    const authorCount = win.filter((x) => x.blog === post.blog).length;
    const root = post.root ?? post.id;
    const dup = rootSet(p).has(root);
    const tie = post.blog ? tieStrength(p, post.blog, pinned, now) : 0;
    const an = analyze(p, post, now);
    const clusters = an.topic.slice(0, P.TOP_CLUSTERS);
    // "less like this" on a topic outranks a friendship, except for pinned blogs
    const hidden = clusters.length > 0 && clusters.every((c) => hidOf(p, c, now) >= P.HIDE_OFF);
    const shown = (d, clusters, consumes) => {
      win.push({ blog: post.blog, clusters: consumes ? clusters : [] });
      if (win.length > P.W) win.shift();
      session.shown++;
      for (const c of clusters) {
        p.imp[c] = (p.imp[c] ?? 0) + 1;
        if (consumes) addDebt(p, c, 0.25, now);
      }
      return { ...d, clusters };
    };

    const recent = win.slice(-P.BURST_WINDOW).filter((x) => x.blog === post.blog).length;
    if (tie >= P.LANE && recent < P.MUTUAL_BURST && (!hidden || pinned.includes(post.blog))) {
      const why = pinned.includes(post.blog) ? 'pinned' : `tie ${tie.toFixed(1)}`;
      return shown({ action: 'favorite', reason: `mutual fast-lane: @${post.blog} (${why}, ${recent + 1}/${P.MUTUAL_BURST} mutual slots)` }, clusters, false);
    }
    // a blog you reliably engage with is never folded for crowding, whatever its topic
    const be = m.f[`a:${post.blog}`];
    const trusted = !hidden && (tie >= P.TRUST_TIE || (be && be[6] >= 2 && sigmoid(weight(m.f.b[0], m.f.b[1], true) + weight(be[0], be[1])) >= P.TRUST));
    if (dup && !trusted) return { action: 'collapse', reason: 'collapsed: reblog of a post you already saw', say: 'You already saw this post', clusters: [] };
    if (authorCount >= (trusted ? P.MUTUAL_BURST : P.AUTHOR_CAP))
      return { action: 'collapse', reason: `collapsed: @${post.blog} used ${authorCount}/${P.AUTHOR_CAP} recent author slots`, say: `More from @${post.blog} than everyone else lately`, tag: post.blog, clusters: [] };

    // value: what the model expects you to do with this post
    if (repeatedPromotion(p, post, an.loners))
      return { action: 'collapse', reason: `collapsed: tag-stuffed (${an.loners} tags that never appear together)`, say: 'Repeated promotion across unrelated tags', clusters: [] };
    const fv = featuresOf(p, post, an);
    FEATS.set(post, fv);
    const sc = score(m, fv, session.rand ?? Math.random);
    track(m, sc.v);
    session.last = sc; // for tests and the bench: what the model said about this post
    const warm = m.k >= P.WARM && !m.q;
    const fold = m.k >= P.WARM + P.VALUE_AFTER && !m.q; // value folds wait until the model has seen a while
    const vt = vText(sc.v);
    // Folded posts get no labels, so a topic folded during a bad patch would stay folded. Now and then
    // let one through as a second chance; what you do with it teaches the model either way.
    const foldByValue = (why = worstFeature(m, fv, sc)) => {
      // not for topics you asked for less of: that was an instruction, not a bad patch
      if (session.shown - (session.lastChance ?? 0) >= P.CHANCE_EVERY && !clusters.some((c) => hidOf(p, c, now) > 0.2)) {
        session.lastChance = session.shown + 1;
        return shown({ action: 'explore', reason: `second chance: you usually pass on ${why}, trying one again${vt}` }, clusters, true);
      }
      return { action: 'collapse', reason: `folded: you usually pass on ${why}${vt}`, say: 'You usually scroll past posts like this', clusters: [] };
    };

    // a topic whose typical post is already below the fold line is one you usually pass on
    const usual = clusters.length && clusters.every((c) => m.cv[c]?.[1] >= P.CV_MIN && m.cv[c][0] < m.th) ? clusters[0] : null;
    for (const c of clusters) {
      const e = (m.cv[c] ??= [sc.v, 0]);
      e[1] = Math.min(e[1] + 1, P.CV_WINDOW);
      e[0] = sig4(e[0] + (sc.v - e[0]) / e[1]);
    }
    if (!clusters.length) {
      if (fold && sc.v < m.th) return foldByValue();
      return shown({ action: 'show', reason: `shown: no topic tags (@${post.blog} ${authorCount + 1}/${P.AUTHOR_CAP} author slots)${vt}` }, [], false);
    }

    const qf = quotaFn(p, now, an.scores);
    // before the model knows you, a topic only folds once it dominates what you've been shown
    const floor = warm ? 0 : Math.ceil((win.length / P.COLD_SHARE) * Math.max(0, 1 - m.k / P.WARM));
    const quota = (c) => qf(c) === 0 ? 0 : Math.max(qf(c) + Number(warm), floor);
    const used = (c) => win.filter((x) => x.clusters.includes(c)).length;
    // xQuAD-style rescue: collapse only if ALL of the post's topics are full. Before the model knows
    // you, only the strongest topic of a multi-topic post can open a slot, so one open topic can't carry a spam post.
    const open = (warm ? clusters : clusters.slice(0, 1)).find((c) => used(c) < quota(c));
    if (fold && usual && sc.v < m.hi) return foldByValue(label(usual));
    if (fold && sc.v < m.th) {
      const top = Object.keys(an.scores).sort((a, b) => an.scores[b] - an.scores[a]).slice(0, 3);
      if (!(open && top.includes(open))) return foldByValue();
    }
    if (open) {
      const tagVia = an.tags.find((t) => clusterOf(p, t) === open && t !== open);
      return shown({ action: 'show', reason: `shown: ${label(open)}${tagVia ? ` (via #${tagVia})` : ''} · slot ${used(open) + 1}/${quota(open)} of recent ${P.W}${vt}` }, clusters, true);
    }
    const crowded = clusters.reduce((a, b) => (used(b) / Math.max(1, quota(b)) > used(a) / Math.max(1, quota(a)) ? b : a));
    if (warm && (trusted || sc.v >= m.hi))
      return shown({ action: 'show', reason: trusted ? `shown: @${post.blog} is one of your regulars, though ${label(crowded)} is full${vt}` : `shown: strong match (top ${Math.round((1 - P.Q_HI) * 100)}%) though ${label(crowded)} is full${vt}` }, clusters, true);
    const novel = clusters.find((c) => quota(c) > 0 && (p.imp[c] ?? 0) < P.NOVEL_IMPRESSIONS);
    // the discovery slot opens every EXPLORE_EVERY shown posts and waits for a novel post to use it
    if (novel && session.shown - session.lastExplore >= P.EXPLORE_EVERY - 1) {
      session.lastExplore = session.shown + 1;
      return shown({ action: 'explore', reason: `fresh pick: exploring ${label(novel)} (1-in-${P.EXPLORE_EVERY} discovery slot)${vt}` }, clusters, true);
    }
    if (quota(crowded) === 0)
      return { action: 'collapse', reason: `collapsed: you asked for less ${label(crowded)}${vt}`, say: `You asked for less ${label(crowded)}`, tag: crowded, clusters };
    const cooling = debtOf(p, crowded, now) > 1.5;
    return {
      action: 'collapse',
      reason: cooling
        ? `collapsed: cooling down ${label(crowded)} (${used(crowded)} shown recently, limit ${quota(crowded)} while it cools)${vt}`
        : `collapsed: ${label(crowded)} used ${used(crowded)}/${quota(crowded)} of its recent slots${vt}`,
      say: cooling ? `Giving ${label(crowded)} a rest for a bit` : `You've seen a lot of ${label(crowded)} lately`,
      tag: crowded,
      clusters,
    };
  }

  // Apply the 1.2-style gates to today's profile with a separate chronological window.
  function shadowFold(p, s, post, pinned, now) {
    const root = post.root ?? post.id;
    const duplicate = s.roots.has(root);
    s.roots.add(root);
    const author = s.window.filter(x => x.blog === post.blog).length;
    const friend = tieStrength(p, post.blog, pinned, now) >= 1.8 && author < 3;
    if (!friend && (duplicate || author >= 2)) return true;
    const clusters = clustersOf(p, post, now);
    const quota = quotaFn(p, now);
    const full = clusters.length && clusters.every(c => s.window.filter(x => x.clusters.includes(c)).length >= quota(c));
    if (!friend && full) {
      if (s.shown - s.lastExplore < P.EXPLORE_EVERY - 1 || !clusters.some(c => (p.imp[c] ?? 0) < P.NOVEL_IMPRESSIONS)) return true;
      s.lastExplore = s.shown + 1;
    }
    s.window.push({ blog: post.blog, clusters: friend ? [] : clusters });
    if (s.window.length > P.W) s.window.shift();
    s.shown++;
    return false;
  }

  const event = { shadow: 1, fold: 2, visible: 4, open: 8, like: 16, reblog: 32, hide: 64, read: 128, dwell: 256, skip: 512 };

  function audit(p, key, flags, create = false) {
    const rows = p.audit ??= [];
    const row = rows.findLast(x => x[0] === key);
    if (row) {
      // Snapshot the actual render on first exposure, after any preload-time settings changes.
      if ((flags & 4) && !(row[1] & 4)) row[1] = (row[1] & ~3) | (flags & 3);
      row[1] |= flags & ~3;
    }
    else if (create) {
      rows.push([key, flags]);
      if (rows.length > 512) rows.shift();
    }
  }
  function deviceStats(p) {
    const rows = (p.audit ?? []).map(x => x[1]).filter(x => x & event.visible);
    const counts = xs => {
      const folds = xs.filter(x => x & event.fold);
      const shown = xs.filter(x => x & event.read);
      const count = flag => shown.filter(x => x & flag).length;
      const rate = (n, d) => d ? n + '/' + d + ' (' + Math.round(100 * n / d) + '%)' : '0/0';
      return rate(folds.filter(x => x & event.open).length, folds.length) + ' folds opened, ' +
        rate(count(event.like) + count(event.reblog), shown.length) + ' Like/Reblog presses per shown post, ' +
        rate(count(event.hide), shown.length) + ' hides per shown post, ' + count(event.dwell) + ' reads of 4s or longer and ' + count(event.skip) + ' quick skips';
    };
    return 'Recent visible For you posts: ' + counts(rows) +
      '. Only Dashwell folded: ' + counts(rows.filter(x => (x & 3) === 2)) +
      '. Only the older rules would fold: ' + counts(rows.filter(x => (x & 3) === 1)) + '.';
  }

  function favorites(p, pinned, now, limit = 25) {
    const auto = Object.keys(p.blogs ?? {})
      .map((b) => [b, tieStrength(p, b, [], now)])
      .filter(([, t]) => t >= P.TIE)
      .sort((a, b) => b[1] - a[1])
      .map(([b]) => b);
    return [...new Set([...pinned, ...auto])].slice(0, limit);
  }

  function topInterests(p, now, limit = 10) {
    return Object.entries(clusterScores(p, now))
      .map(([tag, score]) => ({ tag, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // Mute list: one rule per line. "@blog" matches the poster or anyone in the reblog trail,
  // "#tag" matches a tag exactly, anything else matches tags or text as a whole word or phrase.
  function parseMutes(text) {
    return String(text ?? '')
      .split(/[\n,]/)
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean)
      .map((r) => (r.startsWith('@') ? { blog: r.slice(1) } : r.startsWith('#') ? { tag: r.slice(1).trim() } : { word: r }));
  }
  const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function mutedBy(rules, post) {
    const tags = post.tags.map((t) => t.toLowerCase().replace(/^#+/, '').trim());
    const blogs = [post.blog, ...(post.trail ?? [])].filter(Boolean).map((b) => b.toLowerCase());
    const text = `${tags.join(' ')} ${post.text ?? ''}`.toLowerCase();
    for (const r of rules) {
      if (r.blog && blogs.includes(r.blog)) return `@${r.blog}`;
      if (r.tag && tags.includes(r.tag)) return `#${r.tag}`;
      if (r.word && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(r.word)}($|[^\\p{L}\\p{N}])`, 'u').test(text)) return `"${r.word}"`;
    }
    return null;
  }

  globalThis.TumblrNew = {
    parseMutes, mutedBy, remember, shadowFold, audit, deviceStats, event,
    P, emptyProfile, newSession, cleanTags, observe, recluster, decide, recordInteraction, learnImpression,
    tieStrength, favorites, topInterests, quotaFn, clustersOf,
  };
})();
