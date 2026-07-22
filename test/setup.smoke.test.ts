import { describe, it, expect, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { resetVscodeMock, FakeMemento } from './__mocks__/vscode';

describe('test harness smoke', () => {
  beforeEach(() => resetVscodeMock());

  it('vscode mock is aliased and usable', () => {
    const emitter = new vscode.EventEmitter<string>();
    let received = '';
    emitter.event(v => { received = v; });
    emitter.fire('ok');
    expect(received).toBe('ok');
    expect(vscode.Uri.file('/tmp/x').fsPath).toBe('/tmp/x');
  });

  it('FakeMemento round-trips values', async () => {
    const m = new FakeMemento();
    expect(m.get('missing', 'default')).toBe('default');
    await m.update('k', { a: 1 });
    expect(m.get('k')).toEqual({ a: 1 });
  });

  it('src modules importing vscode load under the mock', async () => {
    const { ConfigManager } = await import('../src/config/ConfigManager');
    const cfg = new ConfigManager().get();
    expect(cfg.xdebugBasePort).toBe(9898);
    expect(cfg.claudeCommand).toBe('claude');
  });
});
