/**
 * HTML Export Module
 *
 * Generates self-contained HTML files with embedded JSON and SPA loader.
 * AC: @gh-pages-export ac-6
 */

import type { KspecSnapshot } from "./types.js";

/**
 * Generate a self-contained HTML file with embedded JSON snapshot.
 *
 * The HTML includes:
 * - Embedded JSON data in a script tag
 * - Redirect to hosted SPA (or minimal inline viewer)
 * - Fallback for viewing raw data
 *
 * AC: @gh-pages-export ac-6
 */
export function generateHtmlExport(snapshot: KspecSnapshot): string {
  const jsonData = JSON.stringify(snapshot, null, 2);
  const escapedJson = jsonData
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(snapshot.project.name)} - kspec Export</title>
  <style>
    :root {
      --bg: #1a1a2e;
      --fg: #eee;
      --accent: #4ade80;
      --muted: #666;
      --border: #333;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--fg);
      line-height: 1.6;
      padding: 2rem;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border);
    }
    h1 { font-size: 1.5rem; font-weight: 600; }
    .meta { color: var(--muted); font-size: 0.875rem; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 500;
    }
    .badge.valid { background: rgba(74, 222, 128, 0.2); color: var(--accent); }
    .badge.invalid { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .stat {
      background: rgba(255, 255, 255, 0.05);
      padding: 1rem;
      border-radius: 0.5rem;
      border: 1px solid var(--border);
    }
    .stat-value { font-size: 2rem; font-weight: 700; color: var(--accent); }
    .stat-label { color: var(--muted); font-size: 0.875rem; }
    .section { margin-bottom: 2rem; }
    .section-title {
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .list { display: flex; flex-direction: column; gap: 0.5rem; }
    .item {
      background: rgba(255, 255, 255, 0.05);
      padding: 1rem;
      border-radius: 0.5rem;
      border: 1px solid var(--border);
    }
    .item-title { font-weight: 500; }
    .item-meta { color: var(--muted); font-size: 0.875rem; }
    .status {
      display: inline-block;
      padding: 0.125rem 0.5rem;
      border-radius: 0.25rem;
      font-size: 0.75rem;
      font-weight: 500;
    }
    .status-pending { background: rgba(251, 191, 36, 0.2); color: #fbbf24; }
    .status-in_progress { background: rgba(59, 130, 246, 0.2); color: #3b82f6; }
    .status-pending_review { background: rgba(168, 85, 247, 0.2); color: #a855f7; }
    .status-completed { background: rgba(74, 222, 128, 0.2); color: #4ade80; }
    .status-cancelled { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
    .status-blocked { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
    .read-only-banner {
      background: rgba(251, 191, 36, 0.2);
      color: #fbbf24;
      padding: 0.75rem 1rem;
      border-radius: 0.5rem;
      margin-bottom: 1rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    footer {
      margin-top: 2rem;
      padding-top: 1rem;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 0.875rem;
      text-align: center;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>${escapeHtml(snapshot.project.name)}</h1>
        <div class="meta">
          Exported: ${new Date(snapshot.exported_at).toLocaleString()}
          ${snapshot.project.version ? ` • v${escapeHtml(snapshot.project.version)}` : ""}
        </div>
      </div>
      ${snapshot.validation ? `
        <span class="badge ${snapshot.validation.valid ? "valid" : "invalid"}">
          ${snapshot.validation.valid ? "✓ Valid" : `✗ ${snapshot.validation.errorCount} errors`}
        </span>
      ` : ""}
    </header>

    <div class="read-only-banner">
      <span>📖</span>
      <span>Read-only view. Use the kspec CLI to make changes.</span>
    </div>

    <div class="stats">
      <div class="stat">
        <div class="stat-value">${snapshot.tasks.length}</div>
        <div class="stat-label">Tasks</div>
      </div>
      <div class="stat">
        <div class="stat-value">${snapshot.items.length}</div>
        <div class="stat-label">Spec Items</div>
      </div>
      <div class="stat">
        <div class="stat-value">${snapshot.inbox.length}</div>
        <div class="stat-label">Inbox Items</div>
      </div>
      <div class="stat">
        <div class="stat-value">${snapshot.observations.length}</div>
        <div class="stat-label">Observations</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Recent Tasks</div>
      <div class="list">
        ${snapshot.tasks.slice(0, 10).map(task => `
          <div class="item">
            <div class="item-title">
              <span class="status status-${task.status}">${task.status}</span>
              ${escapeHtml(task.title)}
            </div>
            <div class="item-meta">
              @${task.slugs[0] || task._ulid.slice(0, 8)}
              ${task.spec_ref_title ? ` • ${escapeHtml(task.spec_ref_title)}` : ""}
            </div>
          </div>
        `).join("")}
        ${snapshot.tasks.length > 10 ? `<div class="item-meta">... and ${snapshot.tasks.length - 10} more tasks</div>` : ""}
      </div>
    </div>

    <div class="section">
      <div class="section-title">Spec Items</div>
      <div class="list">
        ${snapshot.items.slice(0, 10).map(item => `
          <div class="item">
            <div class="item-title">${escapeHtml(item.title)}</div>
            <div class="item-meta">
              ${item.type || "item"} • @${item.slugs[0] || item._ulid.slice(0, 8)}
              ${item.acceptance_criteria?.length ? ` • ${item.acceptance_criteria.length} ACs` : ""}
            </div>
          </div>
        `).join("")}
        ${snapshot.items.length > 10 ? `<div class="item-meta">... and ${snapshot.items.length - 10} more items</div>` : ""}
      </div>
    </div>

    <footer>
      Generated by <a href="https://github.com/chapel/kynetic-spec">kspec</a> v${escapeHtml(snapshot.version)}
    </footer>
  </div>

  <!-- Embedded snapshot data -->
  <script id="kspec-data" type="application/json">
${escapedJson}
  </script>

  <script>
    // Make snapshot available globally
    window.KSPEC_STATIC_DATA = JSON.parse(document.getElementById('kspec-data').textContent);
  </script>
</body>
</html>`;
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
