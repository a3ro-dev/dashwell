// CaliStream-3S feed engine: pure JS, no DOM or browser APIs, so it ports to a mobile app.
// Calibrated slots with Dirichlet shrinkage, session satiation, NPMI tag clustering,
// frequency-normalized mutual tie strength, author spacing, reblog dedup, 1-in-10 exploration.
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
    TIE: 1.8, // strong-tie (mutual) threshold
    MUTUAL_BURST: 3, // uncollapsible mutual posts per window
    AUTHOR_CAP: 2, // posts per non-mutual author per window
    EXPLORE_EVERY: 10,
    NOVEL_IMPRESSIONS: 15,
    MAX_TAGS: 12, // authors put real topic tags first
    TOP_CLUSTERS: 3,
    RECLUSTER_EVERY: 50,
    MAX_TAG_STATS: 1500,
    MAX_PAIRS: 8000,
  };
  const WEIGHTS = { like: 1, reblog: 2.2, comment: 2.5, expand: 1.2 };
  const META = new Set(['reblog', 'reblogs', 'mine', 'queued', 'queue', 'long post', 'fy', 'fyp', 'personal', 'text', 'photo', 'video', 'tumblr', 'repost']);
  // matched against `tag + ' '`, so "sob" catches "#sob" but not "#sobriety"
  const COMMENTARY = /^(i|im|i'm|my|me|you|we|he|she|they|this|that|wait|omg|lol|literally|screaming|crying|sob|help|op|bro|guys|also|anyway|update|real|mood|same) /;
  const NO_STEM = new Set(['series', 'species', 'news', 'glasses', 'aesthetics', 'physics', 'mathematics', 'pokemon']);

  const half = (dt, hlMs) => 0.5 ** (dt / hlMs);

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

  const emptyProfile = () => ({ n: 0, boost: {}, tags: {}, pairs: {}, map: {}, blogs: {}, debt: {}, imp: {} });
  const newSession = () => ({ window: [], shown: 0, roots: new Set(), engaged: {} });

  const tagWeight = (s, now) => (s ? (s.f ?? 0) * half(now - s.t, P.FAST_HL_DAYS * DAY) + (s.s ?? 0) * half(now - s.t, P.SLOW_HL_DAYS * DAY) : 0);
  const clusterOf = (p, tag) => p.map[tag] ?? tag;

  function debtOf(p, cid, now) {
    const d = p.debt[cid];
    return d ? d.d * half(now - d.t, P.SAT_HL_MIN * MIN) : 0;
  }
  function addDebt(p, cid, amount, now) {
    p.debt[cid] = { d: Math.max(0, debtOf(p, cid, now) + amount), t: now };
  }

  // Long-term interest per cluster = log1p(sum of member tag weights).
  function clusterScores(p, now) {
    const sums = {};
    for (const [tag, s] of Object.entries(p.tags)) {
      const w = tagWeight(s, now);
      if (w > 1e-3) sums[clusterOf(p, tag)] = (sums[clusterOf(p, tag)] ?? 0) + w;
    }
    for (const k in sums) sums[k] = Math.log1p(sums[k]);
    return sums;
  }

  function quotaFn(p, now) {
    const scores = clusterScores(p, now);
    const vals = Object.values(scores);
    const total = vals.reduce((a, b) => a + b, 0);
    const p0 = 1 / Math.max(10, vals.length);
    // Narrow users (few interests) get a higher per-topic ceiling than broad ones (inverse Simpson).
    const h2 = total ? 1 / vals.reduce((a, v) => a + (v / total) ** 2, 0) : 0;
    const cap = h2 ? Math.min(6, Math.max(3, Math.ceil(P.W / h2))) : 3;
    return (cid) => {
      const share = ((scores[cid] ?? 0) + P.KAPPA * p0) / (total + P.KAPPA);
      const q = Math.min(cap, Math.max(1, Math.round(P.W * share * Math.exp(-P.SAT_GAMMA * debtOf(p, cid, now)))));
      return (p.boost?.[cid] ?? 0) > now ? Math.max(q, 3) : q;
    };
  }

  // Record every post that scrolls by: tag frequencies, authors per tag, co-occurrence pairs.
  function observe(p, post, now) {
    const tags = cleanTags(post.tags);
    p.n++;
    for (const t of tags) {
      const s = (p.tags[t] ??= { n: 0, a: [], e: 0, f: 0, s: 0, t: now });
      s.n++;
      if (post.blog && !s.a.includes(post.blog) && s.a.length < 4) s.a.push(post.blog);
    }
    for (let i = 0; i < tags.length; i++)
      for (let j = i + 1; j < tags.length; j++) {
        const k = tags[i] < tags[j] ? `${tags[i]}|${tags[j]}` : `${tags[j]}|${tags[i]}`;
        p.pairs[k] = (p.pairs[k] ?? 0) + 1;
      }
    if (post.blog) {
      const b = (p.blogs[post.blog] ??= { w: 0, t: now, seen: 0, eng: 0, first: now });
      b.seen++;
    }
    if (p.n % P.RECLUSTER_EVERY === 0) {
      recluster(p);
      // drop expired session state and impressions for topics we no longer track
      for (const k in p.debt) if (debtOf(p, k, now) < 0.01) delete p.debt[k];
      for (const k in p.boost) if (p.boost[k] <= now) delete p.boost[k];
      for (const k in p.imp) if (!p.tags[k]) delete p.imp[k];
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
  }

  // NPMI graph + 3 rounds of label propagation; each cluster is named after its most frequent tag.
  function recluster(p) {
    prune(p);
    const adj = {};
    for (const [k, c] of Object.entries(p.pairs)) {
      if (c < P.MIN_COOC) continue;
      const [a, b] = k.split('|');
      const na = p.tags[a]?.n, nb = p.tags[b]?.n;
      if (!na || !nb) continue;
      const pab = c / p.n;
      if (pab >= 1) continue;
      const npmi = Math.log(pab / ((na / p.n) * (nb / p.n))) / -Math.log(pab);
      if (npmi < P.NPMI) continue;
      (adj[a] ??= []).push([b, npmi]);
      (adj[b] ??= []).push([a, npmi]);
    }
    const label = {};
    for (const t in adj) label[t] = t;
    for (let iter = 0; iter < 3; iter++)
      for (const t in adj) {
        const tally = { [label[t]]: 0.5 * Math.max(...adj[t].map(([, w]) => w)) };
        for (const [nb, w] of adj[t]) tally[label[nb]] = (tally[label[nb]] ?? 0) + w;
        label[t] = Object.keys(tally).reduce((x, y) => (tally[y] > tally[x] ? y : x));
      }
    const hub = {};
    for (const [t, l] of Object.entries(label)) if (!hub[l] || p.tags[t].n > p.tags[hub[l]].n) hub[l] = t;
    p.map = {};
    for (const [t, l] of Object.entries(label)) if (hub[l] !== t) p.map[t] = hub[l];
  }

  // A tag counts as a topic once 2+ blogs use it or the user engaged with it,
  // so one blog's personal tags ("#akshat speaks") never drive collapses.
  function clustersOf(p, post, now) {
    const scores = clusterScores(p, now);
    const ids = new Set();
    for (const t of cleanTags(post.tags)) {
      const s = p.tags[t];
      if (s && (s.a.length >= 2 || s.e >= 1)) ids.add(clusterOf(p, t));
    }
    return [...ids].sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0)).slice(0, P.TOP_CLUSTERS);
  }

  // Gilbert & Karahalios-style tie strength, normalized by how often the blog posts:
  // a quiet friend you always like beats a firehose you sometimes like.
  function tieStrength(p, blog, pinned, now) {
    const pin = pinned.includes(blog) ? 10 : 0;
    const b = p.blogs[blog];
    if (!b) return pin;
    const w = b.w * half(now - b.t, P.BLOG_HL_DAYS * DAY);
    const rate = (b.eng + 1) / (b.seen + 4);
    const perDay = b.seen / Math.max(1, (now - b.first) / DAY);
    return pin + Math.log1p(w) * (0.5 + 1.5 * rate) * Math.min(2, Math.sqrt(3 / (perDay + 0.5)));
  }

  function recordInteraction(p, session, post, kind, now) {
    const tags = cleanTags(post.tags);
    if (kind === 'skip') {
      for (const t of tags) addDebt(p, clusterOf(p, t), 0.65, now);
      return;
    }
    const w = WEIGHTS[kind] ?? 1;
    if (post.blog) {
      const b = (p.blogs[post.blog] ??= { w: 0, t: now, seen: 1, eng: 0, first: now });
      b.w = b.w * half(now - b.t, P.BLOG_HL_DAYS * DAY) + w;
      b.t = now;
      b.eng++;
    }
    const split = 1 / Math.sqrt(Math.min(Math.max(tags.length, 1), 6));
    const touched = new Set();
    for (const t of tags) {
      const cid = clusterOf(p, t);
      const set = (session.engaged[cid] ??= new Set());
      set.add(post.root ?? post.id);
      // sustained intent: 3+ distinct posts in one topic this session is a real shift, follow it
      const sustained = set.size >= 3;
      const s = (p.tags[t] ??= { n: 1, a: [], e: 0, f: 0, s: 0, t: now });
      const add = w * split * (sustained ? 1.65 : 1);
      s.f = s.f * half(now - s.t, P.FAST_HL_DAYS * DAY) + add / 2;
      s.s = s.s * half(now - s.t, P.SLOW_HL_DAYS * DAY) + add / 2;
      s.t = now;
      s.e++;
      if (touched.has(cid)) continue;
      touched.add(cid);
      if (sustained) {
        p.debt[cid] = { d: 0, t: now };
        (p.boost ??= {})[cid] = now + 2 * 60 * MIN; // follow a real new obsession for the next 2h
      }
      else addDebt(p, cid, kind === 'expand' ? -0.5 : -0.35, now);
    }
  }

  const label = (cid) => `#${cid}`;

  // Decide one post against the session's sliding window. Returns { action, reason, clusters }.
  // action: favorite | show | explore | collapse
  function decide(p, session, post, pinned, now) {
    const win = session.window;
    const authorCount = win.filter((x) => x.blog === post.blog).length;
    const root = post.root ?? post.id;
    const dup = session.roots.has(root);
    session.roots.add(root);
    const tie = post.blog ? tieStrength(p, post.blog, pinned, now) : 0;
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

    if (tie >= P.TIE && authorCount < P.MUTUAL_BURST) {
      const why = pinned.includes(post.blog) ? 'pinned' : `tie ${tie.toFixed(1)}`;
      return shown({ action: 'favorite', reason: `mutual fast-lane: @${post.blog} (${why}, ${authorCount + 1}/${P.MUTUAL_BURST} mutual slots)` }, clustersOf(p, post, now), false);
    }
    if (dup) return { action: 'collapse', reason: 'collapsed: reblog of a post you already saw', clusters: [] };
    if (authorCount >= P.AUTHOR_CAP) return { action: 'collapse', reason: `collapsed: @${post.blog} used ${authorCount}/${P.AUTHOR_CAP} recent author slots`, clusters: [] };

    const clusters = clustersOf(p, post, now);
    if (!clusters.length) return shown({ action: 'show', reason: `shown: no topic tags (@${post.blog} ${authorCount + 1}/${P.AUTHOR_CAP} author slots)` }, [], false);

    const quota = quotaFn(p, now);
    const used = (c) => win.filter((x) => x.clusters.includes(c)).length;
    // xQuAD-style rescue: collapse only if ALL of the post's topics are full
    const open = clusters.find((c) => used(c) < quota(c));
    if (open) {
      const via = cleanTags(post.tags).find((t) => clusterOf(p, t) === open && t !== open);
      return shown({ action: 'show', reason: `shown: ${label(open)}${via ? ` (via #${via})` : ''} · slot ${used(open) + 1}/${quota(open)} of recent ${P.W}` }, clusters, true);
    }
    const novel = clusters.find((c) => (p.imp[c] ?? 0) < P.NOVEL_IMPRESSIONS);
    if (novel && session.shown % P.EXPLORE_EVERY === P.EXPLORE_EVERY - 1) {
      return shown({ action: 'explore', reason: `fresh pick: exploring ${label(novel)} (1-in-${P.EXPLORE_EVERY} discovery slot)` }, clusters, true);
    }
    const crowded = clusters.reduce((a, b) => (used(b) / quota(b) > used(a) / quota(a) ? b : a));
    const cooling = debtOf(p, crowded, now) > 1.5;
    return {
      action: 'collapse',
      reason: cooling
        ? `collapsed: cooling down ${label(crowded)} this session (${used(crowded)}/${quota(crowded)} slots)`
        : `collapsed: ${label(crowded)} used ${used(crowded)}/${quota(crowded)} of its recent slots`,
      clusters,
    };
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

  globalThis.TumblrNew = {
    P, emptyProfile, newSession, cleanTags, observe, recluster, decide, recordInteraction,
    tieStrength, favorites, topInterests, quotaFn, clustersOf,
  };
})();
