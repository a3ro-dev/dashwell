import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = name => readFileSync(new URL('../extension/' + name, import.meta.url), 'utf8');
const feed = source('feed.js'), content = source('content.js');

function storage() {
  let stored = null, queue = Promise.resolve();
  return {
    locks: { request(_, fn) { queue = queue.then(fn); return queue; } },
    local: {
      async get(defaults) { return { ...defaults, engine: structuredClone(stored) }; },
      async set({ engine }) { stored = structuredClone(engine); },
    },
  };
}

async function tab(db) {
  let change, observer, article, now = 0;
  const listeners = new Map(), timers = new Map();
  function element() {
    const classes = new Set();
    return {
      dataset: {}, children: [],
      classList: { add: k => classes.add(k), remove: k => classes.delete(k), contains: k => classes.has(k), toggle() {} },
      setAttribute() {}, append(...nodes) { this.children.push(...nodes); },
      prepend(node) { this.children.unshift(node); node.parent = this; },
      remove() { this.parent.children = this.parent.children.filter(x => x !== this); },
      closest() { return { dataset: { id: '1234567' } }; },
      querySelectorAll(selector) { return selector === 'a[href]' ? [{ getAttribute: () => '/unrelated/7777777' }] : []; },
      querySelector(selector) {
        const bar = this.children.find(x => x.className === 'tn-bar');
        return selector === '.tn-bar' ? bar : selector === '.tn-bar button' ? bar?.children[1] : null;
      },
      textContent: 'A long read', getBoundingClientRect: () => ({ top: 80 }),
    };
  }
  const doc = {
    hidden: false, documentElement: element(), createElement: element, title: 'Tumblr',
    addEventListener(name, fn) { listeners.set(name, [...listeners.get(name) ?? [], fn]); },
    querySelector: () => null,
    querySelectorAll(sel) {
      return sel === '[data-id] article' || sel === '[data-id] article:not([data-tn])' && !article.dataset.tn ? [article] : [];
    },
  };
  article = element();
  const ctx = vm.createContext({
    document: doc, location: { pathname: '/dashboard', hostname: 'www.tumblr.com' }, performance: { now: () => now },
    crypto, structuredClone, navigator: { locks: db.locks },
    chrome: { storage: { local: db.local, onChanged: { addListener(fn) { change = fn; } } } },
    addEventListener() {}, setInterval() {}, setTimeout(fn) { timers.set(fn, fn); return fn; }, clearTimeout(fn) { timers.delete(fn); },
    MutationObserver: class { observe() {} },
    IntersectionObserver: class { constructor(fn) { observer = fn; } observe() {} },
  });
  vm.runInContext(feed, ctx);
  vm.runInContext(content, ctx);
  await new Promise(resolve => setImmediate(resolve));
  return {
    run: code => vm.runInContext(code, ctx), article, change,
    drainTimers() { for (const cb of [...timers.keys()]) { timers.delete(cb); cb(); } },
    visible(time, visible) { now = time; observer([{ target: article, time, isIntersecting: visible, intersectionRect: { height: visible ? 300 : 0 } }]); },
    background(time, hidden) { now = time; doc.hidden = hidden; for (const fn of listeners.get('visibilitychange')) fn(); },
  };
}

test('mounted posts reconcile without observing again, preloads and body links stay unseen', async () => {
  const t = await tab(storage());
  assert.equal(t.run('engine.n'), 1);
  assert.equal(t.run('engine.rr.length'), 0);
  t.change({ mutes: { newValue: 'long' } });
  assert.ok(t.article.querySelector('.tn-bar'));
  t.change({ mutes: { newValue: '' } });
  assert.equal(t.article.querySelector('.tn-bar'), undefined);
  t.change({ mutes: { newValue: 'long' } });
  t.change({ settings: { newValue: { shapeFeed: false } } });
  assert.equal(t.article.querySelector('.tn-bar'), undefined);
  assert.equal(t.run('engine.n'), 1);
  t.visible(10, true);
  assert.equal(t.run('engine.rr.join()'), '1234567');
  t.background(2110, true);
  t.background(90000, false);
  t.visible(92100, false);
  assert.equal(t.run("learned.has('1234567:dwell')"), true);
  assert.equal(t.run("elapsed.get('1234567')"), 4200);
});

test('Undo cancels the whole hide and saving concurrent tabs preserves both observations', async () => {
  const db = storage();
  const a = await tab(db), b = await tab(db);
  a.visible(5, true);
  const before = a.run('JSON.stringify(engine)');
  a.run("hidePost(document.querySelectorAll(ARTICLE)[0], posts.get('1234567'))");
  a.article.querySelector('.tn-bar button').onclick();
  assert.equal(a.run('JSON.stringify(engine)'), before);
  assert.equal(a.run('engaged.size'), 0);
  a.run("learn({ id: 'a', blog: 'reader-a', tags: ['books'] }, 'like')");
  b.run("learn({ id: 'b', blog: 'reader-b', tags: ['garden'] }, 'reblog')");
  await Promise.all([a.run('flush()'), b.run('flush()')]);
  const { engine } = await db.local.get({});
  assert.equal(engine.n, 2);
  assert.equal(engine.blogs['reader-a'].eng, 1);
  assert.equal(engine.blogs['reader-b'].eng, 1);
  assert.equal(engine.audit.length, 2);
  assert.deepEqual(engine.rr, ['1234567']);
});

test('actual first exposure supplies denominators and separates disagreement outcomes', async () => {
  const t = await tab(storage());
  t.change({ mutes: { newValue: 'long' } });
  t.visible(100, true);
  t.article.querySelector('.tn-bar button').onclick();
  t.run("learn(posts.get('1234567'), 'like')");
  assert.match(t.run('T.deviceStats(engine)'), /Recent visible For you posts: 1\/1 \(100%\) folds opened, 1\/1/);
});

test('repeated intersections preserve a read and a brief foreground pass can count as a skip', async () => {
  const read = await tab(storage());
  read.visible(50, true);
  read.visible(4150, true);
  read.visible(4200, false);
  read.drainTimers();
  assert.equal(read.run("learned.has('1234567:dwell')"), true);
  assert.equal(read.run("learned.has('1234567:skip')"), false);
  const skip = await tab(storage());
  skip.visible(50, true);
  skip.visible(230, false);
  skip.drainTimers();
  assert.equal(skip.run("learned.has('1234567:skip')"), true);
});

test('extract roots from the oldest linked trail entry and ignore links inside ordinary post text', async () => {
  const t = await tab(storage());
  const a = t.article;
  const links = hrefs => hrefs.map(href => ({ getAttribute: () => href }));
  a.querySelectorAll = selector => selector.includes('reblog-header')
    ? links(['/original/1111111', '/middle/2222222'])
    : selector === 'a[href]' ? links(['/citation/9999999']) : [];
  assert.equal(t.run('readPost(document.querySelectorAll(ARTICLE)[0]).root'), '1111111');
});
