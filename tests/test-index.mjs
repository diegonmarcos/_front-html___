#!/usr/bin/env node
// Tests for the generated index: schema, determinism, private exclusion, and every card link resolving in the served tree.
//
//   node tests/test-index.mjs              offline checks + served-tree link check (needs .cache from --scan, and playwright)
//   SHOT=out.png node tests/test-index.mjs  also writes a screenshot of index.html (deviceScaleFactor 2)
//
// Served tree: a temp folder standing in for the parent git/ root: <hub.repo>/index.html plus, per sub-repo folder, only
// the files the cards link to, read at the pinned SHA from the blobless .cache (git fetches just those blobs). A local
// static server serves it for the test only and is stopped at the end.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { ROOT, cards, declared, render, pickEntries, isEntry } from '../scripts/gen-index.mjs';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${n} ${name}`); };
const idx = JSON.parse(readFileSync(join(ROOT, 'index.json'), 'utf8'));
const { priv, pub } = declared();

ok('index.json schema', () => {
  for (const k of ['hub', 'groups', 'repos', 'overrides', 'exclude', 'pins', 'entries']) assert.ok(k in idx, `missing ${k}`);
  assert.equal(typeof idx.hub.repo, 'string'); assert.equal(typeof idx.hub.title, 'string');
  assert.ok(Array.isArray(idx.groups) && idx.groups.length);
  const ids = idx.groups.map((g) => g.id); assert.equal(new Set(ids).size, ids.length, 'duplicate group id');
  for (const g of idx.groups) { assert.equal(typeof g.title, 'string'); assert.ok(Array.isArray(g.match)); }
  for (const [r, v] of Object.entries(idx.repos)) { assert.equal(typeof v, 'object', r); if (v.group) assert.ok(ids.includes(v.group), `${r}: unknown group ${v.group}`); }
  for (const [k, v] of Object.entries(idx.overrides)) { assert.ok(idx.entries.some((e) => `${e.repo}/${e.path}` === k), `override ${k} matches no entry`); if (v.group) assert.ok(ids.includes(v.group)); }
  for (const x of [...idx.exclude, ...(idx.include || [])]) new RegExp(x);
  const keys = idx.entries.map((e) => `${e.repo}/${e.path}`);
  assert.equal(new Set(keys).size, keys.length, 'duplicate entry');
  for (const e of idx.entries) { assert.ok(pub.some((p) => p.path === e.repo), `entry repo ${e.repo} not a public declared repo`); assert.ok(e.path.endsWith('.html')); assert.ok(!e.path.includes('..')); }
});

ok('entry-point rule', () => {
  assert.deepEqual(pickEntries(['a/src/index.html', 'a/dist/index.html', 'a/dist/sub/index.html', 'index.html', 'x.html', 'b/node_modules/m/index.html', 'c/page.html', 'b/index.html']),
    ['a/dist/index.html', 'b/index.html', 'index.html', 'x.html']);
  assert.ok(!isEntry('t/test/fixtures/index.html'));
});

ok('render is deterministic and committed index.html is current', () => {
  const a = render(idx), b = render(JSON.parse(JSON.stringify(idx)));
  assert.equal(a, b);
  assert.equal(readFileSync(join(ROOT, 'index.html'), 'utf8'), a, 'index.html stale: node scripts/gen-index.mjs');
});

const cs = cards(idx);
ok('private repos excluded', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  for (const r of priv) { assert.ok(!idx.entries.some((e) => e.repo === r)); assert.ok(!(r in idx.pins)); assert.ok(!html.includes(r), `${r} appears in index.html`); }
  assert.ok(cs.length > 0);
  for (const c of cs) assert.ok(c.href.startsWith('../') && !c.href.slice(3).includes('..'), c.href);
});

if (process.env.SKIP_SERVED) { console.log(`# ${n} passed (served check skipped)`); process.exit(0); }

// ---- served tree --------------------------------------------------------------------------------------------
const served = mkdtempSync(join(process.env.TEST_TMP || tmpdir(), 'served-'));
const server = createServer((req, res) => {
  const p = normalize(join(served, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  let f = p; if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html');
  if (!p.startsWith(served) || !existsSync(f)) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  res.end(readFileSync(f));
});
let browser;
try {
  mkdirSync(join(served, idx.hub.repo));
  writeFileSync(join(served, idx.hub.repo, 'index.html'), readFileSync(join(ROOT, 'index.html')));
  const repoDir = (repo) => (idx.repos[repo] && idx.repos[repo].dir) || repo;
  const { owner } = declared();
  // repos whose pinned tree could not be fetched (a private repo in CI without access) are not served-tree checked there
  const skipped = new Set();
  for (const repo of [...new Set(cs.map((c) => c.repo))]) {
    const cd = join(ROOT, '.cache', 'trees', repo);
    try { execFileSync('git', ['-C', cd, 'cat-file', '-e', `${idx.pins[repo]}^{tree}`], { stdio: 'ignore' }); } catch { skipped.add(repo); }
  }
  if (skipped.size) console.log(`# served-tree check skipped (tree not reachable here): ${[...skipped].join(', ')}`);
  for (const repo of [...new Set(cs.map((c) => c.repo))].filter((r) => !skipped.has(r))) { // one batched blob fetch per repo instead of one lazy fetch per file
    const cache = join(ROOT, '.cache', 'trees', repo);
    assert.ok(existsSync(cache), `no .cache for ${repo}: run node scripts/gen-index.mjs --scan`);
    const paths = cs.filter((c) => c.repo === repo).map((c) => c.path);
    const ids = execFileSync('git', ['-C', cache, 'ls-tree', idx.pins[repo], '--', ...paths], { encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => l.split(/\s+/)[2]);
    const missing = ids.filter((id) => { try { execFileSync('git', ['-C', cache, 'cat-file', '-e', id], { stdio: 'ignore', env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } }); return false; } catch { return true; } });
    const url = `https://github.com/${owner}/${(pub.find((e) => e.path === repo) || {}).repo}.git`;
    if (missing.length) execFileSync('git', ['-C', cache, '-c', 'fetch.negotiationAlgorithm=noop', 'fetch', '-q', '--no-write-fetch-head', '--filter=blob:none', url, ...missing]);
  }
  for (const c of cs.filter((x) => !skipped.has(x.repo))) {
    const cache = join(ROOT, '.cache', 'trees', c.repo);
    assert.ok(existsSync(cache), `no .cache for ${c.repo}: run node scripts/gen-index.mjs --scan`);
    const blob = execFileSync('git', ['-C', cache, 'cat-file', 'blob', `${idx.pins[c.repo]}:${c.path}`], { maxBuffer: 1 << 28 });
    const out = join(served, repoDir(c.repo), c.path);
    mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, blob);
  }
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/${idx.hub.repo}/index.html`;
  const { createRequire } = await import('node:module'); // resolves a global install too (NODE_PATH), which ESM import ignores
  const { chromium } = createRequire(import.meta.url)('playwright');
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(base);
  const hrefs = await page.$$eval('a.card', (as) => as.map((a) => a.href));
  ok('page renders every card', () => assert.equal(hrefs.length, cs.length));
  const bad = [];
  const skipDirs = [...skipped].map((r) => `/${repoDir(r)}/`);
  for (const h of hrefs.filter((h) => !skipDirs.some((d) => new URL(h).pathname.startsWith(d)))) { const r = await page.request.get(h); if (r.status() !== 200) bad.push(`${r.status()} ${h}`); }
  ok(`every card link resolves in the served tree (${hrefs.length})`, () => assert.deepEqual(bad, []));
  await page.fill('#q', 'galaxy');
  const vis = await page.$$eval('a.card:not(.hide)', (as) => as.length);
  ok('search filters', () => assert.ok(vis > 0 && vis < hrefs.length));
  await page.fill('#q', '');
  await page.click('a.card');
  ok('clicking a card opens its page', () => assert.ok(!page.url().endsWith(`/${idx.hub.repo}/index.html`)));
  if (process.env.SHOT) {
    await page.goto(base); await page.screenshot({ path: resolve(process.env.SHOT) });
    await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: resolve(process.env.SHOT).replace(/\.png$/, '-dark.png') });
    const m = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    await m.goto(base); await m.screenshot({ path: resolve(process.env.SHOT).replace(/\.png$/, '-mobile.png') });
  }
} finally {
  if (browser) await browser.close();
  server.close();
  rmSync(served, { recursive: true, force: true });
}
console.log(`# ${n} passed`);
