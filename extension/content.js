// DOM glue for tumblr.com. The feed engine lives in feed.js (globalThis.TumblrNew).
// shortcut: selectors come from Tumblr's rendered markup (Nov 2026); re-check them when Tumblr redesigns.
const T = globalThis.TumblrNew;
const ARTICLE = '[data-id] article';
const SPONSORED = ':is([data-cell-id], [data-id]):is(:has(.iab_sf), :has(a[href*="/relevantads"])), aside div:has(> div > div > [id^="aditude"])';
const DEFAULTS = { hidePremium: true, shapeFeed: true };
const FAST_SKIP_MS = 300;

const session = T.newSession();
const decisions = new Map(); // post id -> decision; Tumblr's list re-mounts posts on scroll
const posts = new Map(); // post id -> parsed post
const ads = new Set();
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

function learn(post, kind) {
  T.recordInteraction(engine, session, post, kind, Date.now());
  save();
}

function render(article, post, d) {
  if (d.action !== 'collapse' || d.shown || !settings.shapeFeed || article.querySelector('.tn-bar')) return;
  article.classList.add('tn-collapsed');
  const bar = document.createElement('div');
  bar.className = 'tn-bar';
  const text = document.createElement('p');
  text.textContent = d.say ?? 'Hidden to keep your feed varied';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Show';
  btn.setAttribute('aria-label', `Show hidden post from @${post.blog ?? 'unknown'}`);
  btn.onclick = () => {
    d.shown = true;
    article.classList.remove('tn-collapsed');
    bar.remove();
    learn(post, 'expand');
  };
  bar.append(text, btn);
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

// Android app only: our settings live behind an icon in Tumblr's own top bar, next to Search.
const IS_APP = !!globalThis.__tnOpenSettings;
let unreadCount = 0;
function mountAppButton() {
  if (!IS_APP || document.querySelector('.tn-app-btn')) return;
  const search = document.querySelector('header button[aria-label="Search"]');
  if (!search) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tn-app-btn';
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg><span class="tn-count"></span>';
  btn.onclick = () => globalThis.__tnOpenSettings();
  search.before(btn);
  updateAppButton();
}
function updateAppButton() {
  const btn = document.querySelector('.tn-app-btn');
  if (!btn) return;
  btn.querySelector('.tn-count').textContent = unreadCount ? String(Math.min(unreadCount, 99)) : '';
  btn.setAttribute('aria-label', unreadCount ? `tumblr-new settings, ${unreadCount} new posts from favorites` : 'tumblr-new settings');
}

// Tumblr's "Rather use the mobile app?" banner and other app-store nags.
function hideAppNags() {
  for (const a of document.querySelectorAll('a[href*="play.google.com"], a[href*="apps.apple.com"], a[href^="intent:"], a[href^="tumblr:"]')) {
    if (a.closest('article')) continue;
    let box = a;
    while (box.parentElement && box.parentElement !== document.body && box.parentElement.innerText.length < 160) box = box.parentElement;
    box.style.setProperty('display', 'none', 'important');
  }
}

function scan() {
  for (const cell of document.querySelectorAll(SPONSORED)) ads.add(cell);
  if (onFeed()) {
    for (const article of document.querySelectorAll(`${ARTICLE}:not([data-tn])`)) {
      article.dataset.tn = '1';
      const post = readPost(article);
      if (!post.id) continue;
      if (!decisions.has(post.id)) {
        const now = Date.now();
        T.observe(engine, post, now);
        const d = T.decide(engine, session, post, pinned, now);
        decisions.set(post.id, d);
        posts.set(post.id, post);
        save();
      }
      render(article, post, decisions.get(post.id));
      skipWatcher.observe(article);
    }
  }
  hideAppNags();
  mountAppButton();
}

function applySettings() {
  document.documentElement.classList.toggle('tn-hide-premium', settings.hidePremium);
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
    learn(post, kind);
  },
  true,
);

chrome.storage.onChanged.addListener((changes) => {
  if (changes.pinned) pinned = changes.pinned.newValue ?? [];
  if (changes.settings) {
    settings = { ...DEFAULTS, ...changes.settings.newValue };
    applySettings();
  }
  if (changes.engine && !changes.engine.newValue) engine = T.emptyProfile(); // reset from settings
  if (changes.unread) (unreadCount = changes.unread.newValue?.length ?? 0), updateAppButton();
  scan();
});

chrome.storage.local.get({ engine: null, pinned, settings, unread: [] }).then((s) => {
  engine = s.engine ?? T.emptyProfile();
  unreadCount = s.unread.length;
  pinned = s.pinned;
  settings = { ...DEFAULTS, ...s.settings };
  applySettings();
  scan();
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
});
