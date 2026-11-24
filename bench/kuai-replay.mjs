// Node 22.13+ with built-in SQLite and an archive reader on PATH.
import { DatabaseSync } from 'node:sqlite';
import { spawn, execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { makeRng } from './world.mjs';

const rec = process.argv[2] === 'kuairec';
const file = rec ? 'KuaiRec.zip' : 'KuaiRand-Pure.tar.gz';
const archive = fileURLToPath(new URL('../.cache/datasets/' + file, import.meta.url));
const url = 'https://zenodo.org/records/' + (rec ? '18164998' : '10439422') + '/files/' + file;
if (!existsSync(archive)) throw new Error('Create .cache/datasets and run curl -fL "' + url + '" -o .cache/datasets/' + file);
const md5 = createHash('md5');
for await (const chunk of createReadStream(archive)) md5.update(chunk);
if (md5.digest('hex') !== (rec ? '261550d472c48eff4990fb13c0e5bcf7' : '0820331067a3784d9691136f772b35a7')) throw new Error('Download checksum mismatch');
const zip = rec && process.platform !== 'win32';
const reader = zip ? 'unzip' : 'tar';
const members = execFileSync(reader,[zip ? '-Z1' : '-tf',archive],{encoding:'utf8'}).trim().split(/\r?\n/);
async function rows(filename, consume) {
  const name = members.find(n => n.endsWith('/' + filename) && !n.startsWith('__MACOSX/'));
  if (!name) throw new Error('Missing archive member ' + filename);
  const proc = spawn(reader,[zip ? '-p' : '-xOf',archive,name],{stdio:['ignore','pipe','inherit']});
  const done = new Promise((resolve,reject) => { proc.on('error',reject); proc.on('close',resolve); });
  let columns;
  for await (const line of createInterface({input:proc.stdout,crlfDelay:Infinity})) {
    if (!columns) { columns = Object.fromEntries(line.split(',').map((x,i) => [x,i])); continue; }
    const fields = line.includes('"') ? [...line.matchAll(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g)].map(m=>m[1]) : line.split(',');
    consume(name => fields[columns[name]] ?? '');
  }
  if (await done !== 0) throw new Error('Extraction failed: ' + filename);
}
const items = new Map();
function item(id) {
  if (!items.has(id)) items.set(id,{id:'v'+id, root:'v'+id, tags:[], blog:'unknown-video-'+id});
  return items.get(id);
}
const tags = raw => (raw.match(/\d+/g) ?? []).map(id => 'tag '+id);
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE events(user INTEGER, video INTEGER, time INTEGER, flags INTEGER); BEGIN');
const insert = db.prepare('INSERT INTO events VALUES(?,?,?,?)');
let missingTime = 0;
const LIKE=1, FOLLOW=2, COMMENT=4, FORWARD=8, HATE=16, DWELL=32, SKIP=64, GOOD=128, RANDOM=256;
if (rec) {
  await rows('item_categories.csv', f => { item(f('video_id')).tags = tags(f('feat')); });
  await rows('item_daily_features.csv', f => { item(f('video_id')).blog = 'author '+f('author_id'); });
  await rows('small_matrix.csv', f => {
    const u = +f('user_id');
    if (u % 5 !== 0) return;
    const watch = +f('watch_ratio') >= 0.8, play = +f('play_duration');
    const time = +f('timestamp');
    if (!Number.isFinite(time) || time <= 0) { missingTime++; return; }
    insert.run(u,+f('video_id'),Math.round(time*1000),(watch ? DWELL|GOOD : 0) | (play > 0 && play < 300 ? SKIP : 0));
  });
} else {
  await rows('video_features_basic_pure.csv', f => {
    const x = item(f('video_id'));
    if (f('author_id') && f('author_id') !== '-1') x.blog = 'author '+f('author_id');
    x.tags = tags(f('tag'));
  });
  for (const name of members.filter(n => /\/log_.*\.csv$/.test(n))) await rows(name.split('/').at(-1), f => {
    const play = +f('play_time_ms'), duration = +f('duration_ms');
    const long = +f('long_view'), like = +f('is_like');
    const flags = like*LIKE | +f('is_follow')*FOLLOW | +f('is_comment')*COMMENT | +f('is_forward')*FORWARD |
      +f('is_hate')*HATE | (long || (duration > 0 && play/duration >= 0.8) ? DWELL : 0) |
      (play > 0 && play < 300 ? SKIP : 0) | (like || long ? GOOD : 0) | +f('is_rand')*RANDOM;
    insert.run(+f('user_id'),+f('video_id'),+f('time_ms'),flags);
  });
}
db.exec('COMMIT; CREATE INDEX chronological ON events(user,time)');
function totals() {
  return { n:0, positive:0, folds:0, lost:0, hates:0, shownHate:0, consecutive:0, explore:0, exploreGood:0, second:0, secondGood:0 };
}
const ratio = (a,b) => b ? a/b : null;
function metrics(c) {
  return { ...c, wrong:ratio(c.lost,c.folds), recall:ratio(c.positive-c.lost,c.positive),
    hatedShown:ratio(c.shownHate,c.hates), fold:ratio(c.folds,c.n), adjacent:ratio(c.consecutive,c.n),
    lift: c.positive ? ratio(c.positive-c.lost,c.n-c.folds)/ratio(c.positive,c.n) : null,
    explorationPositive:ratio(c.exploreGood,c.explore), secondChancePositive:ratio(c.secondGood,c.second) };
}
const output = {};
for (const [version,path] of [['1.2.0','./feed.v1.js'],['1.3.0','./feed.v13.js'],['1.3.1','../extension/feed.js']]) {
  await import(path);
  const T = globalThis.TumblrNew;
  const counts = {all:totals(), held:totals(), randomHeld:totals()};
  let lastUser, lastTime, previousFold, profile, session, rng, users=0, heldUsers=0;
  for (const {user, video, time, flags} of db.prepare('SELECT * FROM events ORDER BY user,time,rowid').iterate()) {
    if (user !== lastUser) {
      profile = T.emptyProfile(); lastTime = -Infinity; lastUser = user;
      rng = makeRng('kuai:'+user); users++; heldUsers += Number(user%5===0);
    }
    if (time-lastTime > 30*60000) { session = T.newSession(); session.rand = rng; previousFold = false; }
    lastTime = time;
    const x = { ...item(String(video)) }; // impressions have their own decision-time feature cache
    T.observe(profile,x,time);
    const d = T.decide(profile,session,x,[],time);
    const fold = d.action === 'collapse', good = Number(Boolean(flags&GOOD)), hate = Number(Boolean(flags&HATE));
    const groups = [counts.all];
    if (user%5===0) { groups.push(counts.held); if (flags&RANDOM) groups.push(counts.randomHeld); }
    for (const c of groups) {
      c.n++; c.positive += good; c.folds += fold; c.lost += fold*good; c.hates += hate;
      c.shownHate += !fold*hate; c.consecutive += Number(fold && previousFold);
      if (d.action === 'explore') { c.explore++; c.exploreGood += good; }
      if (d.reason.startsWith('second chance')) { c.second++; c.secondGood += good; }
    }
    previousFold = fold;
    if (fold) continue;
    T.remember?.(profile,x.root);
    const engaged = Boolean(flags&(LIKE|FOLLOW|COMMENT|FORWARD));
    const dwell = Boolean(flags&DWELL), skip = Boolean(flags&SKIP) && !engaged && !dwell && !hate;
    for (const [yes,kind] of [[flags&(LIKE|FOLLOW),'like'],[flags&COMMENT,'comment'],[flags&FORWARD,'reblog'],[hate,'hide'],[dwell,'dwell'],[skip,'skip']])
      if (yes) T.recordInteraction(profile,session,x,kind,time);
    T.learnImpression?.(profile,session,x,{engaged,hide:!!hate,dwell,skip},time);
  }
  output[version] = { users, heldUsers, missingTime, ...Object.fromEntries(Object.entries(counts).map(([k,c]) => [k,metrics(c)])) };
  console.error(file, version, users, 'users complete');
}
console.log(JSON.stringify(output,null,2));
