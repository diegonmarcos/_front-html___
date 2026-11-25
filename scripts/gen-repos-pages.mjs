#!/usr/bin/env node
// Generate repos-pages.json: ONE entry per html repo with its folder (submodule path), GitHub URL, own GitHub Pages URL
// (pages.json), custom domain (CNAME files) and every *.diegonmarcos.com page that serves it.
//
// Sources (nothing typed here):
//   html-repos.json                        the declared html repos + their submodule folders
//   git-repos-master/A0_repos-tree/src/kinds.json   the SoT's kind html set (flag sot_html)
//   pages.json                             repos that publish GitHub Pages themselves (GitHub API)
//   .gitmodules gitlinks                   alias_of: two folders pinned to the same commit are the same repo (renamed)
//   repos-pages.scan.json                  committed scan cache (node scripts/gen-repos-pages.mjs --scan, needs `gh`):
//        tree dirs + CNAME files of each public repo; deploy map of diegonmarcos.github.io ship.yml (PROJECTS "src:name",
//        source dir -> published folder); host routes of the fleet Caddyfile (cloudy-u-containers infra-sec_caddy,
//        *.diegonmarcos.com host -> diegonmarcos.github.io/<folder>/)
// A repo is a source of a deploy folder when it holds the PROJECTS source dir (<top>/<sub>). Every Caddy host routed to
// that folder is a domain page of the repo; diegonmarcos.github.io, the Pages site everything is overlaid into, lists them all.
//
//   node scripts/gen-repos-pages.mjs --scan    refresh the cache from GitHub (gh), then write
//   node scripts/gen-repos-pages.mjs           offline: cache + SoTs -> repos-pages.json
//   node scripts/gen-repos-pages.mjs --check   write nothing; exit 1 when repos-pages.json differs
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
const OWNER = 'diegonmarcos', SITE = 'diegonmarcos.github.io', GH = process.env.GH || 'gh';
const SCAN = 'repos-pages.scan.json', OUT = 'repos-pages.json';
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const gh = (args) => execFileSync(GH, ['api', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
const raw = (repo, path) => gh([`repos/${OWNER}/${repo}/contents/${path}`, '-H', 'Accept: application/vnd.github.raw']);

// ---- parsers (pure, exported for the tests) ----
export function parseProjects(shipYml) { // PROJECTS=( "src:name" ... )
  const m = shipYml.match(/PROJECTS=\(([\s\S]*?)\n\s*\)/); const out = [];
  for (const l of (m ? m[1] : '').split('\n')) { const e = l.match(/^\s*"([^":]+):([^":]+)"/); if (e) out.push({ src: e[1], name: e[2] }); }
  return out;
}
export function parseRoutes(caddyfile) { // host -> published folder of the Pages site
  const routes = {}; let host = [];
  for (const l of caddyfile.split('\n')) {
    const h = l.match(/^\s*((?:[\w-]+\.)+diegonmarcos\.com(?:\s*,\s*(?:[\w-]+\.)+diegonmarcos\.com)*)\s*\{\s*$/);
    if (h) { host = h[1].split(/\s*,\s*/); continue; }
    const r = l.match(/^\s*rewrite \* \/([^/{\s]+)[^\s]*\{uri\}/) || l.match(/redir https:\/\/diegonmarcos\.github\.io\/([^/\s?]+)/);
    if (r && host.length) for (const x of host) (routes[x] ||= new Set()).add(r[1]);
  }
  return Object.fromEntries(Object.entries(routes).sort(([a], [b]) => cmp(a, b)).map(([k, v]) => [k, [...v].sort()]));
}

// ---- inputs ----
const decl = rd('html-repos.json');
export const ghName = (n) => (decl.renamed_on_github || {})[n] || n;
export const folders = () => [...decl.base.map((b) => [b.repo, b.path]), ...decl.repos.map((r) => [r, r])];
const kinds = () => rd('git-repos-master/A0_repos-tree/src/kinds.json').repos;
export const sotHtml = () => Object.entries(kinds()).filter(([, v]) => v.html).map(([n]) => n).sort(cmp);
const gitlinks = () => Object.fromEntries(execFileSync('git', ['-C', ROOT, 'ls-files', '--stage'], { encoding: 'utf8' }).split('\n')
  .filter((l) => l.startsWith('160000')).map((l) => { const [, sha, , p] = l.split(/\s+/); return [p, sha]; }));

function scan() {
  const repos = {};
  for (const [name] of folders()) {
    if (name in (decl.no_deploy || {})) continue;
    try {
      const g = ghName(name);
      const tree = JSON.parse(gh([`repos/${OWNER}/${g}/git/trees/HEAD?recursive=1`])).tree;
      const dirs = tree.filter((t) => t.type === 'tree' && !/node_modules|(^|\/)\./.test(t.path) && t.path.split('/').length <= 2).map((t) => t.path).sort(cmp);
      const cnames = {};
      for (const t of tree) if (t.type === 'blob' && /(^|\/)CNAME$/.test(t.path) && !/node_modules/.test(t.path)) cnames[t.path] = raw(g, t.path).trim();
      repos[name] = { dirs, cnames };
    } catch (e) { repos[name] = { error: 'unreadable (renamed or private)' }; }
  }
  const projects = parseProjects(raw(SITE, '.github/workflows/ship.yml'));
  const routes = parseRoutes(raw('cloudy-u-containers', 'infra-sec_caddy/dist/configs/Caddyfile'));
  return { _doc: 'GENERATED by scripts/gen-repos-pages.mjs --scan from the GitHub API. DO NOT EDIT.', repos, projects, routes };
}

export function build() {
  const sc = rd(SCAN), pages = Object.fromEntries(rd('pages.json').pages.map((p) => [p.repo, p.url]));
  const sot = new Set(sotHtml()), links = gitlinks(), noDeploy = decl.no_deploy || {};
  const sha = (p) => links[p];
  const entries = folders().map(([name, folder]) => {
    const g = ghName(name), s = sc.repos[name] || {}, priv = name in noDeploy;
    const own = (s.dirs || []);
    const deploys = priv ? [] : sc.projects.filter((p) => p.name !== '.' && p.src.split('/').length === 2 && own.includes(p.src)).map((p) => ({ source: p.src, folder: p.name, url: `https://${SITE}/${p.name}/` }));
    const hosts = new Set();
    for (const [h, fs] of Object.entries(sc.routes)) if (name === SITE || deploys.some((d) => fs.includes(d.folder))) hosts.add(h);
    const cn = Object.entries(s.cnames || {}).map(([path, domain]) => ({ path, domain })).sort((a, b) => cmp(a.path, b.path));
    for (const c of cn) if (c.domain.endsWith('.diegonmarcos.com')) hosts.add(c.domain);
    const alias = Object.keys(links).find((p) => p !== folder && sha(p) === sha(folder) && !folders().some(([, f]) => f === p && f === name));
    return {
      name, folder, sot_html: sot.has(name), private: priv,
      github: `https://github.com/${OWNER}/${g}`,
      ...(g !== name ? { github_name: g } : {}),
      pages_url: pages[g] ?? null,
      custom_domain: cn.length ? cn[0].domain : null,
      cnames: cn,
      overlay_pages: deploys,
      domain_pages: [...hosts].sort(cmp).map((h) => `https://${h}/`),
      ...(s.error ? { scan_error: s.error } : {}),
      ...(alias ? { same_commit_as: alias } : {}),
    };
  });
  // the hub itself is an html repo of the SoT but not one of its own submodules
  for (const n of sotHtml()) if (!entries.some((e) => e.name === n)) entries.push({ name: n, folder: '.', sot_html: true, private: false, github: `https://github.com/${OWNER}/${n}`, pages_url: pages[n] ?? null, custom_domain: null, cnames: [], overlay_pages: [], domain_pages: [] });
  entries.sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()));
  return { _doc: 'GENERATED by scripts/gen-repos-pages.mjs from html-repos.json, git-repos-master kinds.json, pages.json and repos-pages.scan.json. DO NOT EDIT.', owner: OWNER, count: entries.length, repos: entries };
}

const argv = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (argv.includes('--scan')) writeFileSync(join(ROOT, SCAN), JSON.stringify(scan(), null, 2) + '\n');
  const text = JSON.stringify(build(), null, 2) + '\n';
  if (argv.includes('--check')) {
    if ((existsSync(join(ROOT, OUT)) ? readFileSync(join(ROOT, OUT), 'utf8') : '') !== text) { console.error(`${OUT} drifted: run node scripts/gen-repos-pages.mjs and commit`); process.exit(1); }
    console.log(`${OUT} up to date`);
  } else { writeFileSync(join(ROOT, OUT), text); console.log(`wrote ${OUT}`); }
}
