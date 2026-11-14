import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { isMockup } from './lib/api';
import { keepLinksInMockup } from './lib/mockup-links';
import { toast } from './lib/toast';
import './index.css';
import './styles/modes.css';

if (isMockup) {
  keepLinksInMockup((url) =>
    toast({
      tone: 'info',
      key: 'mockup-link',
      title: 'The mockup stays on this page',
      detail: `The panel would open ${url}`,
      action: { label: 'Copy the address', run: () => void navigator.clipboard?.writeText(url).catch(() => undefined) },
    }),
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
