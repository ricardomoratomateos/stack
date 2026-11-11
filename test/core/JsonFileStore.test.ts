import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonFileStore } from '../../src/core/JsonFileStore';
import { Emitter } from '../../src/core/Emitter';

describe('JsonFileStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-store-'));
    file = path.join(dir, 'nested', 'state.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns the default for a missing key and a missing file', () => {
    const store = new JsonFileStore(file);
    expect(store.get('a', 42)).toBe(42);
  });

  it('persists values across instances', async () => {
    await new JsonFileStore(file).update('a', { x: [1, 2] });
    expect(new JsonFileStore(file).get('a', null)).toEqual({ x: [1, 2] });
  });

  it('does not leak references to stored values', async () => {
    const store = new JsonFileStore(file);
    const value = { n: 1 };
    await store.update('k', value);
    value.n = 2;
    expect(store.get<{ n: number }>('k', { n: 0 }).n).toBe(1);
  });

  it('removes a key when updated with undefined', async () => {
    const store = new JsonFileStore(file);
    await store.update('a', 1);
    await store.update('a', undefined);
    expect(new JsonFileStore(file).get('a', 'gone')).toBe('gone');
  });

  it('starts empty when the file is corrupt', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    expect(new JsonFileStore(file).get('a', 'd')).toBe('d');
  });

  it('keeps every key when updates are not awaited', async () => {
    const store = new JsonFileStore(file);
    void store.update('a', 1);
    await store.update('b', 2);
    const reread = new JsonFileStore(file);
    expect([reread.get('a', 0), reread.get('b', 0)]).toEqual([1, 2]);
  });
});

describe('Emitter', () => {
  it('fires to listeners and stops after dispose', () => {
    const e = new Emitter<number>();
    const seen: number[] = [];
    const sub = e.event((n) => seen.push(n));
    e.fire(1);
    sub.dispose();
    e.fire(2);
    expect(seen).toEqual([1]);
  });
});
