/**
 * Shared vscode API mock for unit tests (aliased via vitest.config.ts).
 * Keep it minimal but complete: every vscode symbol the src/ files import
 * must exist here, as a vi.fn() or a plain data structure tests can inspect
 * and override. Tests reset state via `resetVscodeMock()` in beforeEach.
 */
import { vi } from 'vitest';

// ── EventEmitter ─────────────────────────────────────────────────────────────
export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
  };
  fire(data: T): void {
    for (const l of [...this.listeners]) l(data);
  }
  dispose(): void {
    this.listeners = [];
  }
}

// ── Uri ──────────────────────────────────────────────────────────────────────
export class Uri {
  constructor(public scheme: string, public fsPath: string) {}
  static file(p: string): Uri { return new Uri('file', p); }
  static parse(value: string): Uri {
    const [scheme, rest] = value.split('://');
    return new Uri(scheme, rest ?? value);
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(base.scheme, [base.fsPath, ...parts].join('/'));
  }
  toString(): string { return `${this.scheme}://${this.fsPath}`; }
}

// ── Enums / value types ──────────────────────────────────────────────────────
export enum TerminalLocation { Panel = 1, Editor = 2 }
export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }

export class ThemeIcon {
  constructor(public id: string, public color?: ThemeColor) {}
}
export class ThemeColor {
  constructor(public id: string) {}
}
export class TreeItem {
  label?: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: unknown;
  command?: unknown;
  collapsibleState?: TreeItemCollapsibleState;
  constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}
export class FileDecoration {
  constructor(public badge?: string, public tooltip?: string, public color?: ThemeColor) {}
}
export class TabInputText {
  constructor(public uri: Uri) {}
}

// ── Debug / breakpoints ──────────────────────────────────────────────────────
export class Position {
  constructor(public line: number, public character: number) {}
}
export class Range {
  constructor(public start: Position, public end: Position) {}
}
export class Location {
  range: Range;
  constructor(public uri: Uri, rangeOrPosition: Range | Position) {
    this.range = rangeOrPosition instanceof Range ? rangeOrPosition : new Range(rangeOrPosition, rangeOrPosition);
  }
}
export class SourceBreakpoint {
  constructor(
    public location: Location,
    public enabled: boolean = true,
    public condition?: string,
    public hitCondition?: string,
    public logMessage?: string,
  ) {}
}
export class FunctionBreakpoint {
  constructor(public functionName: string, public enabled: boolean = true) {}
}
export const debug = {
  breakpoints: [] as Array<SourceBreakpoint | FunctionBreakpoint>,
  addBreakpoints: vi.fn((bps: Array<SourceBreakpoint | FunctionBreakpoint>) => { debug.breakpoints.push(...bps); }),
  removeBreakpoints: vi.fn((bps: Array<SourceBreakpoint | FunctionBreakpoint>) => {
    debug.breakpoints = debug.breakpoints.filter((b) => !bps.includes(b));
  }),
};

// ── Fake terminal factory ────────────────────────────────────────────────────
export interface MockTerminal {
  name: string;
  exitStatus: undefined | { code: number | undefined };
  show: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
  creationOptions: Record<string, unknown>;
}
export function makeTerminal(options: Record<string, unknown> = {}): MockTerminal {
  const t: MockTerminal = {
    name: (options['name'] as string) ?? 'term',
    exitStatus: undefined,
    show: vi.fn(),
    dispose: vi.fn(),
    sendText: vi.fn(),
    creationOptions: options,
  };
  t.dispose.mockImplementation(() => { t.exitStatus = { code: 0 }; });
  return t;
}

// ── window ───────────────────────────────────────────────────────────────────
export const window = {
  terminals: [] as MockTerminal[],
  activeTerminal: undefined as MockTerminal | undefined,
  activeTextEditor: undefined as { document: { uri: Uri } } | undefined,
  tabGroups: {
    all: [] as Array<{ tabs: Array<{ input: unknown }> }>,
    close: vi.fn().mockResolvedValue(true),
    onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
  },
  createTerminal: vi.fn((options: Record<string, unknown>) => {
    const t = makeTerminal(options);
    window.terminals.push(t);
    return t;
  }),
  showTextDocument: vi.fn().mockResolvedValue(undefined),
  showErrorMessage: vi.fn().mockResolvedValue(undefined),
  showWarningMessage: vi.fn().mockResolvedValue(undefined),
  showInformationMessage: vi.fn().mockResolvedValue(undefined),
  showInputBox: vi.fn().mockResolvedValue(undefined),
  showOpenDialog: vi.fn().mockResolvedValue(undefined),
  withProgress: vi.fn(async (_opts: unknown, task: (progress: { report: (v: unknown) => void }) => Promise<unknown>) =>
    task({ report: vi.fn() })),
  onDidChangeActiveTerminal: vi.fn(() => ({ dispose: vi.fn() })),
  onDidCloseTerminal: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
  registerFileDecorationProvider: vi.fn(() => ({ dispose: vi.fn() })),
  registerWebviewViewProvider: vi.fn(() => ({ dispose: vi.fn() })),
  createWebviewPanel: vi.fn(),
};

export const ViewColumn = { Active: -1, Beside: -2, One: 1 } as const;

// ── workspace ────────────────────────────────────────────────────────────────
export const workspace = {
  workspaceFolders: undefined as Array<{ uri: Uri; name: string; index: number }> | undefined,
  updateWorkspaceFolders: vi.fn(),
  saveAll: vi.fn().mockResolvedValue(true),
  getConfiguration: vi.fn((_section?: string) => ({
    get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
  })),
  onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
};

// ── commands / env ───────────────────────────────────────────────────────────
export const commands = {
  executeCommand: vi.fn().mockResolvedValue(undefined),
  registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
};
export const env = {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  openExternal: vi.fn().mockResolvedValue(true),
};

// ── Fake Memento (globalState) ───────────────────────────────────────────────
export class FakeMemento {
  private data = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, value);
  }
  keys(): readonly string[] { return [...this.data.keys()]; }
}

// ── reset helper ─────────────────────────────────────────────────────────────
export function resetVscodeMock(): void {
  debug.breakpoints = [];
  window.terminals = [];
  window.activeTerminal = undefined;
  window.activeTextEditor = undefined;
  window.tabGroups.all = [];
  workspace.workspaceFolders = undefined;
  vi.clearAllMocks();
  window.tabGroups.close.mockResolvedValue(true);
  window.withProgress.mockImplementation(async (_o: unknown, task: (p: { report: (v: unknown) => void }) => Promise<unknown>) =>
    task({ report: vi.fn() }));
  window.createTerminal.mockImplementation((options: Record<string, unknown>) => {
    const t = makeTerminal(options);
    window.terminals.push(t);
    return t;
  });
  workspace.getConfiguration.mockImplementation((_section?: string) => ({
    get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
  }));
}
