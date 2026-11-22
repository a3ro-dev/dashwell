// DOM glue for tumblr.com. The feed engine lives in feed.js (globalThis.TumblrNew).
// shortcut: selectors come from Tumblr's rendered markup (Nov 2026); re-check them when Tumblr redesigns.
const T = globalThis.TumblrNew;
const ARTICLE = '[data-id] article';
const SPONSORED = ':is([data-cell-id], [data-id]):is(:has(.iab_sf), :has(a[href*="/relevantads"])), aside div:has(> div > div > [id^="aditude"])';
const DEFAULTS = { hidePremium: true, shapeFeed: true, hideSuggestions: true, followingFirst: false };
const FAST_SKIP_MS = 300;
const DWELL_MS = [4000, 60000]; // read for 4 s+; past a minute the phone was probably put down

const session = T.newSession();
const decisions = new Map(); // tab + post id -> decision; Tumblr's list re-mounts posts on scroll
const posts = new Map(); // post id -> parsed post
const learned = new Set(); // post id + kind, so a like counts once even if click and key both fire
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
const onFollowing = () => location.pathname.startsWith('/dashboard/following');
// Following is chronological: For you's topic folds must not follow a post there.
const keyOf = (id) => (onFollowing() ? 'f:' : 'y:') + id;

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
  const k = `${post.id}:${kind}`;
  if (learned.has(k)) return;
  learned.add(k);
  T.recordInteraction(engine, session, post, kind, Date.now());
  save();
}

function render(article, post, d) {
  if (d.action !== 'collapse' || d.shown || !(settings.shapeFeed || d.byUser) || article.querySelector('.tn-bar')) return;
  article.classList.add('tn-collapsed');
  const bar = document.createElement('div');
  bar.className = 'tn-bar';
  const text = document.createElement('p');
  text.textContent = d.say ?? 'Hidden to keep your feed varied';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = d.byUser ? 'Undo' : 'Show';
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
// A thumb fling or End key sends many posts past at once; that's getting somewhere, not judging them.
const visibleSince = new Map();
let skips = [];
let skipTimer = 0;
function queueSkip(post) {
  skips.push(post);
  clearTimeout(skipTimer);
  skipTimer = setTimeout(() => {
    if (skips.length < 4) for (const x of skips) learn(x, 'skip');
    skips = [];
  }, 700);
}
const skipWatcher = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const id = e.target.closest('[data-id]')?.dataset.id;
    if (!id) continue;
    if (e.isIntersecting) visibleSince.set(id, e.time);
    else if (visibleSince.has(id)) {
      const ms = e.time - visibleSince.get(id);
      visibleSince.delete(id);
      const d = decisions.get(keyOf(id));
      if (!d || d.action === 'collapse' || !posts.has(id)) continue;
      if (ms < FAST_SKIP_MS) queueSkip(posts.get(id));
      else if (ms >= DWELL_MS[0] && ms <= DWELL_MS[1] && !document.hidden) learn(posts.get(id), 'dwell');
    }
  }
}, { threshold: 0.5 });

// "Less like this": fold the post now with an undo and cool its topics. From the H key or Tumblr's ••• menu.
function hidePost(article, post) {
  if (!article || article.classList.contains('tn-collapsed')) return;
  const d = { action: 'collapse', byUser: true, say: "Hidden. You'll see less like this", reason: 'hidden by you' };
  decisions.set(keyOf(post.id), d);
  render(article, post, d);
  learn(post, 'hide');
  // a tall post folding above the fold would yank the feed up; keep the Undo line in view instead
  const top = article.getBoundingClientRect().top;
  if (top < 64) scrollBy(0, top - 64);
}

// Tumblr's ••• menu opens in a dialog outside the post; its first item links to the post, which names it.
function addMenuItem() {
  for (const menu of document.querySelectorAll('[role="dialog"] [role="menu"]:not([data-tn])')) {
    menu.dataset.tn = '1';
    const id = menu.querySelector('a[href]')?.getAttribute('href').match(/^(?:https:\/\/www\.tumblr\.com)?\/[\w-]+\/(\d{6,})/)?.[1];
    const article = id && document.querySelector(`[data-id="${id}"] article`);
    if (!article || !posts.has(id) || article.classList.contains('tn-collapsed')) continue;
    const like = menu.querySelector('div[role="menuitem"]'); // borrow Tumblr's own item look
    const item = document.createElement('div');
    item.setAttribute('role', 'menuitem');
    item.tabIndex = -1;
    item.className = `${like?.className ?? ''} tn-menu-item`;
    const label = document.createElement('span');
    label.className = like?.firstElementChild?.className ?? '';
    label.textContent = 'Less like this';
    item.append(label);
    item.onclick = () => {
      hidePost(article, posts.get(id));
      menu.closest('[role="dialog"]')?.querySelector('[data-dialog-dismiss]')?.click();
    };
    item.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), item.click());
    const sep = menu.querySelector('hr');
    menu.append(...(sep ? [sep.cloneNode(), item] : [item]));
  }
}

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
  if (onFollowing()) {
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
      const key = keyOf(post.id);
      if (!decisions.has(key)) {
        const now = Date.now();
        if (!posts.has(post.id)) T.observe(engine, post, now);
        decisions.set(key, decideHere(post, now));
        posts.set(post.id, post);
        save();
      }
      render(article, post, decisions.get(key));
      skipWatcher.observe(article);
    }
  }
  addMenuItem();
  hideAppNags();
  mountAppButton();
}

// Android app only: pull down at the top of the feed to refresh, like the native app.
// Releases past 72 px; Tumblr re-fetches on its own route reload, so we just reload the page.
if (IS_APP) {
  document.documentElement.classList.add('tn-app');
  let startY = null;
  let pull = 0;
  const spinner = document.createElement('div');
  spinner.className = 'tn-pull';
  spinner.setAttribute('aria-hidden', 'true');
  const set = (px) => {
    pull = px;
    spinner.style.transform = `translate(-50%, ${Math.min(px, 96) - 48}px) rotate(${px * 3}deg)`;
    spinner.style.opacity = String(Math.min(px / 72, 1));
    spinner.classList.toggle('tn-ready', px >= 72);
  };
  addEventListener('touchstart', (e) => {
    startY = onFeed() && document.scrollingElement.scrollTop <= 0 && e.touches.length === 1 && !document.querySelector('[role="dialog"]') ? e.touches[0].clientY : null;
  }, { passive: true });
  addEventListener('touchmove', (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0 || document.scrollingElement.scrollTop > 0) return startY = null, set(0);
    if (!spinner.isConnected) document.body.append(spinner);
    set(dy * 0.5); // resistance, so it feels pulled rather than dragged
  }, { passive: true });
  addEventListener('touchend', () => {
    if (startY == null) return;
    startY = null;
    if (pull >= 72) {
      spinner.classList.add('tn-spin');
      location.reload();
    } else set(0);
  }, { passive: true });
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
  } else if (!onFollowing() && Date.now() - (+sessionStorage.tnReload || 0) > 120000) {
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

// Keyboard. Tumblr owns J K L R Q E W A D C S N F X Z . ? / so ours are O, H and G.
// Tumblr's own L and R act on the current post without a click, so we learn from those keys too.
// shortcut: "current post" = the focused one, else the first below the top bar; matches Tumblr's J/K in practice.
function currentArticle() {
  const focused = document.activeElement?.closest?.(ARTICLE);
  if (focused) return focused;
  return [...document.querySelectorAll(ARTICLE)].find((a) => a.getBoundingClientRect().bottom > 100);
}
const typing = (el) => el?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
document.addEventListener(
  'keydown',
  (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || typing(e.target) || !onFeed() || document.querySelector('[role="dialog"]')) return;
    const key = e.key.toLowerCase();
    if (key === 'g' && !e.shiftKey) {
      // switch For you <-> Following, through Tumblr's own tab link so the page doesn't reload
      const to = onFollowing() ? '/dashboard/stuff_for_you' : '/dashboard/following';
      const link = document.querySelector(`a[href="${to}"]`);
      link ? link.click() : location.assign(to);
      return e.preventDefault();
    }
    if (key === 'o' && !e.shiftKey) {
      // show the nearest folded post on screen
      const bar = [...document.querySelectorAll('article.tn-collapsed .tn-bar')].find((b) => {
        const r = b.getBoundingClientRect();
        return r.bottom > 0 && r.top < innerHeight;
      });
      bar?.querySelector('button').click();
      return bar && e.preventDefault();
    }
    const article = currentArticle();
    const post = article && readPost(article);
    if (!post?.id) return;
    if (key === 'h' && !e.shiftKey && !article.classList.contains('tn-collapsed')) {
      hidePost(article, post);
      return e.preventDefault();
    }
    if (key === 'l' && !e.shiftKey && article.querySelector('button[aria-label="Like"]')) learn(post, 'like');
    if (key === 'r' && article.querySelector('button[aria-label="Reblog"]')) learn(post, 'reblog');
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
