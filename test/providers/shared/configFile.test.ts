import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { displayPath, syntaxErrorLocation } from '../../../src/providers/shared/configFile';

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
  });

  describe('displayPath', () => {
    it('abbreviates the home directory', () => {
      expect(displayPath(path.join('/home/u', '.claude', 'settings.json'), '/home/u')).toBe('~/.claude/settings.json');
    });

    it('leaves other paths alone, including a lookalike prefix', () => {
      expect(displayPath('/home/user2/x.json', '/home/u')).toBe('/home/user2/x.json');
    });
  });
});
