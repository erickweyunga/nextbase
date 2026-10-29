import './style.css';

// The admin UI is served at `<basePath>/_`, so the API root is its parent.
const apiRoot = new URL(
  `${window.location.pathname.replace(/\/_\/?$/, '')}/`,
  window.location.origin,
);

const statusEl = document.querySelector<HTMLSpanElement>('#status');

async function checkHealth(): Promise<void> {
  if (!statusEl) return;
  try {
    const response = await fetch(new URL('health', apiRoot));
    statusEl.textContent = response.ok ? 'ok' : `error ${response.status}`;
  } catch {
    statusEl.textContent = 'unreachable';
  }
}

void checkHealth();
