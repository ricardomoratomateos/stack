import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ConfigFileError,
  displayPath,
  readJsonObject,
  syntaxErrorLocation,
  writeFileAtomic,
} from '../../../src/providers/shared/configFile';

// Auto-spy on node:fs (real implementations kept) so a write can fail halfway.
vi.mock('node:fs', { spy: true });

const fsError = (code: string) => Object.assign(new Error(code), { code });

describe('configFile', () => {
  describe('syntaxErrorLocation', () => {
    const locate = (text: string) => {
      try { JSON.parse(text); } catch (e) { return syntaxErrorLocation(text, e); }
      return 'parsed';
    };

    it('turns the parser offset into a 1-based line and column', () => {
      expect(locate('{\n  "a": 1,\n  oops\n}')).toBe('line 3, column 3');
    });

    it('works on the first line', () => {
      expect(locate('{ broken')).toMatch(/^line 1, column \d+$/);
    });

    it('is undefined when the error carries no offset', () => {
      expect(syntaxErrorLocation('x', new Error('Unexpected end'))).toBeUndefined();
    });

    it('reads the offset from something thrown that is not an Error', () => {
      expect(syntaxErrorLocation('{\n x', 'bad token at position 3')).toBe('line 2, column 2');
    });
  });

  describe('displayPath', () => {
    it('abbreviates the home directory', () => {
      expect(displayPath(path.join('/home/u', '.claude', 'settings.json'), '/home/u')).toBe('~/.claude/settings.json');
    });

    it('leaves other paths alone, including a lookalike prefix', () => {
      expect(displayPath('/home/user2/x.json', '/home/u')).toBe('/home/user2/x.json');
    });
  });

  describe('files', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-configfile-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    it('reports a syntax error with no location when the parser gives none', () => {
      const file = path.join(dir, 'settings.json');
      fs.writeFileSync(file, '{"model":');
      expect(() => readJsonObject(file, 'install its hooks')).toThrow(ConfigFileError);
      expect(() => readJsonObject(file, 'install its hooks')).toThrow(/has a syntax error\. The file was left untouched/);
    });

    it('a write that fails halfway leaves the file as it was, and no temp file behind', () => {
      const file = path.join(dir, 'settings.json');
      fs.writeFileSync(file, '{"a":1}');
      vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw fsError('EXDEV'); });
      expect(() => writeFileAtomic(file, '{"a":2}')).toThrow('EXDEV');
      expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
      expect(fs.readdirSync(dir)).toEqual(['settings.json']);
    });

    it('reports the failed write, not a failed cleanup after it', () => {
      const file = path.join(dir, 'settings.json');
      vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw fsError('EXDEV'); });
      vi.mocked(fs.rmSync).mockImplementationOnce(() => { throw fsError('EACCES'); });
      expect(() => writeFileAtomic(file, '{}')).toThrow('EXDEV');
    });
  });
});
