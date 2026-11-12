import React from 'react';
import { createRoot } from 'react-dom/client';
import './theme/vscode-theme.css';
import './styles.css';
import './sidebar/webviewStyles';
import { App } from './App';
import { DevSidebar } from './sidebar/DevSidebar';
import { StackdProvider } from './stackd/useStackd';
import { BootGate, DevBoot } from './boot/BootGate';
import { graphOf } from './boot/bootModel';
import { sampleState } from './sidebar/fixtures';
import { TerminalsProvider } from './terminals';
import { installLogging } from './log';

installLogging();

// `/?dev=sidebar`: the sidebar alone on a fixed sample state (see sidebar/DevSidebar.tsx).
const devMode = new URLSearchParams(location.search).get('dev');
const dev = devMode === 'sidebar';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {devMode === 'boot' ? (
      <DevBoot graph={graphOf({ seq: 0, tmux: {}, repos: [{ repoRoot: '/r/big-app', state: sampleState() }] })} />
    ) : dev ? (
      <DevSidebar />
    ) : (
      <StackdProvider>
        <TerminalsProvider>
          <App />
        </TerminalsProvider>
        <BootGate />
      </StackdProvider>
    )}
  </React.StrictMode>,
);
