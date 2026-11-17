const T = globalThis.TumblrNew;
const $ = (id) => document.getElementById(id);
const el = (tag, text, props = {}) => Object.assign(document.createElement(tag), { textContent: text, ...props });

async function draw() {
  const s = await chrome.storage.local.get({ profile: T.emptyProfile(), pinned: [], unread: [] });
  const now = Date.now();

  if (s.unread.length) {
    $('unread').replaceChildren(
      ...s.unread.map((p) => {
        const li = el('li', '');
        li.append(el('a', p.title, { href: p.link, target: '_blank' }), el('br', ''), el('small', p.blog));
        return li;
      }),
    );
  }

  $('favs').replaceChildren(
    ...T.favorites(s.profile, s.pinned, now).map((b) =>
      el('span', s.pinned.includes(b) ? `📌 ${b} ✕` : b, {
        className: 'chip',
        title: s.pinned.includes(b) ? 'Unpin' : 'Learned from your likes',
        onclick: () => s.pinned.includes(b) && chrome.storage.local.set({ pinned: s.pinned.filter((x) => x !== b) }).then(draw),
      }),
    ),
  );

  const top = T.topInterests(s.profile, now);
  $('interests').replaceChildren(
    ...(top.length
      ? top.map(({ tag, score }) => {
          const li = el('li', `#${tag}`);
          li.append(el('div', '', { className: 'bar', style: `width:${Math.round((score / top[0].score) * 100)}%` }));
          return li;
        })
      : [el('li', 'Like or reblog a few posts and this fills in.')]),
  );
}

$('pin').onsubmit = async (e) => {
  e.preventDefault();
  const blog = $('blog').value.trim().toLowerCase().replace(/^@/, '').replace(/\.tumblr\.com$/, '');
  if (!/^[a-z0-9-]+$/.test(blog)) return;
  const { pinned } = await chrome.storage.local.get({ pinned: [] });
  await chrome.storage.local.set({ pinned: [...new Set([...pinned, blog])] });
  $('blog').value = '';
  chrome.runtime.sendMessage('check');
  draw();
};

$('read').onclick = async () => {
  const { unread, lastSeen } = await chrome.storage.local.get({ unread: [], lastSeen: {} });
  for (const p of unread) lastSeen[p.blog] = Math.max(lastSeen[p.blog] ?? 0, p.time);
  await chrome.storage.local.set({ unread: [], lastSeen });
  await chrome.action.setBadgeText({ text: '' });
  $('unread').replaceChildren(el('li', 'Nothing new.'));
};

$('refresh').onclick = () => chrome.runtime.sendMessage('check');
chrome.storage.onChanged.addListener(draw);
draw();
