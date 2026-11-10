// API reference generator and JSDoc validator for sdk/js/hawkes-net.mjs and sdk/js/hawkes-net-core.mjs.
// Used by tools/build.mjs (writes public/api.html and dist/docs/api.html), src/hub.ts (serves /docs/api), and test/api-docs.test.ts.
import fs from 'node:fs';
import { ERROR_CODES } from './errors.ts';

export interface ApiDocEntry {
  id: string;
  kind: 'export' | 'method' | 'option' | 'event';
  name: string;
  module: '@hawkesgen/net' | '@hawkesgen/net/core';
  signature: string;
  description: string;
  example: string;
  errorCodes: string[];
}

export interface ApiDocsCatalog {
  exports: ApiDocEntry[];
  methods: ApiDocEntry[];
  options: ApiDocEntry[];
  events: ApiDocEntry[];
  all: ApiDocEntry[];
}

export interface JsdocValidation {
  ok: boolean;
  errors: string[];
  catalog: ApiDocsCatalog;
}

const NET_PATH = new URL('../sdk/js/hawkes-net.mjs', import.meta.url);
const CORE_PATH = new URL('../sdk/js/hawkes-net-core.mjs', import.meta.url);
const KNOWN_ERROR_CODES = new Set<string>(ERROR_CODES);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();

interface ParsedBlock {
  raw: string;
  start: number;
  end: number;
  description: string;
  sig: string;
  example: string;
  method?: string;
  option?: string;
  event?: string;
}

function parseBlock(commentBody: string, start: number, end: number): ParsedBlock {
  const lines = commentBody
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .filter((l) => l.length > 0);
  const descLines: string[] = [];
  let sig = '';
  const exLines: string[] = [];
  let method: string | undefined;
  let option: string | undefined;
  let event: string | undefined;
  let mode: 'desc' | 'example' | 'tag' = 'desc';

  for (const line of lines) {
    if (line.startsWith('@sig ')) {
      sig = line.slice(5).trim();
      mode = 'tag';
    } else if (line.startsWith('@example')) {
      const rest = line.slice(8).trim();
      if (rest) exLines.push(rest);
      mode = 'example';
    } else if (line.startsWith('@method ')) {
      method = line.slice(8).trim();
      mode = 'tag';
    } else if (line.startsWith('@option ')) {
      option = line.slice(8).trim();
      mode = 'tag';
    } else if (line.startsWith('@event ')) {
      event = line.slice(7).trim();
      mode = 'tag';
    } else if (line.startsWith('@')) {
      mode = 'tag';
    } else if (mode === 'example') {
      exLines.push(line);
    } else if (mode === 'desc') {
      descLines.push(line);
    }
  }

  return {
    raw: commentBody,
    start,
    end,
    description: descLines.join(' ').trim(),
    sig,
    example: exLines.join('\n').trim(),
    method,
    option,
    event,
  };
}

function extractBlocks(src: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const re = /\/\*\*([\s\S]*?)\*\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    blocks.push(parseBlock(m[1], m.index, m.index + m[0].length));
  }
  return blocks;
}

function findCodesInText(text: string): string[] {
  const found: string[] = [];
  const re = /\b([a-z][a-z0-9_]+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const code = m[1];
    if (KNOWN_ERROR_CODES.has(code) && !found.includes(code)) found.push(code);
  }
  return found;
}

interface ExportDecl {
  name: string;
  index: number;
  line: number;
}

function findExportDecls(src: string): ExportDecl[] {
  const out: ExportDecl[] = [];
  const re = /^[ \t]*export\s+(?:default\b|(?:async\s+)?function\s+([A-Za-z0-9_$]+)|(?:const|let|var|class)\s+([A-Za-z0-9_$]+))/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1] || m[2] || 'default';
    const line = src.slice(0, m.index).split(/\r?\n/).length;
    out.push({ name, index: m.index, line });
  }
  return out;
}

function findEmittedEvents(src: string): string[] {
  const seen = new Set<string>();
  const re = /\.ev\.emit\(\s*'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    seen.add(m[1]);
  }
  return [...seen];
}

export function validateSdkJsdoc(netSrc?: string, coreSrc?: string): JsdocValidation {
  const net = netSrc ?? fs.readFileSync(NET_PATH, 'utf8');
  const core = coreSrc ?? fs.readFileSync(CORE_PATH, 'utf8');
  const errors: string[] = [];

  const exportsList: ApiDocEntry[] = [];
  const methodsList: ApiDocEntry[] = [];
  const optionsList: ApiDocEntry[] = [];
  const eventsList: ApiDocEntry[] = [];

  const files: { label: string; mod: '@hawkesgen/net' | '@hawkesgen/net/core'; modSlug: string; src: string }[] = [
    { label: 'sdk/js/hawkes-net.mjs', mod: '@hawkesgen/net', modSlug: 'net', src: net },
    { label: 'sdk/js/hawkes-net-core.mjs', mod: '@hawkesgen/net/core', modSlug: 'core', src: core },
  ];

  for (const f of files) {
    const blocks = extractBlocks(f.src);
    const decls = findExportDecls(f.src);
    if (!decls.length) errors.push(`${f.label}: no exports found`);

    for (const d of decls) {
      // Find the JSDoc block immediately preceding this export (only whitespace allowed between block.end and d.index).
      const prev = [...blocks].reverse().find((b) => b.end <= d.index && !b.method && !b.option && !b.event);
      const between = prev ? f.src.slice(prev.end, d.index) : '';
      if (!prev || !/^\s*$/.test(between)) {
        errors.push(`${f.label}:${d.line}: export "${d.name}" has no JSDoc`);
        continue;
      }
      if (!prev.description) errors.push(`${f.label}:${d.line}: export "${d.name}" JSDoc is missing a description`);
      if (!prev.sig) errors.push(`${f.label}:${d.line}: export "${d.name}" JSDoc is missing @sig`);
      if (!prev.example) errors.push(`${f.label}:${d.line}: export "${d.name}" JSDoc is missing @example`);
      exportsList.push({
        id: `export-${f.modSlug}-${slug(d.name)}`,
        kind: 'export',
        name: d.name,
        module: f.mod,
        signature: prev.sig,
        description: prev.description,
        example: prev.example,
        errorCodes: findCodesInText(`${prev.description} ${prev.sig}`),
      });
    }

    for (const b of blocks) {
      if (b.method) {
        if (!b.description) errors.push(`${f.label}: @method "${b.method}" is missing a description`);
        if (!b.sig) errors.push(`${f.label}: @method "${b.method}" is missing @sig`);
        if (!b.example) errors.push(`${f.label}: @method "${b.method}" is missing @example`);
        methodsList.push({
          id: `method-${slug(b.method)}`,
          kind: 'method',
          name: b.method,
          module: f.mod,
          signature: b.sig,
          description: b.description,
          example: b.example,
          errorCodes: findCodesInText(`${b.description} ${b.sig}`),
        });
      }
      if (b.option) {
        if (!b.description) errors.push(`${f.label}: @option "${b.option}" is missing a description`);
        if (!b.sig) errors.push(`${f.label}: @option "${b.option}" is missing @sig`);
        if (!b.example) errors.push(`${f.label}: @option "${b.option}" is missing @example`);
        optionsList.push({
          id: `option-${slug(b.option)}`,
          kind: 'option',
          name: b.option,
          module: f.mod,
          signature: b.sig,
          description: b.description,
          example: b.example,
          errorCodes: findCodesInText(`${b.description} ${b.sig}`),
        });
      }
      if (b.event) {
        if (!b.description) errors.push(`${f.label}: @event "${b.event}" is missing a description`);
        if (!b.sig) errors.push(`${f.label}: @event "${b.event}" is missing @sig`);
        if (!b.example) errors.push(`${f.label}: @event "${b.event}" is missing @example`);
        eventsList.push({
          id: `event-${slug(b.event)}`,
          kind: 'event',
          name: b.event,
          module: f.mod,
          signature: b.sig,
          description: b.description,
          example: b.example,
          errorCodes: findCodesInText(`${b.description} ${b.sig}`),
        });
      }
    }
  }

  // Every event emitted via .ev.emit('<name>') in hawkes-net.mjs must have a documented @event block.
  const emitted = findEmittedEvents(net);
  const documentedEvents = new Set(eventsList.map((e) => e.name));
  for (const evName of emitted) {
    if (!documentedEvents.has(evName)) {
      errors.push(`sdk/js/hawkes-net.mjs: event "${evName}" has no JSDoc (@event ${evName})`);
    }
  }

  const all = [...exportsList, ...methodsList, ...optionsList, ...eventsList];
  return {
    ok: errors.length === 0,
    errors,
    catalog: {
      exports: exportsList,
      methods: methodsList,
      options: optionsList,
      events: eventsList,
      all,
    },
  };
}

export function parseApiDocs(netSrc?: string, coreSrc?: string): ApiDocsCatalog {
  return validateSdkJsdoc(netSrc, coreSrc).catalog;
}

/** Formats description text, turning inline `code` spans into <code> and linking known error codes to /docs/errors#<code>. */
export function formatDescriptionHtml(text: string): string {
  const parts = text.split(/(`[^`]+`)/g);
  return parts
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
        const inner = part.slice(1, -1);
        if (KNOWN_ERROR_CODES.has(inner)) {
          return `<a class="err-code" href="/docs/errors#${esc(inner)}"><code>${esc(inner)}</code></a>`;
        }
        return `<code>${esc(inner)}</code>`;
      }
      // Also link any bare error code tokens in plain text.
      return esc(part).replace(/\b([a-z][a-z0-9_]+)\b/g, (m) =>
        KNOWN_ERROR_CODES.has(m) ? `<a class="err-code" href="/docs/errors#${esc(m)}"><code>${esc(m)}</code></a>` : m,
      );
    })
    .join('');
}

function renderEntry(e: ApiDocEntry): string {
  const searchBlob = `${e.name} ${e.kind} ${e.module} ${e.signature} ${e.description} ${e.example} ${e.errorCodes.join(' ')}`.toLowerCase();
  return `      <article class="api-item" id="${esc(e.id)}" data-kind="${esc(e.kind)}" data-name="${esc(e.name)}" data-module="${esc(e.module)}" data-search="${esc(searchBlob)}">
        <div class="api-item-head">
          <h3 class="api-item-name"><a href="#${esc(e.id)}"><code>${esc(e.name)}</code></a></h3>
          <span class="api-badge" data-kind="${esc(e.kind)}">${esc(e.kind)}</span>
          <span class="api-mod">${esc(e.module)}</span>
        </div>
        <div class="api-sig"><code>${esc(e.signature)}</code></div>
        <p class="api-desc">${formatDescriptionHtml(e.description)}</p>
        <pre class="api-example"><code>${esc(e.example)}</code></pre>
      </article>`;
}

export function apiDocsHtml(netSrc?: string, coreSrc?: string): string {
  const { catalog } = validateSdkJsdoc(netSrc, coreSrc);
  const sections: { id: string; kind: string; title: string; lead: string; items: ApiDocEntry[] }[] = [
    {
      id: 'exports',
      kind: 'export',
      title: 'Exports',
      lead: 'Public functions, classes, and constants exported by @hawkesgen/net (sdk/js/hawkes-net.mjs) and @hawkesgen/net/core (sdk/js/hawkes-net-core.mjs).',
      items: catalog.exports,
    },
    {
      id: 'methods',
      kind: 'method',
      title: 'Methods & properties',
      lead: 'Instance methods and properties on Room, Room.sync, Lobby, Track, Links, Codec, Writer, Reader, and Dict.',
      items: catalog.methods,
    },
    {
      id: 'options',
      kind: 'option',
      title: 'Options',
      lead: 'Configuration fields accepted by join(), lobby(), room.send(), sync.push(), sync.claim(), background(), and Track.',
      items: catalog.options,
    },
    {
      id: 'events',
      kind: 'event',
      title: 'Events',
      lead: 'Lifecycle, peer, transport, state, and problem events emitted by Room and Lobby.',
      items: catalog.events,
    },
  ];

  const sectionsHtml = sections
    .map(
      (s) => `    <section class="api-section" id="${s.id}" data-section="${s.kind}">
      <div class="api-section-head">
        <h2>${esc(s.title)} <span class="api-section-count">(${s.items.length})</span></h2>
        <p class="lead">${esc(s.lead)}</p>
      </div>
      <div class="api-list">
${s.items.map(renderEntry).join('\n')}
      </div>
    </section>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hawkes Net — API reference</title>
<link rel="stylesheet" href="/site.css">
<script src="/site.js" defer></script>
<style>
  main { max-width: 1020px; margin: 0 auto; padding: 36px 24px 72px; }
  h1 { font-size: clamp(24px, 3.2vw, 34px); letter-spacing: -0.02em; margin: 0 0 8px; }
  .lead { color: var(--muted); font-size: 15px; margin: 0 0 20px; max-width: 72ch; }
  .docs-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 20px; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
  .docs-tabs a { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--muted); font-size: 13px; font-weight: 500; text-decoration: none; }
  .docs-tabs a:hover { color: var(--ink); border-color: var(--muted); text-decoration: none; }
  .docs-tabs a[aria-current="page"] { color: var(--ink); border-color: var(--accent); background: var(--card); }
  .api-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 0 0 24px; padding: 14px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
  .api-search-wrap { flex: 1 1 240px; min-width: 0; display: flex; align-items: center; gap: 8px; }
  .api-search-input { width: 100%; min-width: 0; padding: 9px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); font: inherit; font-size: 14px; }
  .api-search-input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
  .api-count { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: nowrap; }
  .api-jumps { display: flex; flex-wrap: wrap; gap: 6px; }
  .api-jumps a { padding: 5px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--muted); font-size: 12px; text-decoration: none; }
  .api-jumps a:hover { color: var(--ink); border-color: var(--muted); text-decoration: none; }
  .api-section { margin: 0 0 36px; }
  .api-section[hidden] { display: none; }
  .api-section-head h2 { font-size: 20px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .api-section-count { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; font-weight: 400; }
  .api-list { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .api-item { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; min-width: 0; scroll-margin-top: 72px; }
  .api-item[hidden] { display: none; }
  .api-item:target { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .api-item-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin: 0 0 6px; }
  .api-item-name { font-size: 15px; margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-word; }
  .api-item-name a { color: var(--ink); text-decoration: none; }
  .api-item-name a:hover { color: var(--accent); }
  .api-badge { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; padding: 1px 7px; border-radius: 4px; border: 1px solid var(--line); color: var(--accent); background: var(--bg); }
  .api-mod { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); margin-left: auto; }
  .api-sig { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: var(--code-ink); background: var(--code); border: 1px solid var(--line); border-radius: 6px; padding: 7px 10px; margin: 0 0 8px; overflow-wrap: anywhere; word-break: break-word; }
  .api-sig code { background: none; border: 0; padding: 0; color: inherit; font: inherit; }
  .api-desc { margin: 0 0 10px; color: var(--ink); font-size: 14px; line-height: 1.55; overflow-wrap: anywhere; }
  .api-desc code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: var(--accent); background: var(--code); padding: 1px 5px; border-radius: 4px; border: 1px solid var(--line); }
  .api-desc a.err-code { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
  .api-desc a.err-code code { color: var(--accent); }
  .api-example { margin: 0; padding: 9px 11px; background: var(--code); border: 1px solid var(--line); border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: var(--code-ink); overflow-x: auto; }
  .api-empty { padding: 24px; text-align: center; color: var(--muted); background: var(--card); border: 1px solid var(--line); border-radius: 10px; font-size: 14px; }
  .api-empty[hidden] { display: none; }
  @media (max-width: 640px) {
    main { padding: 22px 14px 48px; }
    .api-toolbar { padding: 10px; gap: 8px; }
    .api-item { padding: 12px; }
    .api-mod { margin-left: 0; width: 100%; }
  }
</style>
</head>
<body data-page="docs">
<header class="site-header"></header>
<main>
  <nav class="docs-tabs" aria-label="Documentation pages">
    <a href="/docs/api" aria-current="page">API reference</a>
    <a href="/docs/errors">Error codes</a>
  </nav>
  <h1>API reference</h1>
  <p class="lead">Every public export, method, option, and event in <code>@hawkesgen/net</code> and <code>@hawkesgen/net/core</code>, generated from the SDK's JSDoc. Error codes open their entry on <a href="/docs/errors"><code>/docs/errors</code></a>.</p>
  <div class="api-toolbar" role="search">
    <div class="api-search-wrap">
      <input id="api-search" class="api-search-input" type="search" placeholder="Filter exports, methods, options, events, or error codes..." aria-label="Filter API reference" autocomplete="off" spellcheck="false" />
    </div>
    <span id="api-count" class="api-count" aria-live="polite">${catalog.all.length} of ${catalog.all.length} shown</span>
    <nav class="api-jumps" aria-label="API sections">
      <a href="#exports">Exports (${catalog.exports.length})</a>
      <a href="#methods">Methods (${catalog.methods.length})</a>
      <a href="#options">Options (${catalog.options.length})</a>
      <a href="#events">Events (${catalog.events.length})</a>
    </nav>
  </div>
${sectionsHtml}
  <p id="api-empty" class="api-empty" hidden>No API entries match your filter.</p>
</main>
<footer class="site-footer"></footer>
<script>
(() => {
  const input = document.getElementById('api-search');
  const countEl = document.getElementById('api-count');
  const emptyEl = document.getElementById('api-empty');
  const items = Array.from(document.querySelectorAll('.api-item'));
  const sections = Array.from(document.querySelectorAll('.api-section'));
  const total = items.length;
  function applyFilter() {
    const raw = (input ? input.value : '').trim().toLowerCase();
    const tokens = raw ? raw.split(/\\s+/).filter(Boolean) : [];
    let shown = 0;
    for (const item of items) {
      const hay = item.getAttribute('data-search') || '';
      const match = !tokens.length || tokens.every((t) => hay.includes(t));
      item.hidden = !match;
      if (match) shown++;
    }
    for (const sec of sections) {
      const secItems = sec.querySelectorAll('.api-item:not([hidden])');
      sec.hidden = secItems.length === 0;
    }
    if (countEl) countEl.textContent = shown + ' of ' + total + ' shown';
    if (emptyEl) emptyEl.hidden = shown > 0;
  }
  if (input) {
    const q = new URLSearchParams(location.search).get('q');
    if (q) { input.value = q; applyFilter(); }
    input.addEventListener('input', applyFilter);
    input.addEventListener('search', applyFilter);
  }
})();
</script>
</body>
</html>
`;
}
