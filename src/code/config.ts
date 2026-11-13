import type { StackConfig } from '../types';

/**
 * How the Code tab treats one repository, resolved from its settings (StackConfig: the user's settings.json over
 * the repo's `.stack/config.json` over the defaults). Nothing about a project's layout is assumed in the code:
 * which directories hold its PHP, what is left out, where Composer's autoloader is, which files are scripts.
 */
export interface CodeConfig {
  php: {
    /** `phpNavigation`: off, a PHP file is shown without navigation and no base index is built. */
    enabled: boolean;
    /** `phpIndexDirs`: the top-level directories (or files) Phpactor indexes; empty = every one holding tracked PHP. */
    dirs: string[];
    /** `phpExcludeDirs`: directories never indexed (repo-relative, `vendor` or `lib/legacy`), on top of `.git` and the worktrees directory. */
    exclude: string[];
    /** `phpExtensions`, without the dot. */
    extensions: string[];
    /** `phpAutoloader`: Composer's autoloader, relative to the worktree (then to the main checkout). */
    autoloader: string;
    /** `phpBaseBranch`, else `defaultBaseBranch`: what the repo's base index is built from. */
    baseBranch: string;
    /** `phpMaxChangedFiles`: past this many PHP files differing from the base, a task is indexed in full. */
    maxChangedFiles: number;
    /** `phpactorOptions`: extra Phpactor settings (its `.phpactor.json` keys), over Stack's. */
    phpactorOptions: Record<string, unknown>;
    /** `phpBaseOnStart` (yours): build the base when stackd starts, not on the first Code tab. */
    buildBaseOnStart: boolean;
  };
  scripts: {
    /** `scriptExcludeDirs`: directory names the JS/TS index never walks into, anywhere in the tree. */
    exclude: string[];
    /** `oxlintConfig`: the repo's own oxlint config, relative to the worktree; empty = Stack's. */
    oxlintConfig: string;
  };
  tools: {
    /** `phpactorPath`, `oxlintPath`: empty = on PATH, then `~/.config/stack/tools`. */
    phpactor: string;
    oxlint: string;
    /** `phpPath`. */
    php: string;
  };
  /** `codeIdleMinutes` (yours): a language server unused this long is stopped. */
  idleMs: number;
}

/** What a repository gets when nothing says otherwise. */
export const CODE_DEFAULTS = {
  phpNavigation: true,
  phpIndexDirs: [] as string[],
  phpExcludeDirs: ['vendor', 'node_modules'],
  phpExtensions: ['php'],
  phpAutoloader: 'vendor/autoload.php',
  phpBaseBranch: '',
  phpMaxChangedFiles: 6000,
  phpactorOptions: {} as Record<string, unknown>,
  scriptExcludeDirs: ['node_modules', 'dist', 'build', 'coverage', 'vendor'],
  oxlintConfig: '',
};

export const CODE_USER_DEFAULTS = {
  phpBaseOnStart: true,
  codeIdleMinutes: 10,
  phpactorPath: '',
  oxlintPath: '',
  phpPath: 'php',
};

const clean = (list: readonly string[]): string[] =>
  [...new Set(list.map((s) => s.trim().replace(/^\.?\/+|\/+$/g, '')).filter(Boolean))];

/** The worktrees directory's first segment, when it lives inside the repo (`.worktrees`, not `../wt`). */
const worktreesTop = (dir: string): string | undefined => {
  const top = dir.trim().replace(/^\.\/+/, '').split('/')[0];
  return top && top !== '..' && !dir.startsWith('/') && !dir.startsWith('~') ? top : undefined;
};

export function codeConfigOf(c: StackConfig): CodeConfig {
  const always = ['.git', ...(worktreesTop(c.worktreesDirectory ?? '') ? [worktreesTop(c.worktreesDirectory)!] : [])];
  return {
    php: {
      enabled: c.phpNavigation,
      dirs: clean(c.phpIndexDirs),
      exclude: clean([...always, ...c.phpExcludeDirs]),
      extensions: clean(c.phpExtensions.map((e) => e.replace(/^\*?\./, ''))),
      autoloader: c.phpAutoloader.trim() || CODE_DEFAULTS.phpAutoloader,
      baseBranch: c.phpBaseBranch.trim() || c.defaultBaseBranch,
      maxChangedFiles: c.phpMaxChangedFiles,
      phpactorOptions: c.phpactorOptions,
      buildBaseOnStart: c.phpBaseOnStart,
    },
    scripts: { exclude: clean([...always, ...c.scriptExcludeDirs]), oxlintConfig: c.oxlintConfig.trim() },
    tools: { phpactor: c.phpactorPath.trim(), oxlint: c.oxlintPath.trim(), php: c.phpPath.trim() || 'php' },
    idleMs: Math.max(1, c.codeIdleMinutes) * 60_000,
  };
}

/** The defaults as a CodeConfig, for callers without settings (tests, scripts). */
export function defaultCodeConfig(overrides: Partial<StackConfig> = {}): CodeConfig {
  return codeConfigOf({
    worktreesDirectory: '.worktrees', defaultBaseBranch: 'develop', ...CODE_DEFAULTS, ...CODE_USER_DEFAULTS, ...overrides,
  } as StackConfig);
}

/** Which tracked files are the PHP Phpactor sees: by extension, outside the excluded tops, inside `dirs` when set. */
export interface PhpFilter { dirs: string[]; exclude: string[]; extensions: string[] }

export const phpFilterOf = (c: CodeConfig): PhpFilter => ({ dirs: c.php.dirs, exclude: c.php.exclude, extensions: c.php.extensions });

export const isPhpFile = (f: PhpFilter, file: string): boolean => f.extensions.some((e) => file.endsWith(`.${e}`));

/** Whether a repo-relative file is one Phpactor indexes. */
export function phpWanted(f: PhpFilter, file: string): boolean {
  if (!isPhpFile(f, file)) return false;
  if (f.exclude.some((x) => file === x || file.startsWith(`${x}/`))) return false;
  return !f.dirs.length || f.dirs.some((d) => file === d || file.startsWith(`${d}/`));
}

/** git pathspecs for the PHP files: `*.php`, `*.phtml`… */
export const phpPathspecs = (f: PhpFilter): string[] => f.extensions.map((e) => `*.${e}`);

/**
 * The top-level entries Phpactor is started on: those holding wanted PHP (or the configured `dirs` that exist
 * among them), plus Composer's files. `files` are repo-relative.
 */
export function phpTopsOf(f: PhpFilter, files: Iterable<string>): string[] {
  const tops = new Set<string>();
  for (const file of files) {
    if (file === 'composer.json' || file === 'composer.lock') tops.add(file);
    else if (phpWanted(f, file)) tops.add(f.dirs.find((d) => file === d || file.startsWith(`${d}/`)) ?? file.split('/')[0]);
  }
  return [...tops].sort();
}
