import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles/tailwind.css';
import './styles/board.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing <div id="root">');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
