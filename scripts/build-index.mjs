// Builds the Vitrine store catalogue.
//
//   node scripts/build-index.mjs [--out site] [--only <id> ...]
//
// For every entry in packs/*.json: reads the latest GitHub release of the
// pack's repository, downloads its .vitrine asset, checks it (safe paths,
// size, manifest id/version, previews) and writes:
//   <out>/index.json                    the catalogue the app and the website read
//   <out>/previews/<pack>/<widget>.png  widget previews taken from the package
//   <out>/icons/<pack>.png|svg          the pack's icon, when its manifest has one
// Exits non-zero when any entry fails, so pull requests are blocked.
// No dependencies: Node 20+ (fetch, zlib).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const MAX_PACKAGE = 50 * 1024 * 1024;
const ID = /^[a-z0-9]+(\.[a-z0-9-]+){2,}$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const TAG_WORDS = /^[a-z0-9-]{2,24}$/;

const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'site';
const only = args.includes('--only') ? args.slice(args.indexOf('--only') + 1) : null;
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

async function github(path) {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'vitrine-store',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${path}: HTTP ${res.status}`);
  return res.json();
}

/** Minimal ZIP reader (central directory; stored and deflated entries). */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    const lnlen = buf.readUInt16LE(local + 26);
    const lxlen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lnlen + lxlen;
    entries.set(name, { method, csize, usize, start });
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const raw = buf.subarray(e.start, e.start + e.csize);
      if (e.method === 0) return Buffer.from(raw);
      if (e.method === 8) return inflateRawSync(raw);
      throw new Error(`${name}: unsupported compression ${e.method}`);
    },
  };
}

export function safePath(name) {
  return !(name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/.test(name) ||
    name.split(/[\\/]/).some((part) => part === '..'));
}

/** Checks a store entry file; returns a list of problems. */
export function checkEntry(entry, file) {
  const errors = [];
  if (!ID.test(entry.id ?? '')) errors.push('id must be reverse-DNS, e.g. "dev.you.widgets"');
  if (file && file !== `${entry.id}.json`) errors.push(`file must be named ${entry.id}.json`);
  if (!REPO.test(entry.repo ?? '')) errors.push('repo must be "owner/name" on GitHub');
  if (entry.tags && (!Array.isArray(entry.tags) || entry.tags.length > 6 || !entry.tags.every((t) => TAG_WORDS.test(t))))
    errors.push('tags: up to 6 lowercase words');
  const known = new Set(['id', 'repo', 'license', 'tags']);
  for (const k of Object.keys(entry)) if (!known.has(k)) errors.push(`unknown field "${k}"`);
  return errors;
}

/** Checks a downloaded package against its store entry. */
export function checkPackage(entry, tag, zip, bytes) {
  const errors = [];
  if (bytes > MAX_PACKAGE) errors.push(`package is ${bytes} bytes (max ${MAX_PACKAGE})`);
  const bad = zip.names.filter((n) => !safePath(n));
  if (bad.length) errors.push(`unsafe paths: ${bad.join(', ')}`);
  const raw = zip.read('vitrine.json');
  if (!raw) return [...errors, 'vitrine.json missing at the package root'];
  let m;
  try { m = JSON.parse(raw.toString('utf8')); } catch (e) { return [...errors, `vitrine.json: ${e.message}`]; }
  if (m.id !== entry.id) errors.push(`manifest id "${m.id}" ≠ store id "${entry.id}"`);
  const version = tag.replace(/^v/, '');
  if (m.version !== version) errors.push(`manifest version ${m.version} ≠ release tag ${tag}`);
  if (!Array.isArray(m.widgets) || m.widgets.length === 0) errors.push('no widgets');
  for (const w of m.widgets ?? []) {
    if (!w.preview || !zip.read(w.preview)) errors.push(`widget "${w.id}": preview image missing`);
  }
  if (m.icon !== undefined) {
    if (typeof m.icon !== 'string' || !/\.(png|svg)$/i.test(m.icon)) errors.push('icon must be a .png or .svg file');
    else if (!zip.read(m.icon)) errors.push(`icon "${m.icon}" missing`);
  }
  return errors;
}

async function buildPack(entry) {
  const rel = await github(`repos/${entry.repo}/releases/latest`);
  const assets = rel.assets.filter((a) => a.name.endsWith('.vitrine'));
  if (assets.length !== 1) throw new Error(`release ${rel.tag_name} must have exactly one .vitrine asset`);
  const asset = assets[0];
  const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'vitrine-store' } });
  if (!res.ok) throw new Error(`download: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = readZip(buf);
  const errors = checkPackage(entry, rel.tag_name, zip, buf.length);
  if (errors.length) throw new Error(errors.join('; '));
  const m = JSON.parse(zip.read('vitrine.json').toString('utf8'));
  const repo = await github(`repos/${entry.repo}`);
  const dir = join(out, 'previews', entry.id);
  mkdirSync(dir, { recursive: true });
  let icon = null;
  if (m.icon) {
    const ext = m.icon.toLowerCase().endsWith('.svg') ? 'svg' : 'png';
    mkdirSync(join(out, 'icons'), { recursive: true });
    writeFileSync(join(out, 'icons', `${entry.id}.${ext}`), zip.read(m.icon));
    icon = `icons/${entry.id}.${ext}`;
  }
  const widgets = m.widgets.map((w) => {
    writeFileSync(join(dir, `${w.id}.png`), zip.read(w.preview));
    return {
      id: w.id,
      name: w.name,
      description: w.description ?? '',
      size: w.size,
      interactive: !!w.interactive,
      permissions: w.permissions ?? [],
      preview: `previews/${entry.id}/${w.id}.png`,
    };
  });
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    author: m.author ?? repo.owner.login,
    description: m.description ?? repo.description ?? '',
    homepage: m.homepage ?? repo.html_url,
    repo: entry.repo,
    license: entry.license ?? repo.license?.spdx_id ?? null,
    tags: entry.tags ?? [],
    official: entry.repo.startsWith('vitrine-org/'),
    minEngine: m.minEngine ?? '2.0.0',
    icon,
    stars: repo.stargazers_count,
    published: rel.published_at,
    download: asset.browser_download_url,
    size: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
    widgets,
  };
}

async function main() {
  const files = readdirSync('packs').filter((f) => f.endsWith('.json')).sort();
  const packs = [];
  let failed = 0;
  for (const file of files) {
    const entry = JSON.parse(readFileSync(join('packs', file), 'utf8'));
    if (only && !only.includes(entry.id) && !only.includes(file)) continue;
    const problems = checkEntry(entry, file);
    if (problems.length) {
      console.error(`✗ ${file}: ${problems.join('; ')}`);
      failed++;
      continue;
    }
    try {
      const pack = await buildPack(entry);
      packs.push(pack);
      console.log(`✓ ${pack.id} ${pack.version} (${pack.widgets.length} widgets)`);
    } catch (e) {
      console.error(`✗ ${entry.id}: ${e.message}`);
      failed++;
    }
  }
  // Official packs first, then by name.
  packs.sort((a, b) => (b.official - a.official) || a.name.localeCompare(b.name));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'index.json'), JSON.stringify({ version: 1, generated: new Date().toISOString(), packs }, null, 2) + '\n');
  writeFileSync(join(out, '.nojekyll'), '');
  console.log(`${packs.length} packs → ${join(out, 'index.json')}`);
  if (failed) process.exit(1);
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/').replace(/^\//, '')}` || process.argv[1].endsWith('build-index.mjs')) {
  await main();
}
