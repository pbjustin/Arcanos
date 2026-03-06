export interface MemoryTablePageEntry {
  key: string;
  value: unknown;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryTablePageModel {
  entries: MemoryTablePageEntry[];
  prefix: string | null;
  limit: number;
  generatedAtIso: string;
  jsonViewPath: string;
  listPath: string;
}

const VALUE_PREVIEW_CHAR_LIMIT = 1600;
const METADATA_PREVIEW_CHAR_LIMIT = 600;

/**
 * Escape HTML-special characters before rendering user-controlled text.
 * Inputs/outputs: raw string in, escaped string out.
 * Edge cases: empty strings remain empty.
 */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Convert unknown values into stable string form for table preview cells.
 * Inputs/outputs: unknown value in, JSON/text representation out.
 * Edge cases: non-serializable objects fall back to String(value).
 */
function toDisplayString(value: unknown): string {
  //audit Assumption: strings should render as-is for readability; failure risk: unnecessary JSON quotes; expected invariant: plain text stays plain text; handling strategy: direct return for string payloads.
  if (typeof value === 'string') {
    return value;
  }

  try {
    const serialized = JSON.stringify(value, null, 2);
    //audit Assumption: JSON.stringify can return undefined (e.g., undefined input); failure risk: empty preview cells; expected invariant: always render textual content; handling strategy: fallback string conversion.
    if (typeof serialized === 'string') {
      return serialized;
    }
    return String(value);
  } catch {
    //audit Assumption: circular structures are uncommon but possible; failure risk: renderer crash; expected invariant: page still renders; handling strategy: catch serialization errors and stringify safely.
    return String(value);
  }
}

/**
 * Build a bounded preview string and truncation marker for long values.
 * Inputs/outputs: unknown value + max chars, escaped preview metadata.
 * Edge cases: values under the threshold remain untouched.
 */
function buildPreview(value: unknown, maxChars: number): { preview: string; truncated: boolean } {
  const displayString = toDisplayString(value);

  //audit Assumption: preview limits protect page performance with large payloads; failure risk: oversized responses; expected invariant: output stays within predictable bounds; handling strategy: truncate and annotate.
  if (displayString.length <= maxChars) {
    return {
      preview: escapeHtml(displayString),
      truncated: false
    };
  }

  return {
    preview: escapeHtml(`${displayString.slice(0, maxChars)}...`),
    truncated: true
  };
}

/**
 * Normalize date/time display values in the table.
 * Inputs/outputs: raw date string in, ISO date string out.
 * Edge cases: invalid dates are rendered as escaped raw strings.
 */
function formatDateCell(rawDate: string): string {
  const parsedDate = new Date(rawDate);
  //audit Assumption: database timestamps should be parseable; failure risk: rendering "Invalid Date"; expected invariant: valid ISO or safe fallback text; handling strategy: parse and guard.
  if (Number.isNaN(parsedDate.getTime())) {
    return escapeHtml(String(rawDate));
  }
  return parsedDate.toISOString();
}

/**
 * Build a query-string that preserves the current table filters.
 * Inputs/outputs: current prefix + limit, URL query string.
 * Edge cases: empty prefix is omitted.
 */
function buildFilterQueryString(prefix: string | null, limit: number): string {
  const params = new URLSearchParams();
  params.set('limit', String(limit));

  //audit Assumption: optional prefix should only be sent when present; failure risk: noisy empty params; expected invariant: stable bookmarkable URLs; handling strategy: conditional inclusion.
  if (prefix) {
    params.set('prefix', prefix);
  }

  return params.toString();
}

/**
 * Render the full HTML page for the memory table UI endpoint.
 * Inputs/outputs: table model in, complete HTML document string out.
 * Edge cases: empty entries render a "No rows found" state.
 */
export function renderMemoryTablePage(model: MemoryTablePageModel): string {
  const prefixValue = model.prefix ?? '';
  const filterQueryString = buildFilterQueryString(model.prefix, model.limit);
  const jsonViewHref = `${model.jsonViewPath}?${filterQueryString}`;
  const apiListHref = `${model.listPath}?${filterQueryString}`;

  const rowsHtml = model.entries
    .map((entry, index) => {
      const valuePreview = buildPreview(entry.value, VALUE_PREVIEW_CHAR_LIMIT);
      const metadataPreview = buildPreview(entry.metadata, METADATA_PREVIEW_CHAR_LIMIT);
      const metadataHtml = entry.metadata
        ? `<pre class="cell-pre">${metadataPreview.preview}</pre>`
        : '<span class="muted">none</span>';

      const rowClass = index % 2 === 0 ? 'row-even' : 'row-odd';
      const truncationBadge = valuePreview.truncated
        ? '<span class="badge" title="Preview is truncated">truncated</span>'
        : '';

      return `
        <tr class="${rowClass}">
          <td class="cell-key">${escapeHtml(entry.key)}</td>
          <td class="cell-value">
            <div class="value-header">${truncationBadge}</div>
            <pre class="cell-pre">${valuePreview.preview}</pre>
          </td>
          <td class="cell-meta">${metadataHtml}</td>
          <td class="cell-date">${formatDateCell(entry.created_at)}</td>
          <td class="cell-date">${formatDateCell(entry.updated_at)}</td>
        </tr>
      `.trim();
    })
    .join('\n');

  const tableBodyHtml = rowsHtml || `
    <tr>
      <td colspan="5" class="empty-state">No memory rows found for this filter.</td>
    </tr>
  `.trim();

  return `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ARCANOS Memory Table</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f7fb;
        --surface: #ffffff;
        --text: #152238;
        --muted: #5f6c80;
        --line: #dbe2ec;
        --accent: #0f766e;
        --accent-soft: #e6f4f2;
        --badge-bg: #fef3c7;
        --badge-text: #92400e;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
        background: radial-gradient(circle at top right, #eef5ff 0%, var(--bg) 52%);
        color: var(--text);
      }

      .container {
        max-width: 1480px;
        margin: 0 auto;
        padding: 20px 18px 28px;
      }

      .header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 18px;
        margin-bottom: 14px;
      }

      h1 {
        margin: 0;
        font-size: 1.45rem;
        font-weight: 700;
      }

      .subtitle {
        margin: 4px 0 0;
        font-size: 0.95rem;
        color: var(--muted);
      }

      .links {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }

      .link {
        color: var(--accent);
        text-decoration: none;
        font-weight: 600;
        font-size: 0.9rem;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        padding: 6px 10px;
      }

      .link:hover {
        background: var(--accent-soft);
      }

      .toolbar {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px;
        margin-bottom: 14px;
      }

      .toolbar form {
        display: grid;
        grid-template-columns: 1fr 120px auto auto;
        gap: 10px;
      }

      label {
        display: block;
        font-size: 0.82rem;
        font-weight: 600;
        color: var(--muted);
        margin-bottom: 4px;
      }

      input {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 8px 10px;
        font-size: 0.95rem;
      }

      button, .clear-link {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 8px 12px;
        font-size: 0.92rem;
        font-weight: 600;
        cursor: pointer;
        background: var(--surface);
        align-self: end;
        text-decoration: none;
        color: var(--text);
      }

      button {
        background: var(--accent);
        border-color: var(--accent);
        color: #ffffff;
      }

      .summary {
        display: flex;
        gap: 14px;
        flex-wrap: wrap;
        font-size: 0.87rem;
        color: var(--muted);
        margin-bottom: 8px;
      }

      .summary strong {
        color: var(--text);
      }

      .table-wrap {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 12px;
        overflow: auto;
      }

      table {
        border-collapse: collapse;
        width: 100%;
        min-width: 1080px;
      }

      thead th {
        position: sticky;
        top: 0;
        background: #eef3fb;
        color: #314460;
        text-align: left;
        font-size: 0.83rem;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        border-bottom: 1px solid var(--line);
        padding: 10px 12px;
      }

      tbody td {
        border-bottom: 1px solid var(--line);
        padding: 10px 12px;
        vertical-align: top;
        font-size: 0.87rem;
      }

      .row-even { background: #ffffff; }
      .row-odd { background: #f9fbff; }
      .cell-key { font-weight: 600; min-width: 260px; word-break: break-word; }
      .cell-value { min-width: 420px; }
      .cell-meta { min-width: 300px; }
      .cell-date { white-space: nowrap; width: 180px; color: var(--muted); }

      .cell-pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: "Cascadia Code", Consolas, "Liberation Mono", monospace;
        font-size: 0.79rem;
        line-height: 1.3;
      }

      .value-header {
        min-height: 22px;
        margin-bottom: 4px;
      }

      .badge {
        display: inline-block;
        font-size: 0.72rem;
        line-height: 1;
        padding: 4px 6px;
        border-radius: 999px;
        background: var(--badge-bg);
        color: var(--badge-text);
        font-weight: 700;
        letter-spacing: 0.01em;
      }

      .muted { color: var(--muted); font-style: italic; }
      .empty-state { text-align: center; color: var(--muted); padding: 26px 10px; }

      @media (max-width: 1024px) {
        .toolbar form {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main class="container">
      <section class="header">
        <div>
          <h1>Memory Table</h1>
          <p class="subtitle">Clean table view for persisted module memory.</p>
        </div>
        <div class="links">
          <a class="link" href="${escapeHtml(jsonViewHref)}">Open JSON View</a>
          <a class="link" href="${escapeHtml(apiListHref)}">Open List API</a>
        </div>
      </section>

      <section class="toolbar">
        <form method="get" action="/api/memory/table">
          <div>
            <label for="prefix">Prefix Filter</label>
            <input id="prefix" name="prefix" value="${escapeHtml(prefixValue)}" placeholder="backstage-storyline" />
          </div>
          <div>
            <label for="limit">Limit</label>
            <input id="limit" name="limit" type="number" min="1" max="1000" value="${model.limit}" />
          </div>
          <button type="submit">Refresh</button>
          <a class="clear-link" href="/api/memory/table">Clear</a>
        </form>
      </section>

      <section class="summary">
        <span><strong>Rows:</strong> ${model.entries.length}</span>
        <span><strong>Prefix:</strong> ${escapeHtml(prefixValue || 'none')}</span>
        <span><strong>Limit:</strong> ${model.limit}</span>
        <span><strong>Generated:</strong> ${escapeHtml(model.generatedAtIso)}</span>
      </section>

      <section class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Value Preview</th>
              <th>Metadata</th>
              <th>Created At</th>
              <th>Updated At</th>
            </tr>
          </thead>
          <tbody>
            ${tableBodyHtml}
          </tbody>
        </table>
      </section>
    </main>
  </body>
</html>
`.trim();
}
