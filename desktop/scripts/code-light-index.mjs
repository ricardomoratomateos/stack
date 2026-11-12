#!/usr/bin/env node
// @ts-check
/**
 * SPIKE (docs/spikes/code-browser.md) — the "light" JS/TS navigation: no language server, no type checker.
 *
 * A syntactic index (TypeScript's parser only: no program, no node_modules) of what each file declares and
 * exports, plus import resolution through the tsconfig `paths`. "Go to definition" follows the import of the
 * name under the cursor to the declaration in the target file; "find references" is `git grep -w` narrowed to
 * the files that import the name from that module.
 *
 *   code-light-index.mjs build <projectDir> <index.json> [--typescript <dir of the typescript package>]
 *   code-light-index.mjs def   <projectDir> <index.json> <file> <line0> <col0>
 *   code-light-index.mjs refs  <projectDir> <index.json> <file> <line0> <col0>
 *
 * It knows nothing about types: `a.b()` on a value resolves only when `a` is an import, an enum or a class
 * named in the file. That is the accuracy the spike measures.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const argv = process.argv.slice(2);
const tsDir = argv.includes('--typescript') ? argv[argv.indexOf('--typescript') + 1] : undefined;
/** @type {import('typescript')} */
const ts = createRequire(import.meta.url)(tsDir ?? 'typescript');

const EXT = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs'];
const isSource = (/** @type {string} */ f) => /\.(tsx?|jsx?|mjs)$/.test(f);

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */ const out = [];
  (function go(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'coverage') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) go(p); else if (e.isFile() && isSource(e.name)) out.push(p);
    }
  })(dir);
  return out;
}

/** @param {string} file @param {string} text */
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/**
 * What one file declares. `d`: [name, line, col, kind, container, exportedAs] — `exportedAs` is the public name
 * ('default' for a default export), '' when not exported. `r`: re-exports [exportedName | '*', sourceName, specifier].
 * @param {import('typescript').SourceFile} sf
 */
function declarations(sf) {
  /** @type {Array<[string, number, number, string, string, string]>} */ const d = [];
  /** @type {Array<[string, string, string]>} */ const r = [];
  const at = (/** @type {import('typescript').Node} */ n) => sf.getLineAndCharacterOfPosition(n.getStart(sf));
  const mods = (/** @type {any} */ n) => (n.modifiers ?? []).map((/** @type {any} */ m) => m.kind);
  const add = (/** @type {import('typescript').Node | undefined} */ nameNode, /** @type {string} */ kind, /** @type {string} */ container, /** @type {string} */ exportedAs) => {
    if (!nameNode) return;
    if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) || ts.isPrivateIdentifier(nameNode)) {
      const p = at(nameNode);
      d.push([nameNode.text, p.line, p.character, kind, container, exportedAs]);
    } else if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
      for (const el of nameNode.elements) if (!ts.isOmittedExpression(el)) add(el.name, kind, container, exportedAs && ts.isIdentifier(el.name) ? el.name.text : '');
    }
  };
  for (const st of sf.statements) {
    const m = mods(st);
    const exported = m.includes(ts.SyntaxKind.ExportKeyword);
    const isDefault = m.includes(ts.SyntaxKind.DefaultKeyword);
    const pub = (/** @type {string | undefined} */ name) => (isDefault ? 'default' : exported ? name ?? '' : '');
    if (ts.isFunctionDeclaration(st)) add(st.name, 'function', '', pub(st.name?.text));
    else if (ts.isClassDeclaration(st)) {
      add(st.name, 'class', '', pub(st.name?.text));
      for (const mem of st.members) if ('name' in mem && mem.name) add(/** @type {any} */ (mem.name), ts.isMethodDeclaration(mem) ? 'method' : 'property', st.name?.text ?? '', '');
    } else if (ts.isInterfaceDeclaration(st)) {
      add(st.name, 'interface', '', pub(st.name.text));
      for (const mem of st.members) if ('name' in mem && mem.name) add(/** @type {any} */ (mem.name), 'property', st.name.text, '');
    } else if (ts.isTypeAliasDeclaration(st)) add(st.name, 'type', '', pub(st.name.text));
    else if (ts.isEnumDeclaration(st)) {
      add(st.name, 'enum', '', pub(st.name.text));
      for (const mem of st.members) add(/** @type {any} */ (mem.name), 'enumMember', st.name.text, '');
    } else if (ts.isModuleDeclaration(st)) add(/** @type {any} */ (st.name), 'namespace', '', pub(/** @type {any} */ (st.name).text));
    else if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) {
        add(decl.name, 'variable', '', exported && ts.isIdentifier(decl.name) ? decl.name.text : exported ? 'x' : '');
        // `const Steps = { A: 'a', … } as const`: the poor man's enum. Its keys are members of `Steps`.
        let init = decl.initializer;
        while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init))) init = init.expression;
        if (init && ts.isObjectLiteralExpression(init) && ts.isIdentifier(decl.name)) {
          for (const prop of init.properties) if (prop.name) add(/** @type {any} */ (prop.name), 'property', decl.name.text, '');
        }
      }
    } else if (ts.isExportAssignment(st) && !st.isExportEquals && ts.isIdentifier(st.expression)) r.push(['default', st.expression.text, '']);
    else if (ts.isExportDeclaration(st)) {
      const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : '';
      if (!st.exportClause) r.push(['*', '*', spec]);
      else if (ts.isNamedExports(st.exportClause)) for (const el of st.exportClause.elements) r.push([el.name.text, (el.propertyName ?? el.name).text, spec]);
    }
  }
  return { d, r };
}

// ---------- module resolution: relative paths and the tsconfig `paths`, never node_modules ----------

/** @param {string} projectDir */
function resolver(projectDir) {
  let paths = /** @type {Record<string, string[]>} */ ({});
  let base = projectDir;
  try {
    const cfg = ts.readConfigFile(path.join(projectDir, 'tsconfig.json'), (f) => fs.readFileSync(f, 'utf8')).config ?? {};
    paths = cfg.compilerOptions?.paths ?? {};
    if (cfg.compilerOptions?.baseUrl) base = path.resolve(projectDir, cfg.compilerOptions.baseUrl);
  } catch { /* no tsconfig: relative imports only */ }
  const patterns = Object.entries(paths).sort((a, b) => b[0].length - a[0].length);
  /** @param {string} p */
  const asFile = (p) => {
    for (const c of [p, ...EXT.map((e) => p + e), ...EXT.map((e) => path.join(p, 'index' + e))]) {
      try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
    }
    return undefined;
  };
  /** @param {string} from @param {string} spec @returns {string | undefined} */
  return (from, spec) => {
    if (spec.startsWith('.')) return asFile(path.resolve(path.dirname(from), spec));
    for (const [pattern, targets] of patterns) {
      const star = pattern.indexOf('*');
      if (star < 0 ? spec !== pattern : !(spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1)))) continue;
      const captured = star < 0 ? '' : spec.slice(star, spec.length - (pattern.length - star - 1));
      for (const t of targets) { const hit = asFile(path.resolve(base, t.replace('*', captured))); if (hit) return hit; }
    }
    return undefined;
  };
}

// ---------- build ----------

/** @param {string} projectDir @param {string} out */
function build(projectDir, out) {
  const t0 = Date.now();
  const files = walk(projectDir);
  /** @type {Record<string, { d: unknown[], r: unknown[] }>} */ const index = {};
  let n = 0;
  for (const f of files) {
    const { d, r } = declarations(parse(f, fs.readFileSync(f, 'utf8')));
    index[path.relative(projectDir, f)] = { d, r };
    n += d.length;
  }
  fs.writeFileSync(out, JSON.stringify(index));
  console.log(`${files.length} files, ${n} declarations, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(1)} s, peak RSS ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`);
}

// ---------- query ----------

/**
 * @param {string} projectDir @param {Record<string, { d: any[], r: any[] }>} index
 * @returns {{ definition(file: string, line: number, col: number): Array<{ file: string, line: number, col: number, how: string }>,
 *             references(file: string, line: number, col: number): Array<{ file: string, line: number }> }}
 */
export function navigator(projectDir, index) {
  const resolve = resolver(projectDir);
  const rel = (/** @type {string} */ f) => path.relative(projectDir, f);
  const loc = (/** @type {string} */ r, /** @type {any[]} */ d, /** @type {string} */ how) => ({ file: path.join(projectDir, r), line: d[1], col: d[2], how });

  /** The declaration exported as `name` by `file`, following re-exports. @returns {{ r: string, d: any[] } | undefined} */
  function exportOf(/** @type {string} */ file, /** @type {string} */ name, depth = 0) {
    const entry = index[rel(file)];
    if (!entry || depth > 6) return undefined;
    const own = entry.d.find((d) => d[5] === name && d[4] === '');
    if (own) return { r: rel(file), d: own };
    for (const [as, source, spec] of entry.r) {
      if (as === name && !spec) { const local = entry.d.find((d) => d[0] === source && d[4] === ''); if (local) return { r: rel(file), d: local }; }
      if (spec && (as === name || as === '*')) {
        const target = resolve(file, spec);
        const hit = target && exportOf(target, as === '*' ? name : source, depth + 1);
        if (hit) return hit;
      }
    }
    return undefined;
  }

  /** @param {import('typescript').SourceFile} sf */
  function importsOf(sf) {
    /** @type {Map<string, { spec: string, name: string }>} */ const map = new Map();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause) continue;
      const spec = st.moduleSpecifier.text;
      if (st.importClause.name) map.set(st.importClause.name.text, { spec, name: 'default' });
      const nb = st.importClause.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) map.set(el.name.text, { spec, name: (el.propertyName ?? el.name).text });
      if (nb && ts.isNamespaceImport(nb)) map.set(nb.name.text, { spec, name: '*' });
    }
    return map;
  }

  /** @param {import('typescript').SourceFile} sf @param {number} pos */
  function identifierAt(sf, pos) {
    /** @type {import('typescript').Node | undefined} */ let found;
    (function visit(/** @type {import('typescript').Node} */ n) {
      if (pos < n.getStart(sf) || pos >= n.getEnd()) return;
      if (ts.isIdentifier(n)) found = n;
      n.forEachChild(visit);
    })(sf);
    return /** @type {import('typescript').Identifier | undefined} */ (found);
  }

  /** Names bound anywhere in the file (locals, parameters, destructuring): the nearest one before the cursor wins. */
  function localBinding(/** @type {import('typescript').SourceFile} */ sf, /** @type {string} */ name, /** @type {number} */ pos) {
    /** @type {import('typescript').Node | undefined} */ let best;
    (function visit(/** @type {import('typescript').Node} */ n) {
      const nameNode = (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)
        || ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isEnumDeclaration(n)) ? n.name : undefined;
      if (nameNode && ts.isIdentifier(nameNode) && nameNode.text === name) {
        const s = nameNode.getStart(sf);
        if (!best || (s <= pos && s > best.getStart(sf)) || best.getStart(sf) > pos) best = nameNode;
      }
      n.forEachChild(visit);
    })(sf);
    return best;
  }

  function target(/** @type {string} */ file, /** @type {number} */ line, /** @type {number} */ col) {
    const sf = parse(file, fs.readFileSync(file, 'utf8'));
    const pos = sf.getPositionOfLineAndCharacter(line, col);
    const id = identifierAt(sf, pos);
    return { sf, pos, id, imports: importsOf(sf) };
  }

  return {
    definition(file, line, col) {
      const { sf, pos, id, imports } = target(file, line, col);
      if (!id) return [];
      const name = id.text;
      // `Thing.member`: a member of something named in this file (an enum, a class, a namespace import).
      const parent = id.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.name === id && ts.isIdentifier(parent.expression)) {
        const owner = parent.expression.text;
        const imp = imports.get(owner);
        const ownerFile = imp ? resolve(file, imp.spec) : file;
        if (ownerFile && imp?.name === '*') { const hit = exportOf(ownerFile, name); if (hit) return [loc(hit.r, hit.d, 'namespace member')]; }
        const ownerDecl = ownerFile && (imp ? exportOf(ownerFile, imp.name) : { r: rel(file), d: [owner] });
        if (ownerDecl) {
          const member = index[ownerDecl.r]?.d.find((d) => d[0] === name && d[4] === ownerDecl.d[0]);
          if (member) return [loc(ownerDecl.r, member, 'member of an imported name')];
        }
      }
      const imp = imports.get(name);
      if (imp) {
        const targetFile = resolve(file, imp.spec);
        if (!targetFile) return []; // a library: not ours to index
        const hit = imp.name === '*' ? undefined : exportOf(targetFile, imp.name);
        return hit ? [loc(hit.r, hit.d, 'import')] : [{ file: targetFile, line: 0, col: 0, how: 'import (file only)' }];
      }
      const local = localBinding(sf, name, pos);
      if (local) { const p = sf.getLineAndCharacterOfPosition(local.getStart(sf)); return [{ file, line: p.line, col: p.character, how: 'local' }]; }
      // Last resort: every exported declaration with that name (may be several).
      /** @type {Array<{ file: string, line: number, col: number, how: string }>} */ const all = [];
      for (const [r, entry] of Object.entries(index)) for (const d of entry.d) if (d[0] === name && (d[5] || d[4])) all.push(loc(r, d, 'by name'));
      return all.slice(0, 50);
    },

    references(file, line, col) {
      const { id } = target(file, line, col);
      if (!id) return [];
      const name = id.text;
      const def = this.definition(file, line, col)[0];
      // `Steps.A`: nobody imports `A`; the files that matter are those importing `Steps`.
      const parent = id.parent;
      const via = ts.isPropertyAccessExpression(parent) && parent.name === id && ts.isIdentifier(parent.expression) ? parent.expression.text : name;
      let lines = '';
      try { lines = execFileSync('git', ['-C', projectDir, 'grep', '-n', '-w', '-F', '--untracked', name, '--', '*.ts', '*.tsx', '*.js', '*.jsx'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); } catch { /* no match */ }
      /** @type {Map<string, number[]>} */ const byFile = new Map();
      for (const l of lines.split('\n')) {
        const m = /^([^:]+):(\d+):/.exec(l);
        if (m) byFile.set(m[1], [...(byFile.get(m[1]) ?? []), Number(m[2]) - 1]);
      }
      /** @type {Array<{ file: string, line: number }>} */ const out = [];
      for (const [r, ls] of byFile) {
        const abs = path.join(projectDir, r);
        // Keep a file when it is where the name is declared, or when it imports the name from that module.
        let keep = !def || abs === def.file;
        if (!keep) {
          const imp = importsOf(parse(abs, fs.readFileSync(abs, 'utf8'))).get(via);
          const from = imp && resolve(abs, imp.spec);
          keep = !!from && (from === def.file || exportOf(from, imp.name)?.r === rel(def.file));
        }
        if (keep) for (const l of ls) out.push({ file: abs, line: l });
      }
      return out;
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, projectDir, indexFile, file, line, col] = argv.filter((a, i) => a !== '--typescript' && argv[i - 1] !== '--typescript');
  if (cmd === 'build') build(path.resolve(projectDir), indexFile);
  else if (cmd === 'def' || cmd === 'refs') {
    const t0 = Date.now();
    const nav = navigator(path.resolve(projectDir), JSON.parse(fs.readFileSync(indexFile, 'utf8')));
    const loaded = Date.now() - t0;
    const t1 = Date.now();
    const res = cmd === 'def' ? nav.definition(file, Number(line), Number(col)) : nav.references(file, Number(line), Number(col));
    console.log(JSON.stringify({ loadMs: loaded, queryMs: Date.now() - t1, count: res.length, first: res.slice(0, 3), rssMb: Math.round(process.memoryUsage().rss / 1e6) }));
  } else { console.error('usage: code-light-index.mjs build|def|refs <projectDir> <index.json> [file line col]'); process.exit(2); }
}
