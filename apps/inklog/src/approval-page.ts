/**
 * The page a person sees when an app asks to use their notebook. It runs no scripts and can't
 * be shown inside another site, and its form can only submit to Quillipi and then return to
 * the app that asked.
 */

export function pageHeaders(returnTo?: string): Record<string, string> {
  const formAction = ["'self'", returnTo ? new URL(returnTo).origin : ''].filter(Boolean).join(' ');
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  };
}

export function approvalPage(details: { notebook: string; app: string; request: string; error?: string }): string {
  const app = escapeHtml(details.app);
  return page(
    `Connect ${app} to Quillipi`,
    `<p><strong>${app}</strong> wants to read and edit your notebook <strong>${escapeHtml(details.notebook)}</strong> and commit its changes. Large deletions will still wait for your review.</p>
    <form method="post" action="/approve">
      <input type="hidden" name="request" value="${escapeHtml(details.request)}">
      <label for="code">Type the code Quillipi is showing on your laptop</label>
      <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus>
      ${details.error ? `<p class="error" role="alert">${escapeHtml(details.error)}</p>` : ''}
      <div class="actions">
        <button type="submit" name="decision" value="approve" class="primary">Approve</button>
        <button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
      </div>
    </form>
    <p class="note">Only approve if you just added Quillipi as a connector yourself.</p>`,
  );
}

export function messagePage(title: string, text: string): string {
  return page(escapeHtml(title), `<p>${escapeHtml(text)}</p>`);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>
  :root { --paper: #fbfcfd; --ink: #18212f; --muted: #5b6676; --line: #c5ccd5; --accent: #2f5bd3; --on-accent: #ffffff; --error: #c2413b; }
  @media (prefers-color-scheme: dark) { :root { --paper: #12161d; --ink: #e6eaf0; --muted: #97a1ae; --line: #3a4352; --accent: #7fa2ff; --on-accent: #0b1220; --error: #f07167; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--paper); color: var(--ink); font: 16px/1.55 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  main { width: min(420px, 100% - 40px); padding: 32px 0; }
  svg { color: var(--accent); }
  h1 { font-size: 1.4rem; line-height: 1.3; margin: 12px 0; }
  label { display: block; margin: 20px 0 6px; font-weight: 600; }
  input { box-sizing: border-box; width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; font-size: 1.5rem; letter-spacing: 0.2em; text-align: center; }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .actions { display: flex; gap: 8px; margin-top: 16px; }
  button { flex: 1; padding: 10px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
  button.primary { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
  .error { color: var(--error); margin: 8px 0 0; }
  .note { color: var(--muted); font-size: 0.9rem; margin-top: 24px; }
</style>
</head>
<body>
<main>
  <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><path d="M16 3c5 7 9 11.5 9 16.5a9 9 0 0 1-18 0C7 14.5 11 10 16 3z" fill="currentColor"/></svg>
  <h1>${title}</h1>
  ${body}
</main>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
