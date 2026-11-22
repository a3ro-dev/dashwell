// Settings sheet: the extension popup on desktop, the settings sheet in the Android app.
const T = globalThis.TumblrNew;
const $ = (id) => document.getElementById(id);
const el = (tag, text, props = {}) => Object.assign(document.createElement(tag), { textContent: text, ...props });
const DEFAULTS = { hidePremium: true, shapeFeed: true, hideSuggestions: true, followingFirst: false };
const RELEASES = 'https://api.github.com/repos/a3ro-dev/dashwell/releases/latest';
const IS_APP = !!globalThis.__tnAppVersion;

// In the app, links open in the phone's browser instead of replacing the sheet.
function open(url) {
  if (globalThis.__tnOpenUrl) globalThis.__tnOpenUrl(url);
  else window.open(url, '_blank', 'noopener');
}

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 6e4);
  if (m < 60) return `${Math.max(m, 1)} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
};

async function draw() {
  const s = await chrome.storage.local.get({ engine: null, pinned: [], unread: [], settings: {} });
  const now = Date.now();
  const engine = s.engine ?? T.emptyProfile();

  $('unread').replaceChildren(
    ...(s.unread.length
      ? s.unread.map((p) => {
          const li = el('li', '');
          const a = el('a', '', { href: p.link, className: 'post' });
          a.append(el('strong', p.title), el('small', `@${p.blog} · ${ago(p.time)}`));
          a.onclick = async (e) => {
            e.preventDefault();
            // opening one post marks just that one read
            const { unread, lastSeen } = await chrome.storage.local.get({ unread: [], lastSeen: {} });
            lastSeen[p.blog] = Math.max(lastSeen[p.blog] ?? 0, p.time);
            const left = unread.filter((x) => x.link !== p.link);
            await chrome.storage.local.set({ unread: left, lastSeen });
            await chrome.action.setBadgeText({ text: left.length ? String(left.length) : '' });
            open(p.link);
          };
          li.append(a);
          return li;
        })
      : [el('li', 'Nothing new from your favorites right now.', { className: 'pad quiet' })]),
  );
  $('read').hidden = !s.unread.length;

  for (const key in DEFAULTS) $(key).checked = s.settings[key] ?? DEFAULTS[key];

  const favs = T.favorites(engine, s.pinned, now);
  $('favs').replaceChildren(
    ...(favs.length
      ? favs.map((b) => {
          if (!s.pinned.includes(b)) return el('span', `@${b}`, { className: 'chip', title: 'Added because you like their posts' });
          const chip = el('button', `@${b}`, { className: 'chip', type: 'button', title: `Remove @${b}` });
          chip.setAttribute('aria-label', `Remove @${b} from favorites`);
          const x = el('span', '×');
          x.setAttribute('aria-hidden', 'true');
          chip.append(x);
          chip.onclick = () => chrome.storage.local.set({ pinned: s.pinned.filter((v) => v !== b) });
          return chip;
        })
      : [el('p', 'None yet.', { className: 'quiet' })]),
  );

  // What it noticed, as a sentence rather than a chart.
  const top = T.topInterests(engine, now, 3).map(({ tag }) => `#${tag}`);
  $('interests').textContent = top.length
    ? `Lately you've been into ${top.length > 1 ? `${top.slice(0, -1).join(', ')} and ${top.at(-1)}` : top[0]}.`
    : 'Like or reblog a few posts and Dashwell learns what you enjoy.';
}

for (const key in DEFAULTS) {
  $(key).onchange = async () => {
    const { settings } = await chrome.storage.local.get({ settings: {} });
    chrome.storage.local.set({ settings: { ...DEFAULTS, ...settings, [key]: $(key).checked } });
  };
}

$('pin').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('blog');
  const blog = input.value.trim().toLowerCase().replace(/^@/, '').replace(/\.tumblr\.com$/, '');
  if (!/^[a-z0-9-]+$/.test(blog)) {
    input.setCustomValidity('Use the blog name, like staff');
    input.reportValidity();
    return;
  }
  const { pinned } = await chrome.storage.local.get({ pinned: [] });
  await chrome.storage.local.set({ pinned: [...new Set([...pinned, blog])] });
  input.value = '';
  chrome.runtime.sendMessage('check');
};
chrome.storage.local.get({ mutes: '' }).then(({ mutes }) => ($('mutes').value = mutes));
// saved on every keystroke: a debounce lost the last edit when the popup closed right after typing
$('mutes').oninput = () => chrome.storage.local.set({ mutes: $('mutes').value });

$('blog').oninput = () => $('blog').setCustomValidity('');

$('read').onclick = async () => {
  const { unread, lastSeen } = await chrome.storage.local.get({ unread: [], lastSeen: {} });
  for (const p of unread) lastSeen[p.blog] = Math.max(lastSeen[p.blog] ?? 0, p.time);
  await chrome.storage.local.set({ unread: [], lastSeen });
  await chrome.action.setBadgeText({ text: '' });
};

$('refresh').onclick = () => chrome.runtime.sendMessage('check');

$('reset').onclick = async () => {
  if (!confirm('Forget what Dashwell learned about what you like? Your favorites and mutes stay.')) return;
  await chrome.storage.local.remove(['engine', 'unread', 'lastSeen']);
  await chrome.action.setBadgeText({ text: '' });
  draw();
};

// Updates: compare this build with the latest GitHub release.
const newer = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
async function checkUpdate() {
  const current = IS_APP ? globalThis.__tnAppVersion : chrome.runtime.getManifest().version;
  $('version').textContent = `Dashwell ${current}`;
  try {
    const r = await fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return;
    const rel = await r.json();
    const latest = String(rel.tag_name).replace(/^v/, '');
    if (!newer(latest, current)) return;
    const asset = (rel.assets ?? []).find((a) => a.name.endsWith(IS_APP ? '.apk' : '.zip'));
    const url = asset?.browser_download_url ?? rel.html_url;
    $('update-text').textContent = `Version ${latest} is out.`;
    $('update-link').href = url;
    $('update-link').onclick = (e) => (e.preventDefault(), open(url));
    $('update').hidden = false;
  } catch {} // offline: try again next time the sheet opens
}

$('tips').textContent = IS_APP
  ? 'Tips: pull down at the top of the feed to refresh. Tap ••• on a post, then Less like this.'
  : 'Keys on the dashboard: O shows a folded post, H means less like this, G switches For you and Following. Alt+Shift+D opens this.';

$('credit').onclick = (e) => (e.preventDefault(), open('https://a3ro.dev'));

chrome.storage.onChanged.addListener(draw);
draw();
checkUpdate();
