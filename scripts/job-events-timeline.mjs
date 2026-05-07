#!/usr/bin/env node
import process from 'node:process';

function readArg(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const input = {
  jobId: readArg('job-id'),
  traceId: readArg('trace-id'),
  workerId: readArg('worker-id'),
  eventType: readArg('event-type'),
  occurredAfter: readArg('after'),
  occurredBefore: readArg('before'),
  limit: readArg('limit') ? Number(readArg('limit')) : undefined
};
const output = readArg('output') ?? 'json';

const db = await import('../dist/core/db/index.js');
const timeline = await import('../dist/services/jobEventTimelineService.js');

await db.initializeDatabaseWithSchema('job-events-timeline');
const result = await timeline.getJobEventTimeline(input);

if (output === 'text') {
  console.log(timeline.formatJobEventTimeline(result.events));
  console.log(JSON.stringify({ available: result.available, summary: result.summary }, null, 2));
} else {
  console.log(JSON.stringify(result, null, 2));
}

await db.close();
