export function buildJobResultPollPath(jobId: string): string {
  return `/jobs/${jobId}/result`;
}
