import { useEffect, useMemo, useState } from 'react';
import { httpBackend } from './api';
import { CodeBrowser } from './CodeBrowser';

/**
 * SPIKE (docs/spikes/code-browser.md). Dev-only page: the code browser against
 * `desktop/scripts/code-dev-server.mjs`, without the app or stackd.
 *   /?dev=code[&api=http://127.0.0.1:1431][&root=/abs/worktree][&file=src/a.ts][&line=12]
 */
export default function DevCode() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const backend = useMemo(() => httpBackend(params.get('api') ?? 'http://127.0.0.1:1431'), [params]);
  const [roots, setRoots] = useState<Array<{ root: string; name: string }>>([]);
  const [root, setRoot] = useState(params.get('root') ?? '');
  const [error, setError] = useState('');

  useEffect(() => {
    document.documentElement.classList.add('fm-aside'); // the palette the app's chrome uses (App.tsx)
    backend.roots()
      .then((r) => { setRoots(r); setRoot((cur) => cur || r[0]?.root || ''); })
      .catch(() => setError('The dev backend is not running: node desktop/scripts/code-dev-server.mjs --root <worktree>'));
  }, [backend]);

  return (
    <div className="dev-code">
      <div className="dev-code-head">
        <span>Code (spike)</span>
        <select value={root} onChange={(e) => setRoot(e.target.value)} aria-label="Worktree">
          {roots.map((r) => <option key={r.root} value={r.root}>{r.name}</option>)}
        </select>
        <span>{error || root}</span>
      </div>
      <div className="dev-code-body">
        {root && <CodeBrowser backend={backend} root={root} initialFile={params.get('file') ?? undefined} initialLine={Number(params.get('line')) || undefined} />}
      </div>
    </div>
  );
}
