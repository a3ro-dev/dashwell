import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const tumblrArchive = fileURLToPath(new URL('../.cache/datasets/Tumblr.zip', import.meta.url));
const url = 'https://data.mendeley.com/public-files/datasets/hd3b6v659v/files/46adf39b-f349-4035-9f66-9ba1758ba791/file_downloaded';
export function tumblrPosts() {
  if (!existsSync(tumblrArchive)) throw new Error('Create .cache/datasets and run curl -fL "' + url + '" -o .cache/datasets/Tumblr.zip');
  const hash = createHash('sha256').update(readFileSync(tumblrArchive)).digest('hex');
  if (hash !== '072ca591ae9765c066ba5ca1cc65602b12bdf290d4a227295d3ac2bfc8c8d4f8') throw new Error('Unexpected Tumblr.zip checksum');
  const windows = process.platform === 'win32';
  const sql = execFileSync(windows ? 'tar' : 'unzip', [windows ? '-xOf' : '-p', tumblrArchive, 'Tumblr.sql'], { maxBuffer: 32 << 20, encoding: 'utf8' });
  function rows(table) {
    const values = [];
    const token = /'(?:\\[\s\S]|[^'\\])*'|NULL|-?\d+/y;
    for (const insert of sql.matchAll(new RegExp('INSERT INTO \x60' + table + '\x60 VALUES ', 'g'))) {
      let i = insert.index + insert[0].length;
      do {
        if (sql[i++] !== '(') throw new Error('Expected SQL row');
        const fields = [];
        do {
          token.lastIndex = i;
          const field = token.exec(sql)?.[0];
          if (field == null) throw new Error('Unexpected SQL field at ' + i);
          fields.push(field.startsWith("'") ? field.slice(1,-1).replace(/\\(.)/gs, (_, c) => c === 'n' ? '\n' : c) : field);
          i = token.lastIndex;
        } while (sql[i++] === ',');
        values.push(fields);
      } while (sql[i++] === ',');
    }
    return values;
  }
  const descriptions = new Map(rows('Post_desc'));
  const unique = new Map();
  for (const [id,timestamp,,blog,,raw,count,,,via] of rows('Posts')) {
    const tags = Number(count) > 0 ? raw.replace(/^\[|\]$/g,'').split(/\+ /).map(t => t.trim()).filter(Boolean) : [];
    const source = descriptions.get(id) ?? '';
    const body = source.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,600);
    const href = source.match(/https?:\/\/[^\s<>"']+/i)?.[0];
    let destination;
    try {
      const u = new URL(href);
      if (!/(^|\.)(tumblr\.com|tmblr\.co)$/.test(u.hostname)) destination = u.origin + u.pathname;
    } catch {}
    unique.set(id,{id, root:id, blog, tags, numTags:Number(count), trail: via && !/^(null)$/i.test(via) ? [via] : [], now: Number(timestamp)*1000, text:body, body, destination});
  }
  return [...unique.values()].sort((a,b) => a.now-b.now || a.id.localeCompare(b.id));
}

export function tagTopics(posts) {
  const sets = new Map();
  for (const post of posts) {
    const tags = [...new Set(post.tags.map(t => t.toLowerCase()))];
    for (const hub of tags) {
      if (hub.length < 2 || hub.length > 32) continue;
      if (!sets.has(hub)) sets.set(hub, []);
      sets.get(hub).push(tags);
    }
  }
  return [...sets].sort((a,b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0,60)
    .map(([hub, sets]) => ({hub, sets, co:[...new Set(sets.flat())]}));
}
