// DOM glue for tumblr.com. The feed engine lives in feed.js (globalThis.TumblrNew).
// shortcut: selectors come from Tumblr's rendered markup (Nov 2026); re-check them when Tumblr redesigns.
const T = globalThis.TumblrNew;
const ARTICLE = '[data-id] article';
const SPONSORED = ':is([data-cell-id], [data-id]):is(:has(.iab_sf), :has(a[href*="/relevantads"])), aside div:has(> div > div > [id^="aditude"])';
const DEFAULTS = { hidePremium: true, showAlgo: true, shapeFeed: true };
const FAST_SKIP_MS = 300;

const session = T.newSession();
const decisions = new Map(); // post id -> decision; Tumblr's list re-mounts posts on scroll
const posts = new Map(); // post id -> parsed post
const ads = new Set();
const log = [];
let engine = T.emptyProfile();
let pinned = [];
let settings = DEFAULTS;
let dirty = false;

// The logged-in home is "/" or "/dashboard..."; tag and blog pages are skipped because
// every post there shares a topic or an author and would all collapse.
const onFeed = () => location.pathname === '/' || location.pathname.startsWith('/dashboard');

function readPost(article) {
  const id = article.closest('[data-id]')?.dataset.id;
  // Reblog trails link to earlier posts as /blog/postId; the last one that isn't this post is the root.
  const root = [...article.querySelectorAll('a[href]')]
    .map((a) => a.getAttribute('href').match(/^(?:https:\/\/www\.tumblr\.com)?\/[\w-]+\/(\d{6,})/)?.[1])
    .filter((x) => x && x !== id)
    .at(-1);
  return {
    id,
    root: root ?? id,
    blog: article.querySelector('header a[rel="author"]')?.textContent.trim(),
    tags: [...article.querySelectorAll('a[data-testid="tag-link"]')].map((a) => a.textContent),
  };
}

function save() {
  dirty = true;
}
setInterval(() => {
  if (dirty) chrome.storage.local.set({ engine }), (dirty = false);
}, 5000);
addEventListener('visibilitychange', () => document.hidden && dirty && (chrome.storage.local.set({ engine }), (dirty = false)));

function learn(post, kind, note) {
  T.recordInteraction(engine, session, post, kind, Date.now());
  if (note) log.push(note);
  save();
}

function render(article, post, d) {
  article.querySelector('.tn-why')?.remove();
  const why = document.createElement('div');
  why.className = `tn-why tn-${d.action}`;
  why.textContent = d.reason;
  article.prepend(why);
  article.classList.toggle('tn-favorite', d.action === 'favorite');

  if (d.action !== 'collapse' || d.shown || !settings.shapeFeed || article.querySelector('.tn-bar')) return;
  article.classList.add('tn-collapsed');
  const bar = document.createElement('div');
  bar.className = 'tn-bar';
  bar.textContent = d.reason.replace(/^collapsed: /, 'Hidden: ');
  const btn = document.createElement('button');
  btn.textContent = 'Show anyway';
  btn.onclick = () => {
    d.shown = true;
    article.classList.remove('tn-collapsed');
    bar.remove();
    learn(post, 'expand', `you opened a hidden post: ${post.tags.slice(0, 2).join(' ')}`);
  };
  bar.append(btn);
  article.prepend(bar);
}

// Fast-skip = a post that was on screen for under 300 ms: a quiet "not now" for its topics.
const visibleSince = new Map();
const skipWatcher = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const id = e.target.closest('[data-id]')?.dataset.id;
    if (!id) continue;
    if (e.isIntersecting) visibleSince.set(id, e.time);
    else if (visibleSince.has(id)) {
      const ms = e.time - visibleSince.get(id);
      visibleSince.delete(id);
      const d = decisions.get(id);
      if (ms < FAST_SKIP_MS && d && d.action !== 'collapse' && posts.has(id)) learn(posts.get(id), 'skip');
    }
  }
}, { threshold: 0.5 });

let hud;
function drawHud(found) {
  if (!document.body) return;
  if (!hud) {
    hud = document.createElement('aside');
    hud.className = 'tn-hud';
    hud.onclick = () => hud.classList.toggle('tn-min');
    document.body.append(hud);
  }
  const count = (a) => [...decisions.values()].filter((d) => d.action === a).length;
  const lines = [
    'tumblr-new · CaliStream (click to fold)',
    !onFeed()
      ? 'not the dashboard: feed shaping paused here'
      : decisions.size || found
        ? `read ${decisions.size} · shown ${count('show')} · mutuals ${count('favorite')} · explored ${count('explore')} · hidden ${count('collapse')}`
        : 'waiting for posts… if this stays, Tumblr changed its markup',
    `sponsored hidden: ${ads.size}${settings.shapeFeed ? '' : ' · shaping OFF (labels only)'}`,
    `learned: ${Object.keys(engine.tags).length} tags in ${T.topInterests(engine, Date.now(), 999).length} topics · ${T.favorites(engine, pinned, Date.now()).length} mutuals`,
    `top: ${T.topInterests(engine, Date.now(), 4).map((i) => '#' + i.tag).join(' ') || 'like or reblog posts to teach it'}`,
    ...log.slice(-5).reverse(),
  ];
  hud.replaceChildren(...lines.map((l, i) => Object.assign(document.createElement(i ? 'div' : 'b'), { textContent: l })));
}

function scan() {
  for (const cell of document.querySelectorAll(SPONSORED)) ads.add(cell);
  let found = 0;
  if (onFeed()) {
    for (const article of document.querySelectorAll(`${ARTICLE}:not([data-tn])`)) {
      found++;
      article.dataset.tn = '1';
      const post = readPost(article);
      if (!post.id) continue;
      if (!decisions.has(post.id)) {
        const now = Date.now();
        T.observe(engine, post, now);
        const d = T.decide(engine, session, post, pinned, now);
        decisions.set(post.id, d);
        posts.set(post.id, post);
        log.push(`${post.blog ?? '?'}: ${d.reason}`);
        save();
      }
      render(article, post, decisions.get(post.id));
      skipWatcher.observe(article);
    }
  }
  if (settings.showAlgo) drawHud(found);
}

function applySettings() {
  const html = document.documentElement.classList;
  html.toggle('tn-hide-premium', settings.hidePremium);
  html.toggle('tn-show-algo', settings.showAlgo);
  if (!settings.showAlgo) hud?.remove(), (hud = null);
}

// Learn from likes and reblogs. Clicking "Like" only happens on a not-yet-liked post.
document.addEventListener(
  'click',
  (e) => {
    const btn = e.target.closest?.('button[aria-label="Like"], button[aria-label="Reblog"]');
    const article = btn?.closest('article');
    if (!article) return;
    const post = readPost(article);
    const kind = btn.ariaLabel === 'Reblog' ? 'reblog' : 'like';
    learn(post, kind, `learned from ${kind}: @${post.blog ?? '?'} ${post.tags.slice(0, 3).join(' ')}`);
  },
  true,
);

chrome.storage.onChanged.addListener((changes) => {
  if (changes.pinned) pinned = changes.pinned.newValue ?? [];
  if (changes.settings) {
    settings = { ...DEFAULTS, ...changes.settings.newValue };
    applySettings();
  }
  if (changes.engine && !changes.engine.newValue) engine = T.emptyProfile(); // reset from popup
  scan();
});

chrome.storage.local.get({ engine: null, pinned, settings }).then((s) => {
  engine = s.engine ?? T.emptyProfile();
  pinned = s.pinned;
  settings = { ...DEFAULTS, ...s.settings };
  applySettings();
  scan();
  let queued = false;
  new MutationObserver((muts) => {
    // our own HUD redraws would otherwise re-trigger scan every frame
    if (queued || muts.every((m) => hud?.contains(m.target))) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
});
