import React from 'react';
import { createRoot } from 'react-dom/client';
import { DevPage } from './DevPage';
import { TerminalsProvider } from './terminals';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TerminalsProvider>
      <DevPage />
    </TerminalsProvider>
  </React.StrictMode>,
);
