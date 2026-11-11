#!/usr/bin/env node
/**
 * Generates desktop/src/theme/vscode-theme.css: the `--vscode-*` variables a VS Code webview gets,
 * for one colour theme, from the local VS Code install.
 *
 *   node scripts/gen-vscode-theme.mjs [--theme dark_modern.json] [--kind dark|light] [--app "/Applications/Visual Studio Code.app"] [--out file]
 *
 * Values, lowest to highest precedence:
 *   1. colours registered by VS Code itself (`registerColor(...)` in workbench.desktop.main.js) and by
 *      built-in extensions (`contributes.colors`), for the theme's kind; only plain values
 *      (hex, white/black, with alpha) are readable from the minified code, the rest are reported;
 *   2. the theme file and every file it `include`s.
 * Also copied verbatim from the install: the webview's default stylesheet (`@layer vscode-default`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const APP = arg('app', '/Applications/Visual Studio Code.app') + '/Contents/Resources/app';
const THEME = arg('theme', 'dark_modern.json');
const KIND = arg('kind', /light/.test(THEME) ? 'light' : 'dark');
const OUT = arg('out', path.join(here, '../src/theme/vscode-theme.css'));
const themesDir = `${APP}/extensions/theme-defaults/themes`;

/** JSON with comments and trailing commas (theme files are JSONC). */
export function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function loadTheme(file) {
  const j = parseJsonc(fs.readFileSync(file, 'utf8'));
  const base = j.include ? loadTheme(path.resolve(path.dirname(file), j.include)) : {};
  return { ...base, ...(j.colors ?? {}) };
}

const hex2 = (n) => Math.round(n * 255).toString(16).padStart(2, '0');
const withAlpha = (rgb, a) => (a >= 1 ? rgb : rgb + hex2(a));

/** The `kind` value of a minified registerColor default, when it is a plain colour. */
function plain(expr, kind) {
  expr = expr.trim();
  let m;
  if ((m = /^"(#[0-9a-fA-F]{3,8})"$/.exec(expr))) return m[1];
  if ((m = /^\w+\.(white|black)$/.exec(expr))) return m[1] === 'white' ? '#FFFFFF' : '#000000';
  if ((m = /^\w+\(\w+\.(white|black),([.\d]+)\)$/.exec(expr)) || (m = /^\w+\.(white|black)\.transparent\(([.\d]+)\)$/.exec(expr)))
    return withAlpha(m[1] === 'white' ? '#FFFFFF' : '#000000', Number(m[2]));
  if ((m = /^\w+\.fromHex\("(#[0-9a-fA-F]{6})"\)\.transparent\(([.\d]+)\)$/.exec(expr))) return withAlpha(m[1], Number(m[2]));
  return undefined;
}

function registryDefaults(kind) {
  const js = fs.readFileSync(`${APP}/out/vs/workbench/workbench.desktop.main.js`, 'utf8');
  const out = {};
  const unresolved = new Set();
  for (const m of js.matchAll(/\ble\("([\w.]+)",\{([^{}]*)\}/g)) {
    const field = m[2].split(/,(?=\w+:)/).map((p) => p.split(/:(.*)/s)).find(([k]) => k === kind);
    if (!field) continue;
    const v = field[1].trim() === 'null' ? null : plain(field[1], kind);
    if (v) out[m[1]] = v;
    else if (v === undefined) unresolved.add(m[1]);
  }
  for (const m of js.matchAll(/"(terminal\.ansi\w+)":\{index:\d+,defaults:\{([^}]*)\}/g)) {
    const v = new RegExp(`${kind}:"(#[0-9a-fA-F]+)"`).exec(m[2]);
    if (v) out[m[1]] = v[1];
  }
  // `le(id, otherColour)`: same defaults as another registered colour (the minifier names it).
  const names = new Map([...js.matchAll(/[,;\s](\w+)=le\("([\w.]+)"/g)].map((m) => [m[1], m[2]]));
  for (const m of js.matchAll(/\ble\("([\w.]+)",(\w+),/g)) {
    const to = names.get(m[2]);
    if (to && out[to] && !out[m[1]]) out[m[1]] = out[to];
  }
  return { out, unresolved };
}

function extensionColors(kind) {
  const out = {};
  const aliases = {};
  for (const dir of fs.readdirSync(`${APP}/extensions`)) {
    const p = `${APP}/extensions/${dir}/package.json`;
    if (!fs.existsSync(p)) continue;
    for (const c of JSON.parse(fs.readFileSync(p, 'utf8')).contributes?.colors ?? []) {
      const v = c.defaults?.[kind];
      if (typeof v !== 'string') continue;
      if (v.startsWith('#')) out[c.id] = v;
      else aliases[c.id] = v;
    }
  }
  return { out, aliases };
}

const cssVar = (key) => `--vscode-${key.replace(/\./g, '-')}`;

function defaultStyles() {
  const html = fs.readFileSync(`${APP}/out/vs/workbench/contrib/webview/browser/pre/index.html`, 'utf8');
  const m = /defaultStyles\.textContent = `([^`]*)`;/.exec(html);
  if (!m) throw new Error('webview default styles not found in this VS Code build');
  return m[1].replace(/^\n/, '').replace(/\n\t\t$/, '');
}

function usedVariables() {
  const dir = path.join(here, '../../src/webview');
  const used = new Set();
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (f.isDirectory()) walk(path.join(d, f.name));
      else for (const m of fs.readFileSync(path.join(d, f.name), 'utf8').matchAll(/--vscode-[\w-]+/g)) used.add(m[0]);
    }
  };
  walk(dir);
  return used;
}

const registry = registryDefaults(KIND);
const ext = extensionColors(KIND);
const colors = { ...registry.out, ...ext.out };
for (const [id, to] of Object.entries(ext.aliases)) if (colors[to] && !colors[id]) colors[id] = colors[to];
Object.assign(colors, loadTheme(path.join(themesDir, THEME)));

const vars = Object.keys(colors).sort().map((k) => `  ${cssVar(k)}: ${colors[k]};`);
const fonts = [
  // What VS Code sets on a webview's <html> on macOS with default settings.
  '  --vscode-font-family: -apple-system, BlinkMacSystemFont, sans-serif;',
  '  --vscode-font-weight: normal;',
  '  --vscode-font-size: 13px;',
  "  --vscode-editor-font-family: Menlo, Monaco, 'Courier New', monospace;",
  '  --vscode-editor-font-weight: normal;',
  '  --vscode-editor-font-size: 12px;',
  "  --monaco-monospace-font: Menlo, Monaco, 'Courier New', monospace;",
  '  --text-link-decoration: none;',
];

const css = `/* Generated by scripts/gen-vscode-theme.mjs (${THEME}, ${KIND}) from the local VS Code install. Do not edit. */
:root {
  color-scheme: ${KIND};
${fonts.join('\n')}
${vars.join('\n')}
}

${defaultStyles()}
`;
fs.writeFileSync(OUT, css);

const missing = [...usedVariables()].filter((v) => !vars.some((l) => l.startsWith(`  ${v}:`)) && !fonts.some((l) => l.startsWith(`  ${v}:`)));
console.log(`${OUT}: ${vars.length} colours`);
if (missing.length) console.log(`not defined (VS Code leaves them unset for this theme, or they could not be read): ${missing.join(' ')}`);
