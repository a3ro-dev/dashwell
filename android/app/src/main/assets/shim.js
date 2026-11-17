// Minimal chrome.* API shim so the extension's scripts run unchanged inside the app's WebView.
// Storage lives in app-private files. The TumblrNewNative bridge is only injected into
// https://www.tumblr.com and the app's own settings page (origin-restricted), never into ad iframes.
(() => {
  if (globalThis.chrome?.storage || !globalThis.TumblrNewNative) return;
  const N = globalThis.TumblrNewNative;
  const pending = new Map();
  let seq = 0;
  N.onmessage = (e) => {
    const { id, result } = JSON.parse(e.data);
    pending.get(id)?.(result);
    pending.delete(id);
  };
  const call = (msg) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      N.postMessage(JSON.stringify({ id, ...msg }));
    });

  const listeners = [];
  const messageHandlers = [];
  const noop = { addListener() {} };
  const local = {
    async get(keys) {
      const defaults = typeof keys === 'string' ? { [keys]: undefined } : Array.isArray(keys) ? Object.fromEntries(keys.map((k) => [k, undefined])) : keys ?? {};
      const out = {};
      await Promise.all(
        Object.entries(defaults).map(async ([k, d]) => {
          const v = await call({ op: 'get', key: k });
          if (v != null) out[k] = JSON.parse(v);
          else if (d !== undefined) out[k] = d;
        }),
      );
      return out;
    },
    async set(items) {
      await Promise.all(Object.entries(items).map(([k, v]) => call({ op: 'set', key: k, value: JSON.stringify(v) })));
    },
    async remove(keys) {
      await Promise.all([].concat(keys).map((k) => call({ op: 'remove', key: k })));
    },
  };
  // Called by the app when another screen (dashboard or settings sheet) changed storage.
  globalThis.__tnStorageChanged = (changes) => listeners.forEach((fn) => fn(changes, 'local'));
  // Blog RSS lives on other origins; the app fetches it natively (only https://<blog>.tumblr.com/rss).
  const pageFetch = globalThis.fetch?.bind(globalThis);
  globalThis.fetch = async (url, opts) => {
    if (/^https:\/\/[\w-]+\.tumblr\.com\/rss$/.test(String(url))) {
      const r = JSON.parse(await call({ op: 'rss', url: String(url) }));
      return new Response(r.body ?? '', { status: r.status || 599 });
    }
    return pageFetch(url, opts);
  };
  // The on-page settings icon (Tumblr's top bar) opens the app's settings sheet.
  if (location.origin === 'https://www.tumblr.com') globalThis.__tnOpenSettings = () => call({ op: 'sheet' });
  else globalThis.__tnOpenUrl = (url) => call({ op: 'open', url: String(url) });
  globalThis.chrome = {
    storage: { local, onChanged: { addListener: (fn) => listeners.push(fn) } },
    runtime: {
      sendMessage: async (msg) => messageHandlers.forEach((fn) => fn(msg)),
      onMessage: { addListener: (fn) => messageHandlers.push(fn) },
      onInstalled: noop,
      onStartup: noop,
    },
    alarms: { create() {}, onAlarm: noop },
    action: { setBadgeText: ({ text }) => call({ op: 'badge', value: text ?? '' }) },
  };
})();
