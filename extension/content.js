// DOM glue for tumblr.com. The feed engine lives in feed.js (globalThis.TumblrNew).
// shortcut: selectors come from Tumblr's rendered markup (Nov 2026); re-check them when Tumblr redesigns.
const T = globalThis.TumblrNew;
const ARTICLE = '[data-id] article';
const SPONSORED = ':is([data-cell-id], [data-id]):is(:has(.iab_sf), :has(a[href*="/relevantads"])), aside div:has(> div > div > [id^="aditude"])';
const DEFAULTS = { hidePremium: true, shapeFeed: true, hideSuggestions: true, followingFirst: false };
const FAST_SKIP_MS = 300;

const session = T.newSession();
const decisions = new Map(); // post id -> decision; Tumblr's list re-mounts posts on scroll
const posts = new Map(); // post id -> parsed post
const ads = new Set();
let engine = T.emptyProfile();
let pinned = [];
let settings = DEFAULTS;
let mutes = [];
const followWindow = []; // blogs of recently shown posts on the chronological Following tab
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
  const trail = [
    ...new Set(
      [...article.querySelectorAll('a[href]')]
        .map((a) => a.getAttribute('href').match(/^(?:https:\/\/www\.tumblr\.com)?\/([\w-]+)\/\d{6,}/)?.[1])
        .filter(Boolean),
    ),
  ];
  return {
    id,
    trail,
    text: article.textContent.slice(0, 4000),
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
  btn.setAttribute('aria-label', unreadCount ? `Dashwell settings, ${unreadCount} new posts from favorites` : 'Dashwell settings');
}

// Tumblr's "Rather use the mobile app?" banner and other app-store nags.
function hideAppNags() {
  // Hide only the small banner around an app-store link. Never anything that holds Tumblr's own
  // page: while a page renders its containers can look empty, and climbing past them blanked the app.
  const PAGE = 'header, nav, main, article, [data-timeline-id], [data-cell-id], [role="dialog"]';
  for (const a of document.querySelectorAll('a[href*="play.google.com"], a[href*="apps.apple.com"], a[href^="intent:"], a[href^="tumblr:"]')) {
    if (a.closest('article, nav, [role="dialog"]') || a.dataset.tnNag) continue;
    a.dataset.tnNag = '1';
    let box = a;
    for (let i = 0; i < 4; i++) {
      const up = box.parentElement;
      if (!up || up === document.body || up.matches(PAGE) || up.querySelector(PAGE) || up.textContent.length > 200) break;
      box = up;
    }
    box.style.setProperty('display', 'none', 'important');
  }
}

// Mutes first (everywhere on the feed), then: Following stays chronological with only
// flood control; For you gets the full engine.
function decideHere(post, now) {
  const muted = T.mutedBy(mutes, post);
  if (muted) return { action: 'collapse', reason: `muted: ${muted}`, say: `Muted: ${muted}` };
  if (location.pathname.startsWith('/dashboard/following')) {
    const n = followWindow.filter((b) => b === post.blog).length;
    if (n >= 3 && !pinned.includes(post.blog)) return { action: 'collapse', reason: `flood: @${post.blog}`, say: `@${post.blog} has posted a lot in a row` };
    followWindow.push(post.blog);
    if (followWindow.length > 16) followWindow.shift();
    return { action: 'show', reason: 'following: chronological' };
  }
  return T.decide(engine, session, post, pinned, now);
}

// Every Tumblr page is titled just "Tumblr", which collapses browser history. Name them.
function retitle() {
  const parts = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  let name = '';
  if (parts[0] === 'dashboard') name = parts[1] === 'following' ? 'Following' : 'For you';
  else if (parts[0] === 'tagged' && parts[1]) name = `#${parts[1]}`;
  else if (parts[0] === 'search' && parts[1]) name = `Search: ${parts[1]}`;
  else if (parts[0] === 'settings') name = `Settings${parts[1] ? `: ${parts[1]}` : ''}`;
  else if (['explore', 'likes', 'inbox', 'activity', 'communities', 'messages'].includes(parts[0])) name = parts[0][0].toUpperCase() + parts[0].slice(1);
  else if (parts[0] && /^[\w-]+$/.test(parts[0])) name = `@${parts[0]}`;
  const want = name ? `${name} · Tumblr` : 'Tumblr';
  if (document.title !== want && /^(Tumblr|.* · Tumblr)$/.test(document.title)) document.title = want;
}

function scan() {
  retitle();
  for (const cell of document.querySelectorAll(SPONSORED)) ads.add(cell);
  if (onFeed()) {
    for (const article of document.querySelectorAll(`${ARTICLE}:not([data-tn])`)) {
      article.dataset.tn = '1';
      const post = readPost(article);
      if (!post.id) continue;
      if (!decisions.has(post.id)) {
        const now = Date.now();
        T.observe(engine, post, now);
        const d = decideHere(post, now);
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

// Tumblr's feed sometimes stalls at the bottom until you refresh. When we sit at the end with no new
// posts, nudge it, press any "try again" button, and on For you reload as a last resort (2 min cooldown).
// shortcut: guessed from behaviour, not Tumblr's markup; if it misfires, tune the thresholds here.
let lastCount = 0;
let stuckSince = 0;
let lastStage = 0;
setInterval(() => {
  const n = document.querySelectorAll(ARTICLE).length;
  const el = document.scrollingElement;
  const atEnd = el.scrollTop + innerHeight >= el.scrollHeight - 400;
  if (!onFeed() || document.hidden || n !== lastCount || !atEnd) {
    lastCount = n;
    stuckSince = lastStage = 0;
    return;
  }
  stuckSince ||= Date.now();
  const stage = Math.floor((Date.now() - stuckSince) / 4000);
  if (stage === lastStage || stage < 1) return;
  lastStage = stage;
  if (stage < 3) {
    [...document.querySelectorAll('main button, [role="main"] button')].find((b) => /try again|retry|refresh|load more/i.test(b.textContent))?.click();
    el.scrollBy(0, -300);
    setTimeout(() => el.scrollTo(0, el.scrollHeight), 250);
  } else if (!location.pathname.startsWith('/dashboard/following') && Date.now() - (+sessionStorage.tnReload || 0) > 120000) {
    sessionStorage.tnReload = Date.now();
    location.reload();
  }
}, 2000);

function applySettings() {
  const html = document.documentElement.classList;
  html.toggle('tn-hide-premium', settings.hidePremium);
  html.toggle('tn-hide-suggestions', settings.hideSuggestions);
}

// "Open Following first": only on the first load, so tapping For you still works.
function followingFirst() {
  if (settings.followingFirst && ['/', '/dashboard', '/dashboard/stuff_for_you'].includes(location.pathname)) location.replace('/dashboard/following');
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
  if (changes.mutes) mutes = T.parseMutes(changes.mutes.newValue);
  if (changes.settings) {
    settings = { ...DEFAULTS, ...changes.settings.newValue };
    applySettings();
  }
  if (changes.engine && !changes.engine.newValue) engine = T.emptyProfile(); // reset from settings
  if (changes.unread) (unreadCount = changes.unread.newValue?.length ?? 0), updateAppButton();
  scan();
});

chrome.storage.local.get({ engine: null, pinned, settings, unread: [], mutes: '' }).then((s) => {
  engine = s.engine ?? T.emptyProfile();
  mutes = T.parseMutes(s.mutes);
  unreadCount = s.unread.length;
  pinned = s.pinned;
  settings = { ...DEFAULTS, ...s.settings };
  followingFirst();
  applySettings();
  scan();
  // Batch DOM changes: scanning on every animation frame starved rendering on phones
  // (black, unpainted tiles while menus animate). 120 ms is still well under a scroll's notice.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      scan();
    }, 120);
  }).observe(document.documentElement, { childList: true, subtree: true });
});
