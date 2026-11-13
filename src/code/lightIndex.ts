import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as TS from 'typescript';

/**
 * JS/TS navigation without a language server or a type checker.
 *
 * A syntactic index (TypeScript's parser only: no program, no node_modules) of what each file declares and
 * exports, plus import resolution through the tsconfig `paths`. "Go to definition" follows the import of the
 * name under the cursor to its declaration; "find references" is `git grep -w` narrowed to the files that
 * import the name from that module.
 *
 * It knows nothing about types: `a.b()` on a value resolves only when `a` is an import, an enum, a class or
 * a `const … as const` object named in the file. Measured against TypeScript 7 in docs/spikes/code-browser.md.
 */

/** [name, line, col, kind, container, exportedAs] — `exportedAs` is 'default' for a default export, '' when not exported. */
export type Declaration = [name: string, line: number, col: number, kind: string, container: string, exportedAs: string];
/** [exportedName | '*', sourceName, specifier] */
export type ReExport = [as: string, source: string, spec: string];
export interface FileEntry { d: Declaration[]; r: ReExport[] }
export type IndexData = Record<string, FileEntry>;
export interface Place { file: string; line: number; col: number; length: number; how?: string }

const SOURCE = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/;
const EXT = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs'];
/** Directory names never walked into when nothing else is said (the repo's `scriptExcludeDirs`). */
export const DEFAULT_SKIP: readonly string[] = ['node_modules', '.git', 'dist', 'build', 'coverage', 'vendor', '.worktrees'];

/** Loaded on first use: the parser is several MB of JavaScript nobody needs until a JS/TS file is navigated. */
let loaded: typeof TS | undefined;
const tsc = (): typeof TS => (loaded ??= require('typescript') as typeof TS);

const parse = (file: string, text: string): TS.SourceFile => {
  const ts = tsc();
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /x$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
};

/** Every JS/TS source under `dir`, absolute. */
export function sourceFiles(dir: string, limit = 60_000, skipDirs: readonly string[] = DEFAULT_SKIP): string[] {
  const out: string[] = [];
  // A name (`dist`) is skipped anywhere; a path (`apps/legacy`, absolute or relative to `dir`) only there.
  const names = new Set(skipDirs.filter((d) => !d.includes('/')));
  const paths = new Set(skipDirs.filter((d) => d.includes('/')).map((d) => (path.isAbsolute(d) ? d : path.join(dir, d))));
  const visit = (d: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      const p = path.join(d, e.name);
      if (names.has(e.name) || paths.has(p)) continue;
      if (e.isDirectory()) visit(p); else if (e.isFile() && SOURCE.test(e.name)) out.push(p);
    }
  };
  visit(dir);
  return out;
}

/** What one file declares and re-exports. */
export function declarationsOf(file: string, text: string): FileEntry {
  const ts = tsc();
  const sf = parse(file, text);
  const d: Declaration[] = [];
  const r: ReExport[] = [];
  const add = (nameNode: TS.Node | undefined, kind: string, container: string, exportedAs: string): void => {
    if (!nameNode) return;
    if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode) || ts.isPrivateIdentifier(nameNode)) {
      const p = sf.getLineAndCharacterOfPosition(nameNode.getStart(sf));
      d.push([nameNode.text, p.line, p.character, kind, container, exportedAs]);
    } else if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
      for (const el of nameNode.elements) {
        if (!ts.isOmittedExpression(el)) add(el.name, kind, container, exportedAs && ts.isIdentifier(el.name) ? el.name.text : '');
      }
    }
  };
  const members = (list: readonly TS.Node[], owner: string): void => {
    for (const mem of list) {
      const name = (mem as { name?: TS.Node }).name;
      if (name) add(name, ts.isMethodDeclaration(mem) || ts.isMethodSignature(mem) ? 'method' : 'property', owner, '');
    }
  };
  for (const st of sf.statements) {
    const mods = ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []).map((m) => m.kind) : [];
    const exported = mods.includes(ts.SyntaxKind.ExportKeyword);
    const isDefault = mods.includes(ts.SyntaxKind.DefaultKeyword);
    const pub = (name: string | undefined): string => (isDefault ? 'default' : exported ? name ?? '' : '');
    if (ts.isFunctionDeclaration(st)) add(st.name, 'function', '', pub(st.name?.text));
    else if (ts.isClassDeclaration(st)) { add(st.name, 'class', '', pub(st.name?.text)); members(st.members, st.name?.text ?? ''); }
    else if (ts.isInterfaceDeclaration(st)) { add(st.name, 'interface', '', pub(st.name.text)); members(st.members, st.name.text); }
    else if (ts.isTypeAliasDeclaration(st)) add(st.name, 'type', '', pub(st.name.text));
    else if (ts.isEnumDeclaration(st)) { add(st.name, 'enum', '', pub(st.name.text)); members(st.members, st.name.text); }
    else if (ts.isModuleDeclaration(st)) add(st.name, 'namespace', '', pub(st.name.text));
    else if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) {
        add(decl.name, 'variable', '', exported && ts.isIdentifier(decl.name) ? decl.name.text : exported ? 'x' : '');
        // `const Steps = { A: 'a', … } as const`: the poor man's enum. Its keys are members of `Steps`.
        let init = decl.initializer;
        while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init))) init = init.expression;
        if (init && ts.isObjectLiteralExpression(init) && ts.isIdentifier(decl.name)) members(init.properties, decl.name.text);
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

/** The nearest directory at or above `file` (inside `root`) that has a tsconfig.json or a package.json: its project. */
export function projectDirOf(root: string, file: string): string {
  let fallback: string | undefined;
  for (let dir = path.dirname(file); dir.startsWith(root); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'tsconfig.json')) || fs.existsSync(path.join(dir, 'jsconfig.json'))) return dir;
    if (!fallback && fs.existsSync(path.join(dir, 'package.json'))) fallback = dir;
    if (dir === root) break;
  }
  return fallback ?? root;
}

/** Module resolution for our own code: relative paths and the tsconfig `paths`. Never node_modules. */
export function importResolver(projectDir: string): (from: string, spec: string) => string | undefined {
  const ts = tsc();
  let paths: Record<string, string[]> = {};
  let base = projectDir;
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(projectDir, name);
    if (!fs.existsSync(file)) continue;
    const cfg = ts.readConfigFile(file, (f) => fs.readFileSync(f, 'utf8')).config as { compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string } } | undefined;
    paths = cfg?.compilerOptions?.paths ?? {};
    if (cfg?.compilerOptions?.baseUrl) base = path.resolve(projectDir, cfg.compilerOptions.baseUrl);
    break;
  }
  const patterns = Object.entries(paths).sort((a, b) => b[0].length - a[0].length);
  const asFile = (p: string): string | undefined => {
    for (const c of [p, ...EXT.map((e) => p + e), ...EXT.map((e) => path.join(p, 'index' + e))]) {
      try { if (fs.statSync(c).isFile()) return c; } catch { /* next candidate */ }
    }
    return undefined;
  };
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

const breathe = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** `git grep -n -w -F <name>` over the project's JS/TS files: [relative path, 0-based line, text]. */
export type Grep = (projectDir: string, name: string) => Promise<Array<[file: string, line: number, text: string]>>;

export const gitGrep: Grep = (projectDir, name) => new Promise((resolve) => {
  execFile('git', ['-C', projectDir, 'grep', '-n', '-w', '-F', '--untracked', '-e', name, '--', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs'],
    { maxBuffer: 256 * 1024 * 1024 }, (_err, stdout) => {
      const out: Array<[string, number, string]> = [];
      for (const l of String(stdout).split('\n')) {
        const m = /^([^:]+):(\d+):(.*)$/.exec(l);
        if (m) out.push([m[1], Number(m[2]) - 1, m[3]]);
      }
      resolve(out);
    });
});

/** One project's index and the navigation over it. */
export class LightIndex {
  private readonly resolve: (from: string, spec: string) => string | undefined;

  private constructor(readonly projectDir: string, readonly data: IndexData, private readonly grep: Grep) {
    this.resolve = importResolver(projectDir);
  }

  /**
   * Parses every source of the project. The daemon is one thread and has other work (hooks, state): it yields
   * between small batches, and reports progress.
   */
  static async build(
    projectDir: string, onProgress: (done: number, total: number) => void = () => {}, grep: Grep = gitGrep, skipDirs: readonly string[] = DEFAULT_SKIP,
  ): Promise<LightIndex> {
    const files = sourceFiles(projectDir, 60_000, skipDirs);
    const data: IndexData = {};
    for (let i = 0; i < files.length; i++) {
      try { data[path.relative(projectDir, files[i])] = declarationsOf(files[i], fs.readFileSync(files[i], 'utf8')); } catch { /* unreadable: skip */ }
      if (i % 40 === 39) { onProgress(i + 1, files.length); await breathe(); }
    }
    onProgress(files.length, files.length);
    return new LightIndex(projectDir, data, grep);
  }

  get files(): number { return Object.keys(this.data).length; }

  /** A file changed on disk: its entry again. */
  refresh(file: string): void {
    const rel = path.relative(this.projectDir, file);
    try { this.data[rel] = declarationsOf(file, fs.readFileSync(file, 'utf8')); } catch { delete this.data[rel]; }
  }

  private rel(file: string): string { return path.relative(this.projectDir, file); }
  private place(rel: string, d: Declaration, how: string): Place {
    return { file: path.join(this.projectDir, rel), line: d[1], col: d[2], length: d[0].length, how };
  }

  /** The declaration `file` exports as `name`, following re-exports. */
  private exportOf(file: string, name: string, depth = 0): { rel: string; d: Declaration } | undefined {
    const entry = this.data[this.rel(file)];
    if (!entry || depth > 6) return undefined;
    const own = entry.d.find((d) => d[5] === name && d[4] === '');
    if (own) return { rel: this.rel(file), d: own };
    for (const [as, source, spec] of entry.r) {
      if (as === name && !spec) { const local = entry.d.find((d) => d[0] === source && d[4] === ''); if (local) return { rel: this.rel(file), d: local }; }
      if (spec && (as === name || as === '*')) {
        const target = this.resolve(file, spec);
        const hit = target && this.exportOf(target, as === '*' ? name : source, depth + 1);
        if (hit) return hit;
      }
    }
    return undefined;
  }

  private importsOf(sf: TS.SourceFile): Map<string, { spec: string; name: string }> {
    const ts = tsc();
    const map = new Map<string, { spec: string; name: string }>();
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

  private target(file: string, text: string, line: number, col: number): { sf: TS.SourceFile; pos: number; id: TS.Identifier | undefined; owner: string | undefined; member: boolean } {
    const ts = tsc();
    const sf = parse(file, text);
    const pos = Math.min(sf.getPositionOfLineAndCharacter(Math.min(line, sf.getLineStarts().length - 1), 0) + col, sf.getEnd());
    let id: TS.Identifier | undefined;
    const visit = (n: TS.Node): void => {
      if (pos < n.getStart(sf) || pos > n.getEnd()) return;
      if (ts.isIdentifier(n)) id = n;
      n.forEachChild(visit);
    };
    visit(sf);
    const parent = id?.parent;
    const member = !!id && !!parent && ts.isPropertyAccessExpression(parent) && parent.name === id;
    const owner = member && parent && ts.isPropertyAccessExpression(parent) && ts.isIdentifier(parent.expression) ? parent.expression.text : undefined;
    return { sf, pos, id, owner, member };
  }

  /** Names bound anywhere in the file (locals, parameters, destructuring): the nearest one before the cursor. */
  private localBinding(sf: TS.SourceFile, name: string, pos: number): TS.Node | undefined {
    const ts = tsc();
    let best: TS.Node | undefined;
    const visit = (n: TS.Node): void => {
      const nameNode = (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)
        || ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isEnumDeclaration(n)) ? n.name : undefined;
      if (nameNode && ts.isIdentifier(nameNode) && nameNode.text === name) {
        const s = nameNode.getStart(sf);
        if (!best || (s <= pos && s > best.getStart(sf)) || best.getStart(sf) > pos) best = nameNode;
      }
      n.forEachChild(visit);
    };
    visit(sf);
    return best;
  }

  definition(file: string, text: string, line: number, col: number): Place[] {
    const { sf, pos, id, owner, member } = this.target(file, text, line, col);
    if (!id) return [];
    const name = id.text;
    const imports = this.importsOf(sf);
    if (owner) { // `Thing.member`
      const imp = imports.get(owner);
      const ownerFile = imp ? this.resolve(file, imp.spec) : file;
      if (ownerFile && imp?.name === '*') { const hit = this.exportOf(ownerFile, name); if (hit) return [this.place(hit.rel, hit.d, 'namespace member')]; }
      const ownerName = ownerFile && imp ? this.exportOf(ownerFile, imp.name) : undefined;
      const ownerRel = ownerName?.rel ?? (imp ? undefined : this.rel(file));
      const container = ownerName?.d[0] ?? owner;
      const found = ownerRel === undefined ? undefined
        : (ownerRel === this.rel(file) ? declarationsOf(file, text) : this.data[ownerRel])?.d.find((d) => d[0] === name && d[4] === container);
      if (found && ownerRel !== undefined) return [this.place(ownerRel, found, 'member')];
    }
    // `something.name` we could not place: the answer depends on a type. Say nothing rather than guess by name.
    if (member) return [];
    const imp = imports.get(name);
    if (imp) {
      const targetFile = this.resolve(file, imp.spec);
      if (!targetFile) return []; // a library: not ours to index
      const hit = imp.name === '*' ? undefined : this.exportOf(targetFile, imp.name);
      return hit ? [this.place(hit.rel, hit.d, 'import')] : [{ file: targetFile, line: 0, col: 0, length: 0, how: 'import (file only)' }];
    }
    const local = this.localBinding(sf, name, pos);
    if (local) { const p = sf.getLineAndCharacterOfPosition(local.getStart(sf)); return [{ file, line: p.line, col: p.character, length: name.length, how: 'local' }]; }
    const all: Place[] = [];
    for (const [rel, entry] of Object.entries(this.data)) for (const d of entry.d) if (d[0] === name && d[5]) all.push(this.place(rel, d, 'by name'));
    return all.slice(0, 50);
  }

  async references(file: string, text: string, line: number, col: number): Promise<Place[]> {
    const { id, owner } = this.target(file, text, line, col);
    if (!id) return [];
    const name = id.text;
    const def = this.definition(file, text, line, col)[0];
    const via = owner ?? name; // `Steps.A`: nobody imports `A`; what matters is who imports `Steps`
    const byFile = new Map<string, Array<[number, string]>>();
    for (const [rel, l, lineText] of await this.grep(this.projectDir, name)) byFile.set(rel, [...(byFile.get(rel) ?? []), [l, lineText]]);
    const out: Place[] = [];
    let n = 0;
    for (const [rel, hits] of byFile) {
      const abs = path.join(this.projectDir, rel);
      let keep = !def || abs === def.file || abs === file;
      if (!keep) {
        try {
          const imp = this.importsOf(parse(abs, fs.readFileSync(abs, 'utf8'))).get(via);
          const from = imp && this.resolve(abs, imp.spec);
          keep = !!from && !!imp && (from === def.file || this.exportOf(from, imp.name)?.rel === this.rel(def.file));
        } catch { keep = false; }
        if (++n % 40 === 0) await breathe();
      }
      if (keep) for (const [l, lineText] of hits) out.push({ file: abs, line: l, col: Math.max(0, lineText.search(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`))), length: name.length });
    }
    return out;
  }

  /** The declarations of one file, for an outline. */
  outline(file: string, text: string): Declaration[] { return declarationsOf(file, text).d; }

  /** Exported declarations whose name contains `query`. */
  symbols(query: string, limit = 80): Array<{ place: Place; name: string; kind: string; container: string }> {
    const q = query.toLowerCase();
    const out: Array<{ place: Place; name: string; kind: string; container: string }> = [];
    if (!q) return out;
    for (const [rel, entry] of Object.entries(this.data)) {
      for (const d of entry.d) {
        if (d[4] === '' && d[0].toLowerCase().includes(q)) out.push({ place: this.place(rel, d, ''), name: d[0], kind: d[3], container: rel });
      }
    }
    const rank = (n: string): number => { const l = n.toLowerCase(); return l === q ? 0 : l.startsWith(q) ? 1 : 2; };
    return out.sort((a, b) => rank(a.name) - rank(b.name) || a.name.length - b.name.length).slice(0, limit);
  }
}
