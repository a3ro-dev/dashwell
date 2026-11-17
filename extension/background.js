// Mutual catch-up: polls favorite blogs' public RSS (no API key) and counts posts you haven't seen.
if (typeof importScripts === 'function') importScripts('feed.js'); // Chrome service worker; Firefox loads feed.js via manifest
const T = globalThis.TumblrNew;
const EVERY_MIN = 30;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', mdash: '—', ndash: '–' };
// Tumblr double-escapes titles (&amp;rsquo;), so decode &amp; first, then the rest.
const decode = (s) =>
  s.replace(/&amp;/g, '&').replace(/&(#\d+|[a-z]+);/g, (m, e) => (e[0] === '#' ? String.fromCodePoint(+e.slice(1)) : ENTITIES[e] ?? m));

// shortcut: regex RSS parsing (service workers have no DOMParser); fine for Tumblr's flat feed.
function parseRss(xml) {
  const tag = (s, name) => s.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`))?.[1]?.trim() ?? '';
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => ({
    title: decode(tag(item, 'title').replace(/<[^>]+>/g, '')).slice(0, 140) || '(untitled)',
    link: tag(item, 'link'),
    time: Date.parse(tag(item, 'pubDate')) || 0,
  }));
}

async function check() {
  const s = await chrome.storage.local.get({ profile: T.emptyProfile(), pinned: [], lastSeen: {}, unread: [] });
  const now = Date.now();
  const blogs = T.favorites(s.profile, s.pinned, now);
  const unread = [];
  for (const blog of blogs) {
    s.lastSeen[blog] ??= now; // first time we watch a blog: start from now, no backlog flood
    try {
      const res = await fetch(`https://${blog}.tumblr.com/rss`);
      if (!res.ok) continue;
      for (const p of parseRss(await res.text())) if (p.time > s.lastSeen[blog]) unread.push({ blog, ...p });
    } catch {} // offline or blog gone; try again next round
  }
  unread.sort((a, b) => b.time - a.time);
  await chrome.storage.local.set({ lastSeen: s.lastSeen, unread });
  await chrome.action.setBadgeText({ text: unread.length ? String(unread.length) : '' });
}

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('check', { periodInMinutes: EVERY_MIN }));
chrome.runtime.onStartup.addListener(check);
chrome.alarms.onAlarm.addListener(check);
chrome.runtime.onMessage.addListener((msg) => {
  if (msg === 'check') check();
});
