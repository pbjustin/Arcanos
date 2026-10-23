export function runBookerMcpPreviewE2e(options?: {
  args?: string[];
  localGitState?: { clean: boolean; head: string; repository: string };
  fetchImpl?: typeof fetch;
  waitImpl?: (ms: number) => Promise<void>;
}): Promise<{ summary: { status: string; requestsMade?: number }; checks: Array<{ caseId: string }>; [key: string]: unknown }>;
