import { execFile } from "child_process";
import { promisify } from "util";
import { applySecurityCompliance } from "@services/securityCompliance.js";

const execFileAsync = promisify(execFile);
const GIT_GREP_TIMEOUT_MS = 10_000;
const GIT_GREP_MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_REPO_CONTEXT_KEYWORD_CHARS = 200;

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

  const kw = Array.from(new Set(
    (keywords || [])
      .map(keyword => keyword.trim())
      .filter(keyword =>
        keyword.length > 0 &&
        keyword.length <= MAX_REPO_CONTEXT_KEYWORD_CHARS &&
        !/[\0\r\n]/u.test(keyword)
      )
  )).slice(0, 12);
  if (kw.length === 0) return { summary: "No repo context requested.", snippets: [] };

  // Keep every model-influenced keyword in a distinct process argument.
  const args = [
    "grep",
    "-n",
    "--fixed-strings",
    ...kw.flatMap(keyword => ["-e", keyword]),
    "--",
    ":!dist",
    ":!node_modules",
    ":!workers/dist",
  ];

  let stdout = "";
  try {
    const res = await execFileAsync("git", args, {
      cwd: workingDir,
      windowsHide: true,
      timeout: GIT_GREP_TIMEOUT_MS,
      maxBuffer: GIT_GREP_MAX_BUFFER_BYTES,
      encoding: "utf8",
    });
    stdout = res.stdout || "";
  } catch (error: unknown) {
    // git grep exits 1 when no matches; treat as empty.
    const commandError = error as { code?: unknown; stdout?: unknown };
    stdout = commandError.code === 1 && typeof commandError.stdout === "string"
      ? commandError.stdout
      : "";
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

  //audit Assumption: sanitized payload remains JSON-parseable in normal operation; risk: malformed sanitized payload; invariant: function never returns unsanitized fallback content; handling: parse with empty-snippet fallback.
  const sanitizedPayload = applySecurityCompliance(JSON.stringify(raw, null, 2)).content;
  let sanitizedSnippets: Snippet[] = [];
  try {
    const parsed = JSON.parse(sanitizedPayload) as { snippets?: Snippet[] };
    if (Array.isArray(parsed.snippets)) {
      sanitizedSnippets = parsed.snippets;
    }
  } catch {
    //audit Assumption: parse failures should not break self-improve cycle; risk: leaking raw grep content; invariant: failed sanitization returns empty snippets; handling: drop snippets when parse fails.
  }

  return {
    summary: `Repo context grounded via git grep (${lines.length} matches, ${snippets.length} files).`,
    snippets: sanitizedSnippets,
  };
}
