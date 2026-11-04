import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { checkEntry, checkPackage, readZip, safePath } from './build-index.mjs';

/** Builds a small zip in memory (stored or deflated entries). */
function zip(files, deflate = true) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const body = deflate ? deflateRawSync(data) : data;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    locals.push(local, n, body);
    central.push(c, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const manifest = (over = {}) =>
  JSON.stringify({
    id: 'dev.you.pack',
    version: '1.2.0',
    widgets: [{ id: 'clock', preview: 'clock/preview.png' }],
    ...over,
  });

const entry = { id: 'dev.you.pack', repo: 'you/pack' };

test('zip reader handles stored and deflated entries', () => {
  for (const deflate of [true, false]) {
    const z = readZip(zip({ 'a.txt': 'hello', 'dir/b.txt': 'world'.repeat(50) }, deflate));
    assert.deepEqual(z.names, ['a.txt', 'dir/b.txt']);
    assert.equal(z.read('a.txt').toString(), 'hello');
    assert.equal(z.read('dir/b.txt').toString(), 'world'.repeat(50));
    assert.equal(z.read('missing'), null);
  }
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')));
});

test('unsafe paths are rejected', () => {
  assert.ok(safePath('widgets/clock/index.js'));
  for (const p of ['/etc/passwd', '\\x', 'C:/x', 'a/../../x', '..\\x']) assert.ok(!safePath(p), p);
});

test('store entries are validated', () => {
  assert.deepEqual(checkEntry({ ...entry, license: 'MIT', tags: ['clock'] }, 'dev.you.pack.json'), []);
  assert.ok(checkEntry({ ...entry, id: 'Pack' }).length);
  assert.ok(checkEntry({ ...entry, repo: 'https://github.com/you/pack' }).length);
  assert.ok(checkEntry(entry, 'other.json').length);
  assert.ok(checkEntry({ ...entry, tags: ['Bad Tag'] }).length);
  assert.ok(checkEntry({ ...entry, download: 'x' }).length);
});

test('packages must match their entry and release', () => {
  const good = zip({ 'vitrine.json': manifest(), 'clock/preview.png': 'png' });
  assert.deepEqual(checkPackage(entry, 'v1.2.0', readZip(good), good.length), []);

  const errs = (files, tag = 'v1.2.0') => {
    const z = zip(files);
    return checkPackage(entry, tag, readZip(z), z.length).join(' | ');
  };
  assert.match(errs({ 'vitrine.json': manifest(), 'clock/preview.png': 'p' }, 'v1.3.0'), /version/);
  assert.match(errs({ 'vitrine.json': manifest({ id: 'dev.other.pack' }), 'clock/preview.png': 'p' }), /id/);
  assert.match(errs({ 'vitrine.json': manifest() }), /preview/);
  assert.match(errs({ 'clock/preview.png': 'p' }), /vitrine.json missing/);
  assert.match(errs({ 'vitrine.json': '{oops', 'clock/preview.png': 'p' }), /vitrine.json/);
  assert.match(errs({ 'vitrine.json': manifest(), 'clock/preview.png': 'p', '../evil': 'x' }), /unsafe/);
  assert.match(
    (() => {
      const z = zip({ 'vitrine.json': manifest(), 'clock/preview.png': 'p' });
      return checkPackage(entry, 'v1.2.0', readZip(z), 60 * 1024 * 1024).join();
    })(),
    /max/,
  );
});

test('every listed pack is a valid entry', () => {
  for (const f of readdirSync('packs').filter((f) => f.endsWith('.json'))) {
    const e = JSON.parse(readFileSync(`packs/${f}`, 'utf8'));
    assert.deepEqual(checkEntry(e, f), [], f);
  }
});
