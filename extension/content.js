// DOM glue for tumblr.com. Feed logic lives in feed.js (globalThis.TumblrNew).
// shortcut: selectors come from Tumblr's rendered markup (Nov 2026); re-check them when Tumblr redesigns.
const T = globalThis.TumblrNew;
const ARTICLE = '[data-cell-id] article';
const decisions = new Map(); // post id -> decision; Tumblr's list re-mounts posts on scroll
const recent = [];
let profile = T.emptyProfile();
let pinned = [];

function readPost(article) {
  return {
    id: article.closest('[data-id]')?.dataset.id,
    blog: article.querySelector('header a[rel="author"]')?.textContent.trim(),
    tags: [...article.querySelectorAll('a[data-testid="tag-link"]')].map((a) => a.textContent),
  };
}

function render(article, d) {
  article.classList.toggle('tn-favorite', d.action === 'favorite');
  if (d.action === 'favorite' && !article.querySelector('.tn-badge')) {
    article.insertAdjacentHTML('afterbegin', '<span class="tn-badge">favorite</span>');
  }
  if (d.action !== 'collapse' || d.shown || article.querySelector('.tn-bar')) return;
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

function scan() {
  // Only the dashboard: on a tag page every post shares the tag, so all would collapse.
  if (!location.pathname.startsWith('/dashboard')) return;
  for (const article of document.querySelectorAll(`${ARTICLE}:not([data-tn])`)) {
    article.dataset.tn = '1';
    const post = readPost(article);
    if (!post.id) continue;
    if (!decisions.has(post.id)) decisions.set(post.id, T.decide(profile, pinned, recent, post, Date.now()));
    render(article, decisions.get(post.id));
  }
}

// Learn from likes and reblogs. Clicking "Like" only happens on a not-yet-liked post.
document.addEventListener(
  'click',
  (e) => {
    const btn = e.target.closest?.('button[aria-label="Like"], button[aria-label="Reblog"]');
    const article = btn?.closest('article');
    if (!article) return;
    T.recordInteraction(profile, readPost(article), btn.ariaLabel === 'Reblog' ? 2 : 1, Date.now());
    chrome.storage.local.set({ profile });
  },
  true,
);

chrome.storage.onChanged.addListener((changes) => {
  if (changes.profile) profile = changes.profile.newValue ?? T.emptyProfile();
  if (changes.pinned) pinned = changes.pinned.newValue ?? [];
});

chrome.storage.local.get({ profile, pinned }).then((s) => {
  profile = s.profile;
  pinned = s.pinned;
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
