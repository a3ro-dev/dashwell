// Settings sheet: the extension popup on desktop, the settings sheet in the Android app.
const T = globalThis.TumblrNew;
const $ = (id) => document.getElementById(id);
const el = (tag, text, props = {}) => Object.assign(document.createElement(tag), { textContent: text, ...props });
const DEFAULTS = { hidePremium: true, shapeFeed: true };
const RELEASES = 'https://api.github.com/repos/a3ro-dev/tumblr-new/releases/latest';
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

function emptyItem(text) {
  const li = el('li', '');
  li.append(el('p', text, { className: 'empty' }));
  return li;
}

async function draw() {
  const s = await chrome.storage.local.get({ engine: null, pinned: [], unread: [], settings: {} });
  const now = Date.now();
  const engine = s.engine ?? T.emptyProfile();

  $('unread').replaceChildren(
    ...(s.unread.length
      ? s.unread.map((p) => {
          const li = el('li', '', { className: 'post' });
          const a = el('a', p.title, { href: p.link });
          a.onclick = (e) => (e.preventDefault(), open(p.link));
          li.append(a, el('small', `@${p.blog} · ${ago(p.time)}`));
          return li;
        })
      : [emptyItem('Nothing new yet.')]),
  );

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
      : [el('p', 'None yet.', { className: 'empty' })]),
  );

  const top = T.topInterests(engine, now, 12);
  $('interests').replaceChildren(
    ...(top.length
      ? top.map(({ tag }) => el('span', `#${tag}`, { className: 'chip' }))
      : [el('p', 'Like or reblog a few posts and this fills in.', { className: 'empty' })]),
  );
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
$('blog').oninput = () => $('blog').setCustomValidity('');

$('read').onclick = async () => {
  const { unread, lastSeen } = await chrome.storage.local.get({ unread: [], lastSeen: {} });
  for (const p of unread) lastSeen[p.blog] = Math.max(lastSeen[p.blog] ?? 0, p.time);
  await chrome.storage.local.set({ unread: [], lastSeen });
  await chrome.action.setBadgeText({ text: '' });
};

$('refresh').onclick = () => chrome.runtime.sendMessage('check');

$('reset').onclick = async () => {
  if (!confirm('Forget everything it learned about what you like? Your favorite blogs stay.')) return;
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
  $('version').textContent = `Version ${current}`;
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

chrome.storage.onChanged.addListener(draw);
draw();
checkUpdate();
