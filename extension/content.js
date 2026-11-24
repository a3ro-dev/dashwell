// DOM glue for tumblr.com. The feed engine lives in feed.js (globalThis.TumblrNew).
// shortcut: selectors come from Tumblr's rendered markup (Nov 2026); re-check them when Tumblr redesigns.
const T = globalThis.TumblrNew;
const ARTICLE = '[data-id] article';
const SPONSORED = ':is([data-cell-id], [data-id]):is(:has(.iab_sf), :has(a[href*="/relevantads"])), aside div:has(> div > div > [id^="aditude"])';
const DEFAULTS = { hidePremium: true, shapeFeed: true, hideSuggestions: true, followingFirst: false };
const FAST_SKIP_MS = 300;
const DWELL_MS = 4000; // one weak signal for accumulated foreground reading time

const session = T.newSession();
const decisions = new Map(); // tab + post id -> decision; Tumblr's list re-mounts posts on scroll
const posts = new Map(); // post id -> parsed post
const learned = new Set(); // post id + kind, so a like counts once even if click and key both fire
const engaged = new Set(); // ids the user liked, reblogged, commented on or expanded
const labeled = new Set(); // ids that already got their one impression label
const ads = new Set();
let engine = T.emptyProfile();
let ready = false;
let pinned = [];
let settings = DEFAULTS;
let mutes = [];
const followWindow = []; // blogs of recently shown posts on the chronological Following tab
const shadow = T.newSession();
const audits = new Map();
const tabKey = crypto.randomUUID().slice(0, 12);
function outcome(id, flags) {
  const key = onFeed() && !onFollowing() && audits.get(id);
  if (key) mutate(p => T.audit(p, key, flags));
}

// The logged-in home is "/" or "/dashboard..."; tag and blog pages are skipped because
// every post there shares a topic or an author and would all collapse.
const onFeed = () => location.pathname === '/' || location.pathname.startsWith('/dashboard');
const onFollowing = () => location.pathname.startsWith('/dashboard/following');
// Following is chronological: For you's topic folds must not follow a post there.
const keyOf = (id) => (onFollowing() ? 'f:' : 'y:') + id;

function readPost(article) {
  const id = article.closest('[data-id]')?.dataset.id;
  // Reblog trails link to earlier posts as /blog/postId; trail items run from the original author to later reblogs.
  const links = [...article.querySelectorAll('[data-testid="reblog-trail"] a[rel="author"][href], [data-testid="reblog-header"] a[href], [data-testid="reblog-tree"] header a[href]')];
  const root = links
    .map((a) => a.getAttribute('href').match(/^(?:https:\/\/www\.tumblr\.com)?\/[\w-]+\/(\d{6,})/)?.[1])
    .filter((x) => x && x !== id)
    .at(0);
  const trail = [
    ...new Set(
      links
        .map((a) => a.getAttribute('href').match(/^(?:https:\/\/www\.tumblr\.com)?\/([\w-]+)\/\d{6,}/)?.[1])
        .filter(Boolean),
    ),
  ];
  const body = article.querySelector('[data-testid="post-content"], [data-testid="post-body"], .npf_row, p');
  const destination = [...(body?.querySelectorAll('a[href]') ?? [])].find(a =>
    /^https?:$/.test(a.protocol) && a.hostname !== location.hostname);
  return {
    body: body?.textContent.slice(0, 600),
    destination: destination && destination.origin + destination.pathname,
    id,
    trail,
    text: article.textContent.slice(0, 4000),
    root: root ?? id,
    blog: article.querySelector('header a[rel="author"]')?.textContent.trim(),
    tags: [...article.querySelectorAll('a[data-testid="tag-link"]')].map((a) => a.textContent),
  };
}

// Replay pending profile mutations on the latest persisted profile under an origin-wide lock.
let pending = [];
let flushing = false;
function mutate(fn) {
  const result = fn(engine);
  pending.push(fn);
  return result;
}
async function flush() {
  if (flushing || !pending.length) return;
  flushing = true;
  try {
    await navigator.locks.request('dashwell-profile', async () => {
      const { engine: stored } = await chrome.storage.local.get({ engine: null });
      const next = stored ?? T.emptyProfile();
      const batch = pending.slice();
      for (const fn of batch) fn(next);
      await chrome.storage.local.set({ engine: next });
      pending.splice(0, batch.length);
      for (const fn of pending) fn(next);
      engine = next;
    });
  } finally {
    flushing = false;
  }
}
setInterval(flush, 5000);

function learn(post, kind) {
  const k = `${post.id}:${kind}`;
  if (learned.has(k)) return;
  learned.add(k);
  if (Object.hasOwn(T.event, kind)) outcome(post.id, T.event[kind]);
  if (['like', 'reblog', 'comment'].includes(kind)) engaged.add(post.id);
  const now = Date.now();
  const before = Object.create(null);
  for (const tag of T.cleanTags(post.tags)) {
    const topic = Object.hasOwn(engine.map, tag) ? engine.map[tag] : tag;
    if (session.engaged[topic]) before[topic] = new Set(session.engaged[topic]);
  }
  mutate(p => T.recordInteraction(p, p === engine ? session : { engaged: Object.assign(Object.create(null), structuredClone(before)) }, post, kind, now));
}

// One label per post the user actually saw (shown, or folded then expanded), the first time it
// leaves the viewport or is hidden. Folded posts that were never expanded and thumb flings get none.
function impress(id, out) {
  if ((labeled.has(id) && !out.hide) || !posts.has(id)) return; // a later "less like this" still teaches
  labeled.add(id);
  const d = decisions.get(keyOf(id));
  const outcome = { engaged: engaged.has(id), expanded: !!((!d?.byUser && d?.shown) || d?.muteDecision?.shown), ...out };
  const now = Date.now();
  const post = posts.get(id);
  mutate(p => T.learnImpression(p, session, post, outcome, now));
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
  btn.textContent = d.undo ? 'Undo' : 'Show';
  btn.setAttribute('aria-label', d.undo ? 'Undo less like this' : `Show hidden post from @${post.blog ?? 'unknown'}`);
  btn.onclick = () => {
    d.shown = true;
    article.classList.remove('tn-collapsed');
    bar.remove();
    if (!d.byUser) outcome(post.id, T.event.open | T.event.read);
    if (d.undo) {
      clearTimeout(d.undo);
      pendingHides.delete(d.commit);
      d.undo = null;
      decisions.set(d.key, d.previous);
      delete d.commit;
    }
    expose(post);
    resume(article, performance.now());
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
    if (skips.length < 4)
      for (const x of skips) {
        if (engaged.has(x.id) || decisions.get(keyOf(x.id))?.byUser || (elapsed.get(x.id) ?? 0) >= FAST_SKIP_MS || [...visibleSince.values()].some(v => v.post.id === x.id)) continue;
        learn(x, 'skip');
        impress(x.id, { skip: true });
      }
    skips = [];
  }, 700);
}
const inView = new Set();
let foregroundStart = performance.now();
const elapsed = new Map();
const exposed = new Set();
const pendingHides = new Set();
addEventListener("pagehide", () => { for (const commit of pendingHides) commit(); flush(); });
const audited = new Set();
function visibleAudit(article) {
  const id = article.closest('[data-id]')?.dataset.id;
  if (!audits.has(id) || onFollowing() || audited.has(id)) return;
  audited.add(id);
  const base = decisions.get(keyOf(id));
  const shadowFolded = settings.shapeFeed && (base?.older || base?.mute);
  outcome(id, T.event.visible | (shadowFolded ? T.event.shadow : 0) |
    (article.classList.contains('tn-collapsed') ? T.event.fold : 0));
}
function expose(post) {
  if (exposed.has(post.id)) return;
  exposed.add(post.id);
  mutate(p => T.remember(p, post.root ?? post.id));
}
function resume(article, time) {
  if (document.hidden || !inView.has(article) || article.classList.contains('tn-collapsed') || visibleSince.has(article)) return;
  const post = posts.get(article.closest('[data-id]')?.dataset.id);
  if (!post) return;
  outcome(post.id, T.event.read);
  visibleSince.set(article, { time: Math.max(time, foregroundStart), post });
  expose(post);
}
function pause(article, time, left) {
  const active = visibleSince.get(article);
  if (!active) return;
  visibleSince.delete(article);
  const { post } = active;
  const ms = (elapsed.get(post.id) ?? 0) + Math.max(0, time - active.time);
  elapsed.set(post.id, ms);
  const dwell = ms >= DWELL_MS;
  if (dwell) learn(post, 'dwell');
  if (!left || ms <= 0) return;
  if (ms < FAST_SKIP_MS && !engaged.has(post.id)) queueSkip(post);
  else {
    impress(post.id, { dwell });
  }
}
const skipWatcher = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (e.isIntersecting && e.intersectionRect.height > 0) {
      inView.add(e.target);
      if (!document.hidden) visibleAudit(e.target);
      resume(e.target, e.time);
    } else {
      inView.delete(e.target);
      pause(e.target, e.time, !document.hidden);
    }
  }
}, { threshold: [0, 0.001] });
document.addEventListener('visibilitychange', () => {
  const time = performance.now();
  if (!document.hidden) foregroundStart = time;
  for (const article of inView) {
    if (document.hidden) pause(article, time, false);
    else { visibleAudit(article); resume(article, time); }
  }
  if (document.hidden) flush();
});

// "Less like this": fold the post now with an undo and cool its topics. From the H key or Tumblr's ••• menu.
function hidePost(article, post) {
  if (!article || article.classList.contains('tn-collapsed')) return;
  const d = { action: 'collapse', byUser: true, say: 'Hidden. Undo within 10 seconds', reason: 'hidden by you' };
  d.key = keyOf(post.id);
  d.previous = decisions.get(d.key) ?? { action: 'show' };
  decisions.set(d.key, d);
  pause(article, performance.now(), false);
  // Defer the entire negative until the Undo window closes.
  const commit = () => {
    if (!d.undo) return;
    pendingHides.delete(commit);
    delete d.commit;
    delete d.previous;
    d.undo = null;
    learn(post, 'hide');
    impress(post.id, { hide: true });
    d.say = "Hidden. You'll see less like this";
    for (const mounted of document.querySelectorAll(ARTICLE)) {
      if (mounted.closest('[data-id]')?.dataset.id !== post.id) continue;
      const bar = mounted.querySelector('.tn-bar');
      if (!bar) continue;
      bar.querySelector('p').textContent = d.say;
      const button = bar.querySelector('button');
      button.textContent = 'Show';
      button.setAttribute('aria-label', 'Show hidden post');
    }
  };
  d.undo = setTimeout(commit, 10000);
  d.commit = commit;
  pendingHides.add(commit);
  render(article, post, d);
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
  if (onFollowing()) {
    const n = followWindow.filter((b) => b === post.blog).length;
    if (n >= 3 && !pinned.includes(post.blog)) return { recent: n, action: 'collapse', reason: `flood: @${post.blog}`, say: `@${post.blog} has posted a lot in a row` };
    followWindow.push(post.blog);
    if (followWindow.length > 16) followWindow.shift();
    return { recent: n, action: 'show', reason: 'following: chronological' };
  }
  const state = { ...session, window: session.window.slice() };
  const pins = pinned.slice();
  const sample = Math.random();
  function randomStream() {
    let state = Math.floor(sample * 4294967296);
    return () => ((state = (Math.imul(1664525, state) + 1013904223) >>> 0) / 4294967296);
  }
  session.rand = randomStream();
  const result = mutate(p => T.decide(p, p === engine ? session : { ...state, rand: randomStream(), window: state.window.slice() }, post, pins, now));
  result.before = state;
  return result;
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
  if (!ready) return;
  retitle();
  for (const article of inView) {
    if (article.isConnected !== false) continue;
    inView.delete(article);
    pause(article, performance.now(), !document.hidden);
    skipWatcher.unobserve(article);
  }
  for (const cell of document.querySelectorAll(SPONSORED)) ads.add(cell);
  if (onFeed()) {
    for (const article of document.querySelectorAll(`${ARTICLE}:not([data-tn])`)) {
      article.dataset.tn = '1';
      const post = readPost(article);
      if (!post.id) continue;
      const key = keyOf(post.id);
      if (!decisions.has(key)) {
        const now = Date.now();
        if (!posts.has(post.id)) mutate(p => T.observe(p, post, now));
        const older = !onFollowing() && T.shadowFold(engine, shadow, post, pinned, now);
        const decision = decideHere(post, now);
        decision.older = older;
        decisions.set(key, decision);
        if (!onFollowing()) {
          const auditKey = tabKey + '-' + audits.size;
          audits.set(post.id, auditKey);
          const flags = Number(!!(settings.shapeFeed && (older || T.mutedBy(mutes, post)))) | (settings.shapeFeed && (T.mutedBy(mutes, post) || decision.action === 'collapse') ? 2 : 0);
          mutate(p => T.audit(p, auditKey, flags, true));
        }
        posts.set(post.id, post);

      }
      const base = decisions.get(key);
      const mute = T.mutedBy(mutes, post);
      if (base.mute !== mute) { base.mute = mute; base.muteDecision = { action: 'collapse', say: 'Muted: ' + mute }; }
      render(article, post, mute && !base.byUser ? base.muteDecision : base);
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
  if (changes.settings || changes.mutes || changes.pinned) {
    for (const article of document.querySelectorAll(ARTICLE)) {
      const id = article.closest('[data-id]')?.dataset.id;
      const previous = decisions.get(keyOf(id));
      if (changes.pinned && previous?.recent >= 3 && onFollowing()) {
        const blog = posts.get(id).blog;
        previous.action = pinned.includes(blog) ? 'show' : 'collapse';
        previous.say = '@' + blog + ' has posted a lot in a row';
      }
      if (changes.pinned && previous?.before && !previous.byUser && !onFollowing()) {
        const profile = structuredClone(engine);
        profile.rr = profile.rr.filter(root => root !== (posts.get(id).root ?? id));
        const state = previous.before;
        const revised = T.decide(profile, { ...state, window: state.window.slice() }, posts.get(id), pinned, Date.now());
        decisions.set(keyOf(id), { ...revised, before: state, older: previous.older });
      }
      article.querySelector('.tn-bar')?.remove();
      article.classList.remove('tn-collapsed');
      delete article.dataset.tn;
    }
  }
  if (changes.engine && !changes.engine.newValue) { pending = []; engine = T.emptyProfile(); } // reset from settings
  if (changes.unread) (unreadCount = changes.unread.newValue?.length ?? 0), updateAppButton();
  scan();
  if (changes.settings || changes.pinned || changes.mutes) {
    for (const article of inView) {
      if (article.classList.contains('tn-collapsed')) pause(article, performance.now(), false);
      else resume(article, performance.now());
    }
  }
});

chrome.storage.local.get({ engine: null, pinned, settings, unread: [], mutes: '' }).then((s) => {
  engine = s.engine ?? T.emptyProfile();
  mutes = T.parseMutes(s.mutes);
  unreadCount = s.unread.length;
  pinned = s.pinned;
  settings = { ...DEFAULTS, ...s.settings };
  ready = true;
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
