// Pure feed logic, no DOM or browser APIs, so it can be reused later in a mobile app.
(() => {
  const DAY = 864e5;
  const HALF_LIFE_DAYS = 30; // old likes fade slowly instead of being forgotten
  const WINDOW = 12; // how many recent dashboard posts we look back over
  const MIN_PER_WINDOW = 2; // every topic gets at least this many slots per window
  const FAVORITE_AFFINITY = 1.5; // log1p(weight), roughly 3-4 recent interactions
  const MAX_TAGS = 500;

  const norm = (tag) => tag.toLowerCase().replace(/^#/, '').trim();
  const emptyProfile = () => ({ tags: {}, blogs: {} });

  const decayed = (e, now) => (e ? e.w * 0.5 ** ((now - e.t) / (HALF_LIFE_DAYS * DAY)) : 0);
  // log1p gives diminishing returns: one like on a new topic can't outweigh months of history
  const score = (e, now) => Math.log1p(decayed(e, now));

  function bump(map, key, amount, now) {
    map[key] = { w: decayed(map[key], now) + amount, t: now };
  }

  function prune(map, now) {
    const keys = Object.keys(map);
    if (keys.length <= MAX_TAGS) return;
    keys.sort((a, b) => decayed(map[b], now) - decayed(map[a], now));
    for (const k of keys.slice(MAX_TAGS)) delete map[k];
  }

  // weight: like = 1, reblog = 2. One interaction is split across its tags,
  // so a post with 30 tags doesn't count 30 times.
  function recordInteraction(profile, post, weight, now) {
    const tags = [...new Set(post.tags.map(norm))].filter(Boolean);
    for (const t of tags) bump(profile.tags, t, weight / tags.length, now);
    if (post.blog) bump(profile.blogs, post.blog, weight, now);
    prune(profile.tags, now);
    prune(profile.blogs, now);
  }

  function isFavorite(profile, pinned, blog, now) {
    return pinned.includes(blog) || score(profile.blogs[blog], now) >= FAVORITE_AFFINITY;
  }

  function favorites(profile, pinned, now, limit = 30) {
    const auto = Object.keys(profile.blogs)
      .filter((b) => score(profile.blogs[b], now) >= FAVORITE_AFFINITY)
      .sort((a, b) => score(profile.blogs[b], now) - score(profile.blogs[a], now));
    return [...new Set([...pinned, ...auto])].slice(0, limit);
  }

  function topInterests(profile, now, limit = 10) {
    return Object.keys(profile.tags)
      .map((tag) => ({ tag, score: score(profile.tags[tag], now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // Slots a tag may take in the recent window: proportional to its share of your
  // long-term interest, never less than MIN_PER_WINDOW.
  function allowedSlots(profile, tag, now) {
    let total = 0;
    for (const k in profile.tags) total += score(profile.tags[k], now);
    const share = total ? score(profile.tags[tag], now) / total : 0;
    return Math.max(MIN_PER_WINDOW, Math.round(WINDOW * share));
  }

  // recent: array of tag-arrays for the last posts shown (mutated).
  // Returns { action: 'favorite' | 'show' | 'collapse', tag? }.
  function decide(profile, pinned, recent, post, now) {
    const tags = [...new Set(post.tags.map(norm))].filter(Boolean);
    let result = { action: 'show' };
    if (post.blog && isFavorite(profile, pinned, post.blog, now)) {
      result = { action: 'favorite' };
    } else {
      for (const tag of tags) {
        const seen = recent.filter((r) => r.includes(tag)).length;
        if (seen >= allowedSlots(profile, tag, now)) return { action: 'collapse', tag, seen };
      }
    }
    recent.push(tags);
    if (recent.length > WINDOW) recent.shift();
    return result;
  }

  globalThis.TumblrNew = { emptyProfile, recordInteraction, decide, favorites, topInterests, isFavorite, norm };
})();
