import { createRoot } from 'react-dom/client';
import { App } from './App';
// Inter with its optical sizes, bundled, so Quillipi looks the same on every computer and offline.
import '@fontsource-variable/inter/opsz.css';
import './index.css';

createRoot(document.getElementById('root')!).render(<App />);
