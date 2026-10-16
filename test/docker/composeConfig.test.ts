import { describe, it, expect } from 'vitest';
import { conflictMessage, publishedPorts } from '../../src/docker/composeConfig';

describe('publishedPorts', () => {
  it('lists every published host port of the merged model — base AND override ports', () => {
    // What `docker compose -f base -f override config --format json` returns
    // for a base with "27017:27017" and an override adding "${DB_PORT}:27017":
    // compose concatenates the two lists rather than replacing one with the other.
    const model = {
      services: {
        mongo: { ports: [{ target: 27017, published: '27017' }, { target: 27017, published: '20001' }] },
        web: { ports: [{ target: 80, published: 20000 }] },
      },
    };
    expect(publishedPorts(JSON.stringify(model))).toEqual([
      { service: 'mongo', port: 27017 },
      { service: 'mongo', port: 20001 },
      { service: 'web', port: 20000 },
    ]);
  });

  it('expands ranges and skips ephemeral ports and repeats', () => {
    const model = {
      services: {
        a: { ports: [{ target: 1, published: '9000-9001' }, { target: 2 }, { target: 3, published: '' }] },
        b: { ports: [{ target: 1, published: '9000' }] },
        c: {},
      },
    };
    expect(publishedPorts(JSON.stringify(model)).map((p) => p.port)).toEqual([9000, 9001]);
  });

  it('returns nothing for output that is not JSON, or has no services', () => {
    expect(publishedPorts('services:\n  web: {}')).toEqual([]);
    expect(publishedPorts('{}')).toEqual([]);
  });
});

describe('conflictMessage', () => {
  it('explains the compose merge and both fixes for a hard-coded port', () => {
    const msg = conflictMessage([{ service: 'mongo', port: 27017, heldBy: 'feat-b-123456' }], 'docker-compose.yml');
    expect(msg).toContain('27017 (mongo, held by "feat-b-123456")');
    expect(msg).toContain('docker-compose.yml');
    expect(msg).toContain('!override');
    expect(msg).toContain('!reset');
    expect(msg).toContain('${DB_PORT');
  });

  it('names the variable for a busy generated port', () => {
    expect(conflictMessage([{ service: 'web', port: 20000, foremanVar: 'HTTP_PORT' }], 'c.yml'))
      .toBe('Port 20000 (web) from HTTP_PORT is already in use by something else.');
  });

  it('reports both kinds together', () => {
    const msg = conflictMessage(
      [{ service: 'db', port: 5432 }, { service: 'web', port: 20000, foremanVar: 'HTTP_PORT' }],
      'c.yml',
    );
    expect(msg).toMatch(/5432.*hard-coded.*20000.*HTTP_PORT/s);
  });
});
