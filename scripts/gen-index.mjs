#!/usr/bin/env node
// Generate index.json (scan) and index.html (render): an icon grid of every HTML entry point of every public sub-repo.
//
//   node scripts/gen-index.mjs --scan     refresh index.json "entries" from the pinned gitlinks (git, no API, no checkout)
//   node scripts/gen-index.mjs            render index.html from index.json (offline, deterministic)
//   node scripts/gen-index.mjs --check    write nothing; exit 1 when index.html (or with --scan, index.json) would change
//
// Inputs: html-repos.json (declared repos, no_deploy = private), the gitlinks in HEAD (pinned SHAs), pages.json (live
// GitHub Pages URLs) and the hand-kept parts of index.json (hub, groups, repos, overrides, exclude) which --scan keeps.
// Scan: per public repo, a blobless depth-1 fetch of the pinned SHA into .cache/trees/<path> and `git ls-tree`;
// only trees are downloaded, so the 500 MB site repo costs a few MB. Private repos (no_deploy) are never fetched.
// Links are relative to the served root = the parent git/ folder: ../<dir>/<path> with <dir> = the repo's folder there.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = process.env.INDEX_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
const git = (args, opt = {}) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opt });

// ---- entry-point rule -----------------------------------------------------------------------------------------
const SKIP = new Set(['node_modules', 'src', 'static', 'test', 'tests', 'fixtures', '__tests__', '_shared', 'templates',
  'partials', 'vendor', 'coverage', '.github', 'e2e', 'snapshots']);
export function isEntry(p) {
  if (!p.endsWith('.html')) return false;
  const seg = p.split('/');
  if (seg.some((s) => SKIP.has(s) || s.startsWith('.'))) return false;
  return seg.length === 1 || seg[seg.length - 1] === 'index.html';
}
// X/index.html and X/dist/index.html are the same app: keep dist (the built page). A page below another entry
// (other than the repo root, which is the repo's own landing page) is a sub-page of that app, not an entry point,
// unless a hand `include` regex (on <path>) keeps it.
export function pickEntries(paths, include = []) {
  const key = (p) => p.replace(/(^|\/)dist\//, '$1');
  const by = new Map();
  for (const p of paths.filter(isEntry).sort()) {
    const k = key(p);
    const cur = by.get(k);
    if (!cur || (/(^|\/)dist\//.test(p) && !/(^|\/)dist\//.test(cur))) by.set(k, p);
  }
  const picked = [...by.values()].sort();
  const appDir = (p) => p.replace(/(^|\/)dist\/index\.html$|(^|\/)index\.html$/, '').replace(/\/dist$/, '');
  const dirs = new Set(picked.map(appDir).filter((d) => d && !d.endsWith('.html')));
  return picked.filter((p) => {
    if (include.some((r) => r.test(p))) return true;
    const segs = appDir(p).split('/');
    for (let i = 1; i < segs.length; i++) if (dirs.has(segs.slice(0, i).join('/'))) return false;
    return true;
  });
}

// ---- declaration --------------------------------------------------------------------------------------------
export function declared() {
  const d = rd('html-repos.json');
  const all = [...d.base, ...d.repos.map((r) => ({ path: r, repo: r }))];
  const priv = new Set(Object.keys(d.no_deploy || {}));
  return { owner: d.owner, all, pub: all.filter((e) => !priv.has(e.repo)), priv };
}
function pinned() {
  const out = git(['-C', ROOT, 'ls-tree', 'HEAD']);
  return Object.fromEntries(out.split('\n').filter((l) => l.includes(' commit ')).map((l) => [l.split('\t')[1], l.split(/\s+/)[2]]));
}

function scanRepo(owner, e, sha) {
  const dir = join(ROOT, '.cache', 'trees', e.path);
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); git(['init', '-q', '--bare', dir]); }
  try { git(['-C', dir, 'cat-file', '-e', `${sha}^{tree}`], { stdio: 'ignore' }); }
  catch { git(['-C', dir, 'fetch', '-q', '--depth', '1', '--filter=blob:none', `https://github.com/${owner}/${e.repo}.git`, sha]); }
  return git(['-C', dir, 'ls-tree', '-r', '--name-only', sha]).split('\n').filter(Boolean);
}

export function scan(idx) {
  const { owner, pub } = declared();
  const pins = pinned();
  const exclude = (idx.exclude || []).map((x) => new RegExp(x));
  const include = (idx.include || []).map((x) => new RegExp(x));
  const entries = [];
  for (const e of pub) {
    const sha = pins[e.path];
    if (!sha) continue;
    for (const p of pickEntries(scanRepo(owner, e, sha), include)) {
      if (!exclude.some((r) => r.test(`${e.path}/${p}`))) entries.push({ repo: e.path, path: p });
    }
    idx.pins = { ...(idx.pins || {}), [e.path]: sha };
  }
  idx.pins = Object.fromEntries(Object.entries(idx.pins).sort());
  idx.entries = entries;
  return idx;
}

// ---- render -------------------------------------------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NOISE = new Set(['dist', 'index.html', 'build', 'out', 'www', 'public', 'site', 'docs']);
export function titleOf(path, repoTitle) {
  const seg = path.split('/').filter((s) => !NOISE.has(s));
  const last = seg.length ? seg[seg.length - 1].replace(/\.html$/, '') : repoTitle;
  return last.replace(/^[a-z0-9]_(?=[A-Za-z])/, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim() || repoTitle;
}
const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;

export function cards(idx) {
  const { priv } = declared();
  const groups = idx.groups;
  const groupOf = (repo) => (idx.repos[repo] && idx.repos[repo].group) || (groups.find((g) => (g.match || []).some((m) => repo.startsWith(m))) || groups[groups.length - 1]).id;
  const out = [];
  for (const en of idx.entries) {
    if (priv.has(en.repo) || (idx.repos[en.repo] && idx.repos[en.repo].private)) continue;
    const r = idx.repos[en.repo] || {};
    const o = (idx.overrides || {})[`${en.repo}/${en.path}`] || {};
    if (o.hidden) continue;
    const dir = r.dir || en.repo;
    out.push({
      group: o.group || groupOf(en.repo), repo: en.repo, path: en.path,
      title: o.title || titleOf(en.path, r.title || en.repo), icon: o.icon || r.icon || '',
      description: o.description || '', href: `../${dir}/${en.path}`,
    });
  }
  const order = (g) => groups.findIndex((x) => x.id === g);
  return out.sort((a, b) => order(a.group) - order(b.group) || a.repo.localeCompare(b.repo) || a.path.localeCompare(b.path));
}

export function render(idx) {
  const cs = cards(idx);
  const pages = Object.fromEntries((rd('pages.json').pages || []).map((p) => [p.repo, p.url]));
  const groupHtml = idx.groups.map((g) => {
    const mine = cs.filter((c) => c.group === g.id);
    if (!mine.length) return '';
    const repos = [...new Set(mine.map((c) => c.repo))];
    const repoHtml = repos.map((repo) => {
      const r = idx.repos[repo] || {};
      const live = pages[repo] ? ` <a class="live" href="${esc(pages[repo])}" rel="noopener">live</a>` : '';
      const items = mine.filter((c) => c.repo === repo).map((c) => {
        const mono = c.icon || esc(c.title.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || '#');
        const text = `${c.title} ${c.repo} ${c.path} ${c.description}`.toLowerCase();
        return `<a class="card" href="${esc(c.href)}" data-g="${esc(c.group)}" data-q="${esc(text)}" title="${esc(c.repo + '/' + c.path)}">`
          + `<span class="ico" style="--h:${hue(c.repo + c.title)}">${c.icon ? esc(c.icon) : mono}</span>`
          + `<span class="tx"><b>${esc(c.title)}</b><small>${esc(c.path)}</small>${c.description ? `<i>${esc(c.description)}</i>` : ''}</span></a>`;
      }).join('\n');
      return `<section class="repo" data-repo="${esc(repo)}"><h3>${r.icon ? esc(r.icon) + ' ' : ''}${esc(r.title || repo)} <code>${esc(repo)}</code>${live}<span class="n">${mine.filter((c) => c.repo === repo).length}</span></h3>`
        + (r.description ? `<p>${esc(r.description)}</p>` : '') + `<div class="grid">\n${items}\n</div></section>`;
    }).join('\n');
    return `<section class="group" id="g-${esc(g.id)}" data-g="${esc(g.id)}"><h2>${esc(g.icon || '')} ${esc(g.title)} <span class="n">${mine.length}</span></h2>\n${repoHtml}\n</section>`;
  }).join('\n');
  const chips = idx.groups.filter((g) => cs.some((c) => c.group === g.id))
    .map((g) => `<button class="chip" data-f="${esc(g.id)}">${esc(g.icon || '')} ${esc(g.title)}</button>`).join('');
  return `<!doctype html>
<!-- GENERATED FILE: DO NOT EDIT. node scripts/gen-index.mjs renders it from index.json. -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(idx.hub.title)}</title><meta name="description" content="${esc(idx.hub.description)}">
<style>
:root{--bg:#f6f7f9;--fg:#15181d;--mut:#5d6573;--card:#fff;--line:#e2e5ea;--acc:#2f6fed;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1115;--fg:#e7e9ee;--mut:#9aa3b2;--card:#181b21;--line:#2a2f38;--acc:#6ea0ff;color-scheme:dark}}
:root[data-theme=dark]{--bg:#0f1115;--fg:#e7e9ee;--mut:#9aa3b2;--card:#181b21;--line:#2a2f38;--acc:#6ea0ff;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
header h1{font-size:16px;margin:0 8px 0 0}header .meta{color:var(--mut);font-size:12px}
#q{flex:1 1 220px;min-width:0;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit}
.chips{display:flex;flex-wrap:wrap;gap:6px;width:100%}.chip,#theme{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer}
.chip[aria-pressed=true]{background:var(--acc);border-color:var(--acc);color:#fff}
main{padding:8px 16px 40px;max-width:1500px;margin:0 auto}
h2{font-size:15px;margin:18px 0 6px}h3{font-size:13px;margin:12px 0 6px;color:var(--mut);font-weight:600;display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}
h3 code{font-size:11px;opacity:.8}.n{font-size:11px;color:var(--mut);font-weight:400;margin-left:auto}h2 .n{margin-left:6px}
.repo>p{margin:0 0 6px;color:var(--mut);font-size:12px}.live{font-size:11px;color:var(--acc)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:6px}
.card{display:flex;gap:8px;align-items:center;padding:7px;border:1px solid var(--line);border-radius:9px;background:var(--card);color:inherit;text-decoration:none;min-width:0}
.card:hover,.card:focus-visible{border-color:var(--acc);outline:none}
.ico{flex:none;width:32px;height:32px;border-radius:8px;display:grid;place-items:center;font-weight:700;font-size:13px;color:#fff;background:hsl(var(--h) 55% 46%)}
.tx{min-width:0;display:flex;flex-direction:column}.tx b{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tx small,.tx i{font-size:11px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-style:normal}
.hide{display:none!important}#empty{color:var(--mut);padding:20px 0}
@media (max-width:520px){.grid{grid-template-columns:1fr 1fr}.tx small{display:none}}
</style></head><body>
<header><h1>${esc(idx.hub.title)}</h1><span class="meta"><span id="count">${cs.length}</span> pages</span>
<input id="q" type="search" placeholder="Search title, repo, path (/)" aria-label="Search">
<button id="theme" type="button" aria-label="Toggle theme">theme</button>
<div class="chips"><button class="chip" data-f="" aria-pressed="true">All</button>${chips}</div></header>
<main>
${groupHtml}
<p id="empty" class="hide">No page matches.</p>
</main>
<script>
(function(){var q=document.getElementById('q'),f='',cards=[].slice.call(document.querySelectorAll('.card'));
function run(){var t=q.value.trim().toLowerCase().split(/\\s+/).filter(Boolean),n=0;
cards.forEach(function(c){var ok=(!f||c.dataset.g===f)&&t.every(function(w){return c.dataset.q.indexOf(w)>=0});c.classList.toggle('hide',!ok);if(ok)n++});
document.querySelectorAll('.repo,.group').forEach(function(s){s.classList.toggle('hide',!s.querySelector('.card:not(.hide)'))});
document.getElementById('count').textContent=n;document.getElementById('empty').classList.toggle('hide',n>0)}
q.addEventListener('input',run);
document.querySelectorAll('.chip').forEach(function(b){b.addEventListener('click',function(){f=b.dataset.f;document.querySelectorAll('.chip').forEach(function(x){x.setAttribute('aria-pressed',x===b)});run()})});
document.addEventListener('keydown',function(e){if(e.key==='/'&&document.activeElement!==q){e.preventDefault();q.focus()}});
var r=document.documentElement;try{var s=localStorage.getItem('theme');if(s)r.dataset.theme=s}catch(e){}
document.getElementById('theme').addEventListener('click',function(){var d=r.dataset.theme?r.dataset.theme==='dark':matchMedia('(prefers-color-scheme: dark)').matches;r.dataset.theme=d?'light':'dark';try{localStorage.setItem('theme',r.dataset.theme)}catch(e){}});
})();
</script>
</body></html>
`;
}

// ---- main ---------------------------------------------------------------------------------------------------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const idxFile = join(ROOT, 'index.json');
  const before = readFileSync(idxFile, 'utf8');
  let idx = JSON.parse(before);
  let bad = 0;
  if (process.argv.includes('--scan')) {
    idx = scan(idx);
    const txt = JSON.stringify(idx, null, 2) + '\n';
    if (check) { if (txt !== before) { console.error('index.json is stale: run node scripts/gen-index.mjs --scan'); bad = 1; } }
    else writeFileSync(idxFile, txt);
  }
  const html = render(idx);
  const htmlFile = join(ROOT, 'index.html');
  if (check) { if ((existsSync(htmlFile) ? readFileSync(htmlFile, 'utf8') : '') !== html) { console.error('index.html is stale: run node scripts/gen-index.mjs'); bad = 1; } }
  else writeFileSync(htmlFile, html);
  console.log(`${check ? 'checked' : 'wrote'} index.html (${cards(idx).length} cards from ${idx.entries.length} entries)`);
  process.exit(bad);
}
