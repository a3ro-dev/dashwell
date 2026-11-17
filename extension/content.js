// DOM glue for tumblr.com. Feed logic lives in feed.js (globalThis.TumblrNew).
// shortcut: selectors come from Tumblr's rendered markup (Nov 2026); re-check them when Tumblr redesigns.
const T = globalThis.TumblrNew;
const ARTICLE = '[data-id] article';
const SPONSORED = ':is([data-cell-id], [data-id]):is(:has(.iab_sf), :has(a[href*="/relevantads"])), aside div:has(> div > div > [id^="aditude"])';
const DEFAULTS = { hidePremium: true, showAlgo: true, shapeFeed: true };
const decisions = new Map(); // post id -> decision; Tumblr's list re-mounts posts on scroll
const ads = new Set();
const log = [];
const recent = [];
let profile = T.emptyProfile();
let pinned = [];
let settings = DEFAULTS;

// The logged-in home can be "/" or "/dashboard..."; tag/blog pages are skipped because
// every post there shares a topic and would all collapse.
const onFeed = () => location.pathname === '/' || location.pathname.startsWith('/dashboard');

function readPost(article) {
  return {
    id: article.closest('[data-id]')?.dataset.id,
    blog: article.querySelector('header a[rel="author"]')?.textContent.trim(),
    tags: [...article.querySelectorAll('a[data-testid="tag-link"]')].map((a) => a.textContent),
  };
}

function explain(d) {
  const load = d.tag ? `#${d.tag} ${d.seen}/${d.allowed} recent slots` : 'no tags';
  if (d.action === 'favorite') return `★ favorite blog · always shown · ${load}`;
  if (d.action === 'collapse') return `collapsed · ${load} used up`;
  return `shown · ${load}`;
}

function render(article, d) {
  article.querySelector('.tn-why')?.remove();
  const why = document.createElement('div');
  why.className = `tn-why tn-${d.action}`;
  why.textContent = explain(d);
  article.prepend(why);
  article.classList.toggle('tn-favorite', d.action === 'favorite');

  if (d.action !== 'collapse' || d.shown || !settings.shapeFeed || article.querySelector('.tn-bar')) return;
  article.classList.add('tn-collapsed');
  const bar = document.createElement('div');
  bar.className = 'tn-bar';
  bar.textContent = `Hidden: you've seen ${d.seen} #${d.tag} posts recently.`;
  const btn = document.createElement('button');
  btn.textContent = 'Show';
  btn.onclick = () => {
    d.shown = true;
    article.classList.remove('tn-collapsed');
    bar.remove();
  };
  bar.append(btn);
  article.prepend(bar);
}

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
    'tumblr-new · algorithm (click to fold)',
    !onFeed()
      ? 'not the dashboard: feed shaping paused here'
      : decisions.size || found
        ? `posts read ${decisions.size} · shown ${count('show')} · collapsed ${count('collapse')} · favorites ${count('favorite')}`
        : 'waiting for posts… if this stays, Tumblr changed its markup',
    `sponsored posts hidden: ${ads.size}${settings.shapeFeed ? '' : ' · shaping OFF (labels only)'}`,
    `learned: ${Object.keys(profile.tags).length} topics, ${Object.keys(profile.blogs).length} blogs`,
    `top: ${T.topInterests(profile, Date.now(), 4).map((i) => '#' + i.tag).join(' ') || 'like or reblog posts to teach it'}`,
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
        const d = T.decide(profile, pinned, recent, post, Date.now());
        decisions.set(post.id, d);
        log.push(`${post.blog ?? '?'}: ${explain(d)}`);
      }
      render(article, decisions.get(post.id));
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
    const reblog = btn.ariaLabel === 'Reblog';
    T.recordInteraction(profile, post, reblog ? 2 : 1, Date.now());
    log.push(`learned from ${reblog ? 'reblog' : 'like'}: ${post.blog ?? '?'} ${post.tags.slice(0, 3).join(' ')}`);
    chrome.storage.local.set({ profile });
  },
  true,
);

chrome.storage.onChanged.addListener((changes) => {
  if (changes.profile) profile = changes.profile.newValue ?? T.emptyProfile();
  if (changes.pinned) pinned = changes.pinned.newValue ?? [];
  if (changes.settings) {
    settings = { ...DEFAULTS, ...changes.settings.newValue };
    applySettings();
  }
  scan();
});

chrome.storage.local.get({ profile, pinned, settings }).then((s) => {
  profile = s.profile;
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
