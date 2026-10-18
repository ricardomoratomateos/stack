import { describe, it, expect } from 'vitest';
import { parseContainerList, parseLabels, parsePublishedPorts, expandPortSpec } from '../../src/docker/containers';

const psLine = (over: Record<string, unknown> = {}) => JSON.stringify({
  Names: 'feat-a-1a2b3c-web-1',
  State: 'running',
  Status: 'Up 5 minutes',
  Labels: 'com.docker.compose.project=feat-a-1a2b3c,com.docker.compose.service=web',
  Ports: '0.0.0.0:20000->80/tcp, :::20000->80/tcp',
  ...over,
});

describe('parseContainerList — docker ps --format {{json .}} (NDJSON)', () => {
  it('reads project and service from the labels and host ports from the Ports column', () => {
    expect(parseContainerList(psLine())).toEqual([{
      project: 'feat-a-1a2b3c',
      name: 'feat-a-1a2b3c-web-1',
      state: 'running',
      service: 'web',
      status: 'Up 5 minutes',
      ports: [20000],
    }]);
  });

  it('keeps exited and created containers, with the exit code of an exited one', () => {
    const out = [
      psLine({ Names: 'db', State: 'exited', Status: 'Exited (137) 2 minutes ago', Ports: '' }),
      psLine({ Names: 'api', State: 'created', Status: 'Created', Ports: '' }),
    ].join('\n');
    const [db, api] = parseContainerList(out);
    expect(db).toMatchObject({ name: 'db', state: 'exited', exitCode: 137 });
    expect(api).toMatchObject({ name: 'api', state: 'created' });
    expect(api.exitCode).toBeUndefined();
  });

  it('lowercases the state, which old engines capitalised', () => {
    expect(parseContainerList(psLine({ State: 'Running' }))[0].state).toBe('running');
  });

  it('drops containers that no compose project owns', () => {
    expect(parseContainerList(psLine({ Labels: 'maintainer=me' }))).toEqual([]);
  });

  it('skips malformed lines and keeps the rest', () => {
    expect(parseContainerList(`not-json\n${psLine()}`)).toHaveLength(1);
  });

  it('takes the first of several comma-joined names, and survives none at all', () => {
    expect(parseContainerList(psLine({ Names: 'a,b' }))[0].name).toBe('a');
    expect(parseContainerList(psLine({ Names: undefined }))[0].name).toBe('unknown');
  });

  it('survives a row with no state, status or labels string', () => {
    const [c] = parseContainerList(JSON.stringify({ Project: 'p', Name: 'n' }));
    expect(c).toEqual({ project: 'p', name: 'n', state: 'unknown', ports: [] });
  });

  it('returns nothing for empty output', () => {
    expect(parseContainerList('  \n ')).toEqual([]);
  });
});

describe('parseContainerList — docker compose ps --format json', () => {
  const row = { Name: 'web-1', Project: 'proj', Service: 'web', State: 'exited', ExitCode: 1, Publishers: [{ PublishedPort: 8080 }, { PublishedPort: 0 }] };

  it('reads the JSON array shape (Compose >= 2.21)', () => {
    expect(parseContainerList(JSON.stringify([row]))).toEqual([{
      project: 'proj', name: 'web-1', state: 'exited', service: 'web', exitCode: 1, ports: [8080],
    }]);
  });

  it('reads the NDJSON shape (Compose < 2.21)', () => {
    expect(parseContainerList(`${JSON.stringify(row)}\n${JSON.stringify({ ...row, Name: 'db-1' })}`)).toHaveLength(2);
  });

  it('accepts labels as an object and a publisher without a port', () => {
    const [c] = parseContainerList(JSON.stringify([{ Name: 'x', State: 'running', Labels: { 'com.docker.compose.project': 'p' }, Publishers: [{}] }]));
    expect(c).toMatchObject({ project: 'p', ports: [] });
  });

  it('returns nothing for a broken array', () => {
    expect(parseContainerList('[{"Name": broken')).toEqual([]);
  });
});

describe('parseLabels', () => {
  it('keeps a comma-joined label value together (config_files lists several paths)', () => {
    expect(parseLabels('com.docker.compose.project.config_files=/a/b.yml,/a/c.yml,com.docker.compose.project=p')).toEqual({
      'com.docker.compose.project.config_files': '/a/b.yml,/a/c.yml',
      'com.docker.compose.project': 'p',
    });
  });

  it('ignores a leading fragment with no key', () => {
    expect(parseLabels('stray,a=1')).toEqual({ a: '1' });
  });
});

describe('parsePublishedPorts', () => {
  it('collects host ports across IPv4, IPv6 and loopback bindings, deduplicated', () => {
    expect(parsePublishedPorts('0.0.0.0:8080->80/tcp, :::8080->80/tcp, 127.0.0.1:5432->5432/tcp')).toEqual([8080, 5432]);
  });

  it('expands a published range', () => {
    expect(parsePublishedPorts('0.0.0.0:9000-9002->9000-9002/tcp')).toEqual([9000, 9001, 9002]);
  });

  it('skips exposed-but-unpublished ports', () => {
    expect(parsePublishedPorts('5432/tcp')).toEqual([]);
  });
});

describe('expandPortSpec', () => {
  it.each([
    ['8080', [8080]],
    ['8000-8001', [8000, 8001]],
    ['', []],
    ['abc', []],
    ['0', []],
    ['9-3', []],
    ['1-5000', []],
  ])('%s → %o', (spec, ports) => {
    expect(expandPortSpec(spec)).toEqual(ports);
  });
});
