#!/usr/bin/env node
import fs from 'node:fs';
import { runJob, readJob, status, result, retryJob, reviewJob, cancelJob, unlockJob, stats, briefText } from '../lib/bridge.mjs';

const usage = `dsb — bounded dsh delegation with durable handoff records
  dsb run --cwd <project> --brief <file> [--patch <file> ...] [--timeout <seconds>]
  dsb status <id> | result <id> | cancel <id>
  dsb retry <id> --feedback <file>
  dsb review <id> --verdict accepted|rework|blocked --note <verification evidence> [--accounting <json>]
  dsb unlock <id> --confirmed-stopped
  dsb stats
Run/retry stay attached; use the host's background task mechanism.
No model call is made by status/result/cancel/review/unlock/stats.
--dsh-entry <path/to/dsh/lib/bin.js> overrides local CLI discovery for run.`;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
function parse(args, allowed) {
  const out = { patch: [] };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.includes(key)) throw new Error(`Unknown option: ${key}`);
    if (key === '--confirmed-stopped') { out.confirmedStopped = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    const name = key.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (name === 'patch') out.patch.push(value);
    else { if (name in out) throw new Error(`Duplicate option: ${key}`); out[name] = value; }
  }
  return out;
}
try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) console.log(usage);
  else if (command === 'run') {
    const options = parse(args, ['--cwd', '--brief', '--patch', '--timeout', '--dsh-entry']);
    if (!options.brief) throw new Error('--brief is required');
    const job = await runJob(options, emit); emit({ event: 'finished', ...result(job) });
    process.exitCode = job.processState === 'completed' && job.reportedResult === 'OK' ? 0 : 1;
  } else if (command === 'stats') {
    parse(args, []); emit(stats());
  } else {
    if (!['status', 'result', 'retry', 'review', 'cancel', 'unlock'].includes(command)) throw new Error(`Unknown command: ${command}`);
    const [id, ...rest] = args;
    const options = parse(rest, { status: [], result: [], cancel: [], retry: ['--feedback'], review: ['--verdict', '--note', '--accounting'], unlock: ['--confirmed-stopped'] }[command]);
    const job = readJob(id || '');
    if (command === 'status') emit(status(job));
    else if (command === 'result') emit(result(job));
    else if (command === 'cancel') emit(cancelJob(job));
    else if (command === 'unlock') emit(unlockJob(job, options.confirmedStopped));
    else if (command === 'review') emit(reviewJob(job, options.verdict, options.note, undefined,
      options.accounting ? JSON.parse(fs.readFileSync(options.accounting, 'utf8').replace(/^\uFEFF/, '')) : null));
    else {
      if (!options.feedback) throw new Error('--feedback is required');
      const next = await retryJob(job, briefText(options.feedback), emit);
      emit({ event: 'finished', ...result(next) });
      process.exitCode = next.processState === 'completed' && next.reportedResult === 'OK' ? 0 : 1;
    }
  }
} catch (error) { emit({ error: error.message }); process.exitCode = 1; }
