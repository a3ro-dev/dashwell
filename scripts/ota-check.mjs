// Pre-release check that existing Android users can take this release over the air.
// usage: node scripts/ota.mjs <minApp> && node scripts/ota-check.mjs [--live]
// Static: verifies dist/ota.json the way MainActivity.applyOta does (same key, files, version gates).
// --live: runs the OTA'd scripts the way setUpDashboard does (shim.js + feed.js + css + content.js, fake
// native bridge) on the logged-in debug browser's For you, starting from a real v1 profile, so we see
// old state migrate and the feed run before anyone gets the update.
import { createPublicKey, verify } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const OTA_CAPABLE = ['1.1.4', '1.1.5', '1.2.0']; // every APK that ships applyOta; add new ones as they release
const fail = (msg) => (console.log('FAIL', msg), (process.exitCode = 1));
const ok = (msg) => console.log('ok  ', msg);

const java = readFileSync('android/app/src/main/java/dev/a3ro/tumblrnew/MainActivity.java', 'utf8');
const key = java.match(/OTA_KEY = "([^"]+)"/)[1];
const appFiles = [...java.match(/OTA_FILES = java\.util\.Arrays\.asList\(([^)]*)\)/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const scriptFiles = JSON.parse(readFileSync('scripts/ota.mjs', 'utf8').match(/const FILES = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
if (appFiles.join() !== scriptFiles.join()) fail(`OTA_FILES differ: app ${appFiles} vs ota.mjs ${scriptFiles}`);

const body = readFileSync('dist/ota.json');
const pub = createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' });
if (!verify('sha256', body, { key: pub, dsaEncoding: 'der' }, readFileSync('dist/ota.json.sig'))) fail('signature does not verify against MainActivity.OTA_KEY');
else ok('signature verifies against the key in shipped APKs');

const m = JSON.parse(body);
const { version } = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
if (m.version !== version) fail(`ota.json version ${m.version} != manifest ${version} (the app rejects it)`);
const parse = (s) => parseInt(String(s).replace(/[^0-9].*$/, ''), 10) || 0;
const isNewer = (a, b) => {
  const x = a.split('.'), y = b.split('.');
  for (let i = 0; i < 3; i++) if (parse(x[i] ?? 0) !== parse(y[i] ?? 0)) return parse(x[i] ?? 0) > parse(y[i] ?? 0);
  return false;
};
for (const app of OTA_CAPABLE) {
  const takes = isNewer(m.version, app) && !isNewer(m.minApp, app);
  (takes ? ok : fail)(`app ${app} ${takes ? 'takes' : 'does NOT take'} OTA ${m.version} (minApp ${m.minApp})`);
}
for (const f of appFiles) {
  if (typeof m.files[f] !== 'string') fail(`ota.json is missing ${f}`);
  else if (m.files[f] !== readFileSync(`extension/${f}`, 'utf8')) fail(`ota.json ${f} is stale; rerun scripts/ota.mjs`);
}
ok(`ota.json ${(body.length / 1024).toFixed(0)} KB, files: ${appFiles.join(', ')}`);

// A realistic old profile: the last released engine, fed a few hundred posts and likes.
function v1Profile() {
  const src = execSync('git show v1.2.0:extension/feed.js', { encoding: 'utf8' });
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  const T = ctx.TumblrNew;
  const p = T.emptyProfile(), s = T.newSession();
  const topics = [['art', 'illustration', 'digital art'], ['space', 'astronomy', 'nasa'], ['marvel', 'mcu', 'spiderman'], ['cats', 'cute', 'animals']];
  let t = Date.now() - 20 * 864e5;
  for (let i = 0; i < 600; i++, t += 40 * 6e4) {
    const tags = topics[i % 4].concat(i % 7 ? [] : ['reblog']);
    const post = { id: `v1_${i}`, blog: `blog${i % 23}`, tags, root: `r${i % 500}` };
    T.observe(p, post, t);
    T.decide(p, s, post, [], t);
    if (i % 5 === 0) T.recordInteraction(p, s, post, i % 2 ? 'like' : 'dwell', t);
    if (i % 11 === 0) T.recordInteraction(p, s, post, 'skip', t);
  }
  return JSON.parse(JSON.stringify(p));
}
const old = v1Profile();
ok(`built a v1.2.0 profile (${(JSON.stringify(old).length / 1024).toFixed(0)} KB, ${Object.keys(old.tags).length} tags)`);

// Offline: the new feed.js must load the old profile and keep deciding.
{
  const ctx = vm.createContext({});
  vm.runInContext(m.files['feed.js'], ctx);
  const T = ctx.TumblrNew;
  const p = JSON.parse(JSON.stringify(old)), s = T.newSession();
  let now = Date.now();
  try {
    for (let i = 0; i < 200; i++, now += 3e4) {
      const post = { id: `n${i}`, blog: `blog${i % 23}`, tags: ['art', 'space', 'cats'].slice(i % 3), root: `n${i}`, trail: [], text: 'hello' };
      T.observe(p, post, now);
      const d = T.decide(p, s, post, [], now);
      if (!d?.action || !d.reason) throw new Error(`decision without action/reason: ${JSON.stringify(d)}`);
      if (T.learnImpression) T.learnImpression(p, s, post, { engaged: i % 4 === 0, dwell: i % 3 === 0, skip: i % 9 === 0, hide: false }, now);
    }
    const kept = Object.keys(old.tags).filter((t) => p.tags[t]).length / Object.keys(old.tags).length;
    (kept > 0.9 ? ok : fail)(`old profile migrated: ${(kept * 100).toFixed(0)}% of old tags kept, ${(JSON.stringify(p).length / 1024).toFixed(0)} KB after`);
  } catch (e) {
    fail(`new feed.js crashed on a v1 profile: ${e.stack}`);
  }
}

if (process.argv.includes('--live')) {
  const { default: puppeteer } = await import('puppeteer-core');
  const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null }).catch(() => null);
  if (!b) fail('no debug browser on 127.0.0.1:9222 (start Chrome with the .cache/profile and --remote-debugging-port=9222)');
  else {
    const page = await b.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setBypassCSP(true);
    await page.setViewport({ width: 412, height: 900, isMobile: true, hasTouch: true });
    // Fake TumblrNewNative bridge with the old profile in "app storage", then the exact app bundle.
    const shim = readFileSync('android/app/src/main/assets/shim.js', 'utf8');
    const bundle = `(()=>{${shim}\n${m.files['feed.js']}\n{const s=document.createElement('style');s.textContent=${JSON.stringify(m.files['cosmetic.css'] + '\n' + m.files['content.css'])};(document.head||document.documentElement).appendChild(s);}\n${m.files['content.js']}\n})();`;
    await page.evaluateOnNewDocument((engine) => {
      const store = { engine: JSON.stringify(engine) };
      globalThis.__tnStore = store;
      const N = {
        postMessage(raw) {
          const msg = JSON.parse(raw);
          let result = null;
          if (msg.op === 'get') result = store[msg.key] ?? null;
          if (msg.op === 'set') store[msg.key] = msg.value;
          if (msg.op === 'remove') delete store[msg.key];
          setTimeout(() => N.onmessage?.({ data: JSON.stringify({ id: msg.id, result }) }));
        },
      };
      globalThis.TumblrNewNative = N;
    }, old);
    // Android's document-start script sees <html>; puppeteer's runs a beat earlier, so wait for it. Top frame only, like the app.
    await page.evaluateOnNewDocument(`if (top === self && location.origin === 'https://www.tumblr.com') {
      const run = () => { ${bundle} };
      if (document.documentElement) run();
      else new MutationObserver((_, o) => document.documentElement && (o.disconnect(), run())).observe(document, { childList: true });
    }`);
    await page.goto('https://www.tumblr.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 6000));
    for (let i = 0; i < 6; i++) await page.mouse.wheel({ deltaY: 1400 }), await new Promise((r) => setTimeout(r, 1500));
    await new Promise((r) => setTimeout(r, 6000)); // engine saves every 5 s
    const r = await page.evaluate(() => {
      const e = JSON.parse(globalThis.__tnStore.engine ?? 'null');
      return {
        path: location.pathname,
        loggedIn: !document.querySelector('a[href*="/login"]'),
        decided: document.querySelectorAll('[data-tn]').length,
        folded: [...document.querySelectorAll('.tn-bar p')].map((x) => x.textContent).slice(0, 6),
        engineKB: Math.round((globalThis.__tnStore.engine?.length ?? 0) / 1024),
        engineKeys: e && Object.keys(e),
      };
    });
    await page.close();
    b.disconnect();
    console.log(JSON.stringify(r, null, 1));
    if (!r.loggedIn) fail('debug browser is not logged in to Tumblr');
    if (errors.length) fail(`page exceptions: ${errors.join(' | ')}`);
    (r.decided > 0 ? ok : fail)(`live For you: ${r.decided} posts decided by the OTA bundle on top of the old profile`);
  }
}
console.log(process.exitCode ? '\nNOT SAFE TO SHIP over the air' : '\nsafe to ship over the air');
