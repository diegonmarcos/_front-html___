#!/usr/bin/env node
// Every html repo of the SoT (git-repos-master kinds.json, kind html) must be on every surface of the hub:
// .gitmodules, html-repos.json, gitlink, pages (repos-pages.json, + pages.json when it publishes Pages), index.json pins,
// index.html, repos-tree.json, 00_repos-tree/dist. Mutation: removing one repo from each surface in memory turns the check red.
//   node tests/test-repos-pages.mjs   (needs the git-repos-master submodule)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, build, folders, sotHtml } from '../scripts/gen-repos-pages.mjs';

const txt = (f) => readFileSync(join(ROOT, f), 'utf8');
const flat = (t) => { const a = []; (function w(o) { if (o.node !== 'group') a.push(o.name); (o.children || []).forEach(w); })(t); return a; };
const load = () => ({
  gitmodules: txt('.gitmodules'),
  declared: JSON.parse(txt('html-repos.json')),
  gitlinks: execFileSync('git', ['-C', ROOT, 'ls-files', '--stage'], { encoding: 'utf8' }).split('\n').filter((l) => l.startsWith('160000')).map((l) => l.split('\t')[1]),
  pages: JSON.parse(txt('pages.json')).pages.map((p) => p.repo),
  repoPages: JSON.parse(txt('repos-pages.json')).repos,
  pins: Object.keys(JSON.parse(txt('index.json')).pins),
  indexHtml: txt('index.html'),
  tree: flat(JSON.parse(txt('repos-tree.json')).tree),
  treeDist: flat(JSON.parse(txt('00_repos-tree/dist/repos-tree.json')).tree),
});
// returns ["<repo> x <surface>", ...] for every SoT html repo absent from a surface
export function missing(d, sot) {
  const out = [], priv = Object.keys(d.declared.no_deploy || {});
  const folderOf = (n) => (d.declared.base.find((b) => b.repo === n) || {}).path || n;
  for (const n of sot) {
    const f = folderOf(n), hub = n === '_front-html___'; // the hub itself is not one of its own submodules
    const miss = (s) => out.push(`${n} x ${s}`);
    if (!hub) {
      if (!d.gitmodules.includes(`path = ${f}\n`)) miss('.gitmodules');
      if (!(d.declared.repos.includes(n) || d.declared.base.some((b) => b.repo === n))) miss('html-repos.json');
      if (!d.gitlinks.includes(f)) miss('gitlink');
      if (!d.pins.includes(f)) miss('index.json');
      if (!d.indexHtml.includes(f)) miss('index.html');
    }
    if (!d.repoPages.some((r) => r.name === n)) miss('repos-pages.json');
    if (!d.tree.includes(n)) miss('repos-tree.json');
    if (!d.treeDist.includes(n)) miss('00_repos-tree/dist');
  }
  // pages.json lists only repos that publish GitHub Pages: each must carry its URL in repos-pages.json
  for (const n of d.pages) { const r = d.repoPages.find((x) => (x.github_name || x.name) === n); if (!r || !r.pages_url) out.push(`${n} x repos-pages.json pages_url`); }
  return out;
}

let n = 0; const ok = (name, fn) => { fn(); n++; console.log(`ok ${n} ${name}`); };
const sot = sotHtml(), d = load();
ok('the SoT has html repos including the reported prf-prs', () => { assert.ok(sot.length >= 15); assert.ok(sot.includes('cloud-me-pub-profiles-prf-prs')); });
ok('no SoT html repo is missing from any surface', () => assert.deepEqual(missing(d, sot), []));
ok('repos-pages.json equals a fresh render (no drift)', () => assert.deepEqual(JSON.parse(txt('repos-pages.json')), build()));
ok('every declared repo has a repos-pages.json entry with name, folder, github, pages_url, domain_pages', () => {
  for (const [name, folder] of folders()) {
    const r = d.repoPages.find((x) => x.name === name); assert.ok(r, name); assert.equal(r.folder, folder);
    assert.equal(r.github, `https://github.com/diegonmarcos/${r.github_name || name}`); assert.ok('pages_url' in r && Array.isArray(r.domain_pages) && 'custom_domain' in r);
  }
});
ok('prf-prs is served: overlay pages and a domain page', () => {
  const r = d.repoPages.find((x) => x.name === 'cloud-me-pub-profiles-prf-prs');
  assert.ok(r.overlay_pages.length > 0); assert.ok(r.domain_pages.every((u) => /^https:\/\/[\w.-]+\.diegonmarcos\.com\/$/.test(u)));
});
ok('private repos publish nothing', () => { for (const p of Object.keys(d.declared.no_deploy)) { const r = d.repoPages.find((x) => x.name === p); assert.equal(r.pages_url, null); assert.deepEqual(r.domain_pages, []); } });

// mutation: drop prf-prs from each surface in turn; the check must go red naming that surface
const T = 'cloud-me-pub-profiles-prf-prs';
const strip = (a) => a.filter((x) => x !== T), cl = () => structuredClone(d);
const mutations = {
  '.gitmodules': (m) => { m.gitmodules = m.gitmodules.replace(`path = ${T}\n`, ''); },
  'html-repos.json': (m) => { m.declared.repos = strip(m.declared.repos); },
  gitlink: (m) => { m.gitlinks = strip(m.gitlinks); },
  'index.json': (m) => { m.pins = strip(m.pins); },
  'index.html': (m) => { m.indexHtml = m.indexHtml.replaceAll(T, 'x'); },
  'repos-tree.json': (m) => { m.tree = strip(m.tree); },
  '00_repos-tree/dist': (m) => { m.treeDist = strip(m.treeDist); },
  'repos-pages.json': (m) => { m.repoPages = m.repoPages.filter((r) => r.name !== T); },
};
for (const [surface, mut] of Object.entries(mutations)) ok(`mutation: ${T} removed from ${surface} turns the check red`, () => {
  const m = cl(); mut(m); const got = missing(m, sot);
  assert.ok(got.some((g) => g.startsWith(`${T} x ${surface}`)), `not red for ${surface}: ${got}`);
});
ok('mutation: a pages.json repo without pages_url turns the check red', () => {
  const m = cl(); m.pages = [...m.pages, 'CG-circus']; assert.ok(missing(m, sot).some((g) => g.includes('pages_url')));
});
