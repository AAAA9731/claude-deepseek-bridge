import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { matchSession, tokenKeys } from './sessions.mjs';

export const bridgeHome = () => path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'bridge');
const terminal = new Set(['completed', 'failed', 'timed_out', 'cancelled', 'launch_failed']);
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
export function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function readJob(id, home = bridgeHome()) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Use the complete job ID returned by dsb run');
  return JSON.parse(fs.readFileSync(path.join(home, 'jobs', id, 'job.json'), 'utf8'));
}
export function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
export function status(job) {
  const knownEnd = terminal.has(job.processState) || job.processState === 'cleanup_failed';
  return { id: job.id, parentId: job.parentId, processState: knownEnd ? job.processState :
    (processExists(job.supervisorPid) ? 'running' : 'unknown'),
    acceptance: job.review?.verdict || 'unreviewed', exitCode: job.exitCode ?? null,
    reportedResult: job.reportedResult ?? null, cwd: job.cwd,
    startedAt: job.startedAt, finishedAt: job.finishedAt ?? null,
    reportFile: job.reportFile, stderrFile: job.stderrFile,
    sessionId: job.session?.matched ? job.session.id : null };
}
export function briefText(file) {
  if (fs.statSync(file).size > 48000) throw new Error('Brief is too long: use concise goals and references instead of pasted source/history');
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('Brief must not be blank');
  return text;
}
export function reportState(report) {
  return /^RESULT:\s*(OK|FAIL|BLOCKED)(?=\s|$)/.exec(report.trimStart())?.[1] || 'UNKNOWN';
}
function git(cwd, args) {
  return spawnSync('git', ['-c', `safe.directory=${cwd}`, ...args], {
    cwd, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024,
  });
}
function workspaceRoot(cwd) {
  const result = git(cwd, ['rev-parse', '--show-toplevel']);
  return result.status === 0 ? fs.realpathSync(result.stdout.trim()) : cwd;
}
function baseline(cwd) {
  const result = git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  return { capturedAt: Date.now(), available: result.status === 0, status: result.status === 0 ? result.stdout : null,
    note: 'Inventory only, not a backup or attribution of pre-existing changes.' };
}
export function resolveDsh(entry) {
  const candidates = entry ? [path.resolve(entry)] : (process.env.PATH || '').split(path.delimiter).filter(Boolean)
    .flatMap(dir => [path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      path.join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')]);
  for (const file of candidates) {
    try { if (fs.statSync(file).isFile()) return fs.realpathSync(file); } catch {}
  }
  throw new Error('Cannot locate dsh. Install @deepseek-ai/dsh or pass --dsh-entry /path/to/dsh/lib/bin.js');
}
function acquireLock(home, workspace, id) {
  const key = sha(process.platform === 'win32' ? workspace.toLowerCase() : workspace);
  const file = path.join(home, 'locks', key + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, JSON.stringify({ id, workspace, supervisorPid: process.pid, createdAt: Date.now() }), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let owner; try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    throw new Error(`Workspace already has a bridge lock (${owner?.id || file}). Check that task; never retry concurrently. A stale lock requires dsb unlock <job-id> --confirmed-stopped.`);
  }
  return file;
}
function releaseLock(file, id) {
  if (JSON.parse(fs.readFileSync(file, 'utf8')).id !== id) throw new Error('Workspace lock ownership changed');
  fs.unlinkSync(file);
}

const reportContract = `\n\n【桥接报告约定】保留上述用户目标、范围与验收条件。自行调查实现，不需要主代理预先写好代码。\n最终报告第一行写 RESULT: OK|FAIL|BLOCKED；未验证的条件必须注明，不能当作通过。\n随后用约 15 行给出结论、改动/证据位置、验证命令与退出码、未验证项或阻塞原因；详细日志给路径。\n不要把整个执行过程或源码粘回报告。不要扩大用户授权；遇到目标冲突或必须扩大范围时停止并说明。`;

export async function runJob(options, emit = () => {}, home = bridgeHome()) {
  const cwd = fs.realpathSync(options.cwd || process.cwd());
  if (!fs.statSync(cwd).isDirectory()) throw new Error('cwd must be a directory');
  const originalBrief = options.originalBrief ?? briefText(options.brief);
  const patches = (options.patch || []).map(file => fs.realpathSync(file));
  const patchHashes = patches.map(file => sha(fs.readFileSync(file)));
  const timeout = Number(options.timeout ?? 2700);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 86400) throw new Error('timeout must be between 0 and 86400 seconds');
  const entry = resolveDsh(options.dshEntry);
  const id = crypto.randomUUID(), marker = `[bridge-task:${id}]`;
  // Keep stable instructions first. A unique job marker must not invalidate
  // the reusable prompt prefix, especially on a focused retry.
  const prompt = originalBrief + reportContract + (options.feedback ? `\n\n【返工信息】\n${options.feedback}` : '') + '\n\n' + marker + '\n';
  const launchArgs = [entry, '--profile', 'headless', ...patches.flatMap(file => ['--patch', file]), prompt];
  if (process.platform === 'win32' && JSON.stringify([process.execPath, ...launchArgs]).length > 28000)
    throw new Error('Windows command line would be too long. Shorten the brief and reference existing project files.');
  const dir = path.join(home, 'jobs', id), lockFile = acquireLock(home, workspaceRoot(cwd), id);
  const file = path.join(dir, 'job.json');
  let child, timeoutTimer, pollTimer, stopReason = null, stopping, cleanupError = null, notifyCleanupFailure;
  const cleanupFailure = new Promise(resolve => { notifyCleanupFailure = resolve; });
  const job = { version: 1, id, parentId: options.parentId || null, rootId: options.rootId || id, cwd, entry, patches, patchHashes, timeout,
    supervisorPid: process.pid, childPid: null, processState: 'starting', startedAt: Date.now(),
    reportFile: path.join(dir, 'report.txt'), stderrFile: path.join(dir, 'stderr.log'), lockFile,
    briefHash: sha(originalBrief), originalBriefFile: path.join(dir, 'brief.md'),
    review: null, usage: null, exitCode: null };
  const save = () => atomicJson(file, job);
  const stop = reason => {
    if (stopping || !child?.pid) return stopping;
    stopReason = reason;
    stopping = new Promise(resolve => {
      const failCleanup = message => {
        cleanupError = message;
        notifyCleanupFailure({ code: null, cleanupFailed: true, error: message });
        resolve();
      };
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        const killDeadline = setTimeout(() => { killer.kill(); failCleanup('Process-tree cleanup timed out; lock retained. Inspect recorded processes.'); }, 10000);
        killer.on('error', error => { clearTimeout(killDeadline); failCleanup(`Process-tree cleanup failed: ${error.message}. Lock retained.`); });
        killer.on('close', code => { clearTimeout(killDeadline);
          if (code !== 0 && processExists(child.pid)) failCleanup('Process-tree cleanup was denied or failed; lock retained. Inspect recorded processes.');
          else resolve();
        });
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch {}
          if (processExists(child.pid)) failCleanup('Process-tree cleanup did not stop the child; lock retained.');
          else resolve();
        }, 1500);
      }
    });
    return stopping;
  };
  const onSignal = () => { void stop('cancelled'); };
  const fds = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(job.originalBriefFile, originalBrief, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'prompt.txt'), prompt, { mode: 0o600 });
    if (options.feedback) fs.writeFileSync(path.join(dir, 'feedback.md'), options.feedback, { mode: 0o600 });
    atomicJson(path.join(dir, 'baseline.json'), baseline(cwd));
    save();
    const stdout = fs.openSync(job.reportFile, 'w', 0o600), stderr = fs.openSync(job.stderrFile, 'w', 0o600);
    fds.push(stdout, stderr);
    child = spawn(process.execPath, launchArgs, { cwd, stdio: ['ignore', stdout, stderr], windowsHide: true,
      detached: process.platform !== 'win32', env: process.env });
    job.childPid = child.pid ?? null; job.processState = 'running'; save();
    process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
    emit({ event: 'started', ...status(job) });
    timeoutTimer = setTimeout(() => { void stop('timed_out'); }, timeout * 1000);
    pollTimer = setInterval(() => {
      if (fs.existsSync(path.join(dir, 'cancel.request'))) void stop('cancelled');
    }, 500);
    const outcome = await Promise.race([cleanupFailure, new Promise(resolve => {
      child.once('error', error => resolve({ code: null, error: error.message }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    })]);
    if (stopping) await stopping;
    job.exitCode = outcome.code; job.signal = outcome.signal || null;
    job.processState = cleanupError ? 'cleanup_failed' : stopReason || (outcome.error ? 'launch_failed' : outcome.code === 0 ? 'completed' : 'failed');
    if (outcome.error) job.error = outcome.error;
    job.finishedAt = Date.now();
    job.reportedResult = reportState(readPrefix(job.reportFile, 8192));
    job.session = matchSession(path.join(path.dirname(home), 'sessions'), marker, job.startedAt);
    job.usage = job.session.matched ? job.session.usage : null;
    atomicJson(path.join(dir, 'after.json'), baseline(cwd));
    save();
  } catch (error) {
    if (child?.pid && processExists(child.pid)) await stop('failed');
    job.processState = cleanupError ? 'cleanup_failed' : 'failed'; job.error = error.message; job.finishedAt = Date.now();
    try { save(); } catch {}
    throw error;
  } finally {
    clearTimeout(timeoutTimer); clearInterval(pollTimer);
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    fds.forEach(fd => { try { fs.closeSync(fd); } catch {} });
    // Keep the lock if cleanup cannot prove the direct child stopped.
    if (!cleanupError && (!child?.pid || !processExists(child.pid))) releaseLock(lockFile, id);
    if (cleanupError) child?.unref();
  }
  return job;
}

export function readPrefix(file, bytes = 6000) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(bytes); return buf.subarray(0, fs.readSync(fd, buf, 0, bytes, 0)).toString('utf8'); }
  finally { fs.closeSync(fd); }
}
export function result(job) {
  return { ...status(job), error: job.error || null, report: readPrefix(job.reportFile),
    reportTruncated: fs.statSync(job.reportFile).size > 6000, usage: job.usage,
    verificationRequired: job.review?.verdict !== 'accepted' };
}
export async function retryJob(parent, feedback, emit, home = bridgeHome()) {
  if (!terminal.has(parent.processState)) throw new Error('Previous run has no confirmed terminal state; inspect/cancel it first');
  if (parent.review?.verdict === 'accepted') throw new Error('Accepted jobs should not be retried; create a new task');
  for (let i = 0; i < parent.patches.length; i++) {
    if (sha(fs.readFileSync(parent.patches[i])) !== parent.patchHashes[i]) throw new Error('MCP patch changed since the previous run; review configuration and create a new job');
  }
  const originalBrief = briefText(parent.originalBriefFile);
  if (sha(originalBrief) !== parent.briefHash) throw new Error('Original brief changed; create a new job with reviewed requirements');
  return runJob({ cwd: parent.cwd, originalBrief, patch: parent.patches, timeout: parent.timeout, dshEntry: parent.entry,
    feedback: `上次任务 ${parent.id} 已结束。先核对工作区现状，保留已有用户改动和已完成成果，只修复剩余问题，不重复已完成的外部操作。\n${feedback}`,
    parentId: parent.id, rootId: parent.rootId }, emit, home);
}
export function reviewJob(job, verdict, note, home = bridgeHome(), accounting = null) {
  if (!['accepted', 'rework', 'blocked'].includes(verdict) || !note?.trim()) throw new Error('review requires --verdict accepted|rework|blocked and a verification --note');
  if (!terminal.has(job.processState)) throw new Error('Cannot review an active or unknown job');
  if (verdict === 'accepted' && (job.exitCode !== 0 || job.reportedResult !== 'OK'))
    throw new Error('Failed, incomplete, or non-OK runs cannot be marked accepted. Record rework/blocked and verify a new run.');
  if (accounting) {
    for (const key of ['claudeCost', 'codexCost', 'deepseekCost']) if (accounting[key] != null && (!Number.isFinite(accounting[key]) || accounting[key] < 0)) throw new Error('Costs must be nonnegative numbers');
    if (typeof accounting.currency !== 'string' || !accounting.currency || typeof accounting.source !== 'string' || !accounting.source)
      throw new Error('Accounting requires currency and source; omit unknown costs rather than using zero');
  }
  job.review = { verdict, note, at: Date.now() };
  if (accounting) job.accounting = accounting;
  atomicJson(path.join(home, 'jobs', job.id, 'job.json'), job);
  return status(job);
}
export function cancelJob(job, home = bridgeHome()) {
  if (terminal.has(job.processState)) return { ...status(job), cancelRequested: false };
  if (job.processState === 'cleanup_failed') throw new Error('Cleanup already failed; inspect recorded processes before recovery');
  if (!processExists(job.supervisorPid)) throw new Error('Supervisor is gone; inspect the recorded child process and workspace before recovery');
  fs.writeFileSync(path.join(home, 'jobs', job.id, 'cancel.request'), 'cancel\n', { mode: 0o600 });
  return { ...status(job), cancelRequested: true, note: 'Request queued; wait for a terminal state before retrying.' };
}
export function unlockJob(job, confirmedStopped) {
  if (!confirmedStopped) throw new Error('Confirm the old task and its child processes stopped, then use --confirmed-stopped');
  if (processExists(job.supervisorPid) || processExists(job.childPid)) throw new Error('A recorded process is still present; do not unlock');
  releaseLock(job.lockFile, job.id);
  return { id: job.id, unlocked: true, note: 'Inspect partial changes before creating a new run; unknown runs are not automatically retried.' };
}
export function stats(home = bridgeHome()) {
  let ids; try { ids = fs.readdirSync(path.join(home, 'jobs')); } catch { ids = []; }
  const jobs = []; let unreadableJobs = 0;
  for (const id of ids) { try { jobs.push(readJob(id, home)); } catch { unreadableJobs++; } }
  const tokens = Object.fromEntries(tokenKeys.map(key => [key, 0]));
  const costsByCurrency = Object.create(null);
  for (const job of jobs) {
    for (const key of tokenKeys) tokens[key] += job.usage?.tokens?.[key] || 0;
    const a = job.accounting;
    if (!a) continue;
    const group = costsByCurrency[a.currency] ||= { claudeCost: 0, codexCost: 0, deepseekCost: 0, claudeRecords: 0, codexRecords: 0, deepseekRecords: 0 };
    for (const model of ['claude', 'codex', 'deepseek']) if (a[model + 'Cost'] != null) { group[model + 'Cost'] += a[model + 'Cost']; group[model + 'Records']++; }
  }
  return { jobs: jobs.length, unreadableJobs, tasks: new Set(jobs.map(j => j.rootId)).size,
    retries: jobs.filter(j => j.parentId).length,
    acceptedTasks: new Set(jobs.filter(j => j.review?.verdict === 'accepted').map(j => j.rootId)).size,
    acceptedFirstAttempts: jobs.filter(j => !j.parentId && j.review?.verdict === 'accepted').length,
    usageRecords: jobs.filter(j => j.usage?.available).length, missingUsageRecords: jobs.filter(j => !j.usage?.available).length,
    observedSessionTokens: tokens, costsByCurrency,
    note: 'Usage covers matched parent sessions only; missing samples/child sessions may be billed. Costs are supplied records, not inferred from tokens. Savings need a comparable baseline using the same host without delegation.' };
}
