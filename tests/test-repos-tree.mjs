#!/usr/bin/env node
// Tests for 00_repos-tree/: data comes from the git-repos-master submodule (no separate list), filtered to kind html;
// outputs equal a fresh render; the hub's declared html repos agree with the master's classification.
//   node tests/test-repos-tree.mjs   (needs the submodule: git submodule update --init git-repos-master)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`ok ${n} ${name}`); };
const flat = (t) => { const a = []; (function w(o) { if (o.node !== 'group') a.push(o); (o.children || []).forEach(w); })(t); return a; };

const cfg = rd('00_repos-tree/src/filter.json');
const master = flat(rd(cfg.source).tree), mine = flat(rd('00_repos-tree/dist/repos-tree.json').tree);
const decl = rd('html-repos.json');

ok('layout: src/, dist/ and the same outputs at the root', () => {
  assert.ok(existsSync(join(ROOT, '00_repos-tree/src/filter.json')));
  for (const e of ['json', 'md', 'html', 'xml', 'canvas']) for (const f of [`00_repos-tree/dist/repos-tree.${e}`, `repos-tree.${e}`]) assert.ok(existsSync(join(ROOT, f)), `${f} missing`);
});
ok('no separate list: the source is the git-repos-master submodule', () => {
  assert.ok(cfg.source.startsWith('git-repos-master/'));
  assert.ok(decl.sources.some((s) => s.path === 'git-repos-master'));
  assert.match(readFileSync(join(ROOT, '.gitmodules'), 'utf8'), /\[submodule "git-repos-master"\]/);
  assert.ok(execFileSync('git', ['-C', ROOT, 'ls-files', '--stage', 'git-repos-master'], { encoding: 'utf8' }).startsWith('160000'), 'git-repos-master is not a gitlink');
});
ok('every html repo of the master is here, and every repo here is an html repo or its ancestor hub', () => {
  const want = master.filter((o) => o.html_repo).map((o) => o.name).sort();
  assert.ok(want.length > 10);
  const have = mine.filter((o) => o.html_repo).map((o) => o.name).sort();
  assert.deepEqual(have, want);
  for (const o of mine.filter((x) => !x.html_repo)) assert.equal(o.node, 'hub', `${o.name} is neither html nor a hub`);
  for (const o of mine) assert.equal(o.kind, master.find((m) => m.name === o.name).kind, `${o.name} kind differs from the master`);
});
ok('the declared html repos (html-repos.json) are classified html by the master', () => {
  const byName = Object.fromEntries(master.map((o) => [o.name, o]));
  const missing = [...decl.base.map((b) => b.repo), ...decl.repos].filter((r) => byName[r] && !byName[r].html_repo);
  assert.deepEqual(missing, []);
});
ok('outputs equal a fresh render (drift guard)', () => {
  execFileSync('node', [join(ROOT, 'scripts/gen-repos-tree.mjs'), '--check'], { stdio: 'pipe' });
});
console.log(`all ${n} ok`);
