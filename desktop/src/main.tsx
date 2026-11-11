import React from 'react';
import { createRoot } from 'react-dom/client';
import './theme/vscode-theme.css';
import './styles.css';
import './sidebar/webviewStyles';
import { App } from './App';
import { DevSidebar } from './sidebar/DevSidebar';
import { StackdProvider } from './stackd/useStackd';
import { TerminalsProvider } from './terminals';
import { installLogging } from './log';

installLogging();

// `/?dev=sidebar`: the sidebar alone on a fixed sample state (see sidebar/DevSidebar.tsx).
const dev = new URLSearchParams(location.search).get('dev') === 'sidebar';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {dev ? (
      <DevSidebar />
    ) : (
      <StackdProvider>
        <TerminalsProvider>
          <App />
        </TerminalsProvider>
      </StackdProvider>
    )}
  </React.StrictMode>,
);
