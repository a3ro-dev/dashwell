// Synthetic Tumblr: topics with tag vocabularies, blogs with heavy-tailed posting rates,
// reblog cascades, and a For-you-like candidate stream. Nothing here knows about the engine.

function hash(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

// Seeded PRNG (mulberry32) with the few helpers the sim needs. Seed with a number or a label string.
export function makeRng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hash(seed);
  const r = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.int = (n) => Math.floor(r() * n);
  r.chance = (p) => r() < p;
  r.pick = (xs) => xs[r.int(xs.length)];
  r.shuffle = (xs) => {
    const o = [...xs];
    for (let i = o.length - 1; i > 0; i--) {
      const j = r.int(i + 1);
      [o[i], o[j]] = [o[j], o[i]];
    }
    return o;
  };
  r.sample = (xs, k) => r.shuffle(xs).slice(0, k);
  r.normal = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  r.pareto = (alpha, min) => min * (1 - r()) ** (-1 / alpha);
  r.weighted = (xs, w) => {
    let total = 0;
    const cum = xs.map((x) => (total += w(x)));
    const x = r() * total;
    return xs[cum.findIndex((c) => c > x)];
  };
  return r;
}

const HUBS = ['star trek', 'elden ring', 'taylor swift', 'formula 1', 'hollow knight', 'the bear', 'dungeons and dragons', 'astronomy', 'birdwatching', 'sourdough', 'houseplants', 'knitting', 'linguistics', 'fountain pens', 'mechanical keyboards', 'retro games', 'jazz', 'k-pop', 'studio ghibli', 'marvel', 'doctor who', 'sherlock', 'oceanography', 'tarot', 'ceramics', 'film photography', 'urbanism', 'cats', 'gardening', 'thrifting', 'minecraft', 'genshin impact', 'arcane', 'one piece', 'horror movies', 'poetry', 'medieval history', 'bookbinding', 'tabletop rpg', 'cycling', 'chess', 'mycology', 'fashion history', 'synthwave', 'linux', 'anime', 'crochet', 'baking', 'vinyl records', 'pokemon', 'zelda', 'true crime', 'dinosaurs', 'cottagecore', 'vtubers', 'soccer', 'dune', 'lord of the rings', 'disco elysium', 'skincare'];
const SUFFIX = ['fanart', 'memes', 'headcanons', 'aesthetic', 'edit', 'gifs', 'quotes', 'theory', 'appreciation', 'analysis', 'art', 'cosplay', 'playlist', 'discourse', 'lore'];
const SYL = ['ka', 'mi', 'ra', 'jo', 'el', 'sun', 'vi', 'tor', 'ne', 'lu', 'ash', 'bri', 'dan', 'ori', 'zel', 'mar'];
const GENERIC = ['art', 'aesthetic', 'music', 'books', 'games', 'funny']; // shared across topics: ambiguous bridge tags
// Commentary the engine's regex knows ("i'm screaming") and commentary it does not ("iconic").
const COMMENT = ["i'm screaming", 'this is so me', 'not me crying', 'literally', 'help', 'oh my god', 'why is this so accurate', 'my beloved', 'wait what', 'same', 'so true', 'ugh', 'blessed', 'iconic', 'unhinged', 'aaaaaa', 'fandom problems', 'good vibes', 'thoughts'];
const META = ['reblog', 'fyp', 'long post', 'personal', 'text', 'photo', 'queue', 'tumblr'];
const ADJ = ['moon', 'salt', 'velvet', 'paper', 'ghost', 'honey', 'pixel', 'rust', 'amber', 'quiet', 'soft', 'wild', 'neon', 'dusty', 'lunar', 'cobalt', 'mossy', 'tiny', 'blue', 'sleepy'];
const NOUN = ['fox', 'garden', 'archive', 'witch', 'bones', 'bird', 'tea', 'radio', 'robot', 'library', 'moth', 'jam', 'static', 'bread', 'lamp', 'crow', 'thread', 'pond', 'cloud', 'ink'];

export function makeWorld(seed) {
  const r = makeRng(`${seed}:world`);
  const name = () => r.pick(SYL) + r.pick(SYL) + (r.chance(0.3) ? r.pick(SYL) : '');
  const order = r.shuffle(HUBS.map((_, i) => i)); // order[0] is the most popular topic
  const topics = HUBS.map((hub, id) => {
    const co = new Set();
    const n = 3 + r.int(6); // hub tag + 3-8 co-occurring tags
    while (co.size < n) co.add(r.chance(0.4) ? `${hub} ${r.pick(SUFFIX)}` : r.chance(0.12) ? r.pick(GENERIC) : name());
    return { id, hub, co: [...co], pop: (order.indexOf(id) + 1) ** -0.9 };
  });
  const popular = topics[order[0]].id;
  const topicByPop = () => r.weighted(topics, (t) => t.pop);

  const blogs = r.shuffle(ADJ.flatMap((a) => NOUN.map((n) => a + n))).map((blog, i) => {
    if (i < 5) return { name: blog, kind: 'firehose', rate: 3 + r() * 3, reblog: 0.6, mix: r.sample(topics, 6).map((t) => [t.id, 1]) };
    if (i < 17) return { name: blog, kind: 'spam', rate: 4 + r() * 2, reblog: 0, mix: [] };
    const ts = [];
    for (let k = 1 + r.chance(0.5) + r.chance(0.2); ts.length < k; ) {
      const t = topicByPop();
      if (!ts.includes(t)) ts.push(t);
    }
    return { name: blog, kind: 'normal', rate: Math.min(4, r.pareto(1.3, 0.15)), reblog: 0.35, primary: ts[0].id, mix: ts.map((t, j) => [t.id, [0.65, 0.25, 0.1][j]]) };
  });
  return { topics, blogs, popular };
}

function tagsFor(world, r, topic, isReblog, spam) {
  const tags = [];
  if (spam) {
    tags.push(...r.sample(world.topics, 2 + r.int(4)).map((t) => r.chance(0.6) ? t.hub : r.pick(t.co)));
  } else if (!r.chance(0.1)) { // a tenth of posts carry no topic tags at all
    if (r.chance(isReblog ? 0.5 : 0.75)) tags.push(topic.hub);
    tags.push(...r.sample(topic.co, 1 + r.int(3)));
  }
  const noise = r.chance(0.35) ? r.sample(COMMENT, 1 + r.int(2)) : [];
  if (r.chance(0.25)) noise.push(r.pick(META));
  return r.chance(0.2) ? [...noise, ...tags] : [...tags, ...noise]; // authors usually, not always, put topic tags first
}

// A For-you-like stream: 70% from followed blogs (by posting rate), 30% popularity-driven recommendations.
export function makeFeed(world, follows, r) {
  const pool = []; // recent roots that can still be reblogged
  const seenRoots = new Set();
  let n = 0;
  const recWeight = (b) => b.rate * (b.kind === 'spam' ? 0.2 : b.mix.reduce((a, [t, w]) => a + w * world.topics[t].pop, 0));
  return {
    next() {
      const blog = r.chance(0.7) ? r.weighted(follows, (b) => b.rate) : r.weighted(world.blogs, recWeight);
      const spam = blog.kind === 'spam';
      const topic = spam ? r.pick(world.topics) : world.topics[r.weighted(blog.mix, ([, w]) => w)[0]];
      const id = `p${n++}`;
      let root = null;
      if (!spam && r.chance(blog.reblog)) {
        const same = pool.filter((p) => p.topic === topic.id);
        if (same.length) (root = r.weighted(same, (p) => p.weight)).weight++; // rich get richer
      }
      if (!root && !spam) {
        pool.push({ id, topic: topic.id, blog: blog.name, weight: Math.min(30, r.pareto(1.2, 1)) });
        if (pool.length > 150) pool.shift();
      }
      const rootId = root?.id ?? id;
      const dup = seenRoots.has(rootId);
      seenRoots.add(rootId);
      let tags = tagsFor(world, r, topic, !!root, spam);
      const promoting = spam || r.chance(0.07);
      const body = promoting ? 'New prints available this week at my shop' : 'I keep thinking about ' + r.pick(topic.co);
      const destination = promoting ? 'https://' + blog.name + '.example/shop' : '';
      if (r.chance(0.18)) tags = tags.slice(0, 1);
      return { topic: topic.id, kind: blog.kind, dup, view: { id, blog: blog.name, root: rootId, trail: root ? [root.blog] : [], tags, body, destination, text: body } };
    },
  };
}
