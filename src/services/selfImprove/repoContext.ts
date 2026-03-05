import { exec } from "child_process";
import { promisify } from "util";
import { applySecurityCompliance } from "@services/securityCompliance.js";

const execAsync = promisify(exec);

export interface RepoContextOptions {
  keywords: string[];
  workingDir?: string;
  maxFiles?: number;
  maxMatches?: number;
  maxTotalChars?: number;
}

type Snippet = { file: string; matches: Array<{ line: number; text: string }> };

/**
 * Lightweight repo-context grounding:
 * - Uses `git grep -n` over a small keyword set
 * - Captures a few matching lines per file (no OCR/index dependency)
 * - Applies security compliance sanitization on the output
 */
export async function gatherRepoContext(opts: RepoContextOptions): Promise<{ summary: string; snippets: Snippet[] }> {
  const {
    keywords,
    workingDir,
    maxFiles = 6,
    maxMatches = 40,
    maxTotalChars = 8000,
  } = opts;

  const kw = Array.from(new Set((keywords || []).map(k => k.trim()).filter(Boolean))).slice(0, 12);
  if (kw.length === 0) return { summary: "No repo context requested.", snippets: [] };

  // Build a conservative grep query: multiple -e terms (OR).
  const args = kw.map(k => `-e ${shellQuote(k)}`).join(" ");
  const cmd = `git grep -n ${args} -- ':!dist' ':!node_modules' ':!workers/dist'`;

  let stdout = "";
  try {
    const res = await execAsync(cmd, { cwd: workingDir });
    stdout = res.stdout || "";
  } catch (e: any) {
    // git grep exits 1 when no matches; treat as empty.
    stdout = e?.stdout || "";
  }

  const lines = stdout.split("\n").filter(Boolean).slice(0, maxMatches);

  const byFile = new Map<string, Array<{ line: number; text: string }>>();
  for (const line of lines) {
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    const file = m[1];
    const ln = Number(m[2]);
    const text = (m[3] || "").trim().slice(0, 400);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push({ line: ln, text });
  }

  const files = Array.from(byFile.keys()).slice(0, maxFiles);
  const snippets: Snippet[] = [];
  let budget = maxTotalChars;

  for (const file of files) {
    const matches = byFile.get(file) || [];
    const take = matches.slice(0, 8);
    const snippet: Snippet = { file, matches: take };
    const approx = JSON.stringify(snippet).length;
    if (approx > budget) break;
    budget -= approx;
    snippets.push(snippet);
  }

  const raw = {
    keywords: kw,
    hitCount: lines.length,
    snippets,
  };

  //audit Assumption: sanitized payload remains JSON-parseable in normal operation; risk: malformed sanitized payload; invariant: function returns bounded context payload; handling: parse with fallback to unsanitized snippets.
  const sanitizedPayload = applySecurityCompliance(JSON.stringify(raw, null, 2)).content;
  let sanitizedSnippets = snippets;
  try {
    const parsed = JSON.parse(sanitizedPayload) as { snippets?: Snippet[] };
    if (Array.isArray(parsed.snippets)) {
      sanitizedSnippets = parsed.snippets;
    }
  } catch {
    //audit Assumption: parse failures should not break self-improve cycle; risk: returning less-redacted context; invariant: context remains size-bounded and source-constrained; handling: fallback to pre-sanitized in-memory snippets.
  }

  return {
    summary: `Repo context grounded via git grep (${lines.length} matches, ${snippets.length} files).`,
    snippets: sanitizedSnippets,
  };
}

function shellQuote(s: string): string {
  // safest minimal single-quote wrapper (bash)
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}
