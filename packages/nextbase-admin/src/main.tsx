import './style.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import { UIProvider } from './ui/provider/index.ts';

const root = document.getElementById('root');
if (!root) throw new Error('The admin page has no #root element.');

createRoot(root).render(
  <StrictMode>
    <UIProvider>
      <App />
    </UIProvider>
  </StrictMode>,
);
