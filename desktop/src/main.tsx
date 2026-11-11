import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { StackdProvider } from './stackd/useStackd';
import { TerminalsProvider } from './terminals';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StackdProvider>
      <TerminalsProvider>
        <App />
      </TerminalsProvider>
    </StackdProvider>
  </React.StrictMode>,
);
