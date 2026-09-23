import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const tokenKeys = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

// RFC 8878, sections 3.1.1 and 3.1.2. Parse lengths, not magic-byte matches
// inside payloads. Node's decompressor can return partial output for a tail.
function frameEnd(buf, start) {
  if (start + 4 > buf.length) return null;
  const magic = buf.readUInt32LE(start);
  if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
    if (start + 8 > buf.length) return null;
    const end = start + 8 + buf.readUInt32LE(start + 4);
    return end <= buf.length ? end : null;
  }
  if (magic !== 0xfd2fb528) throw new Error('Unsupported zstd frame');
  if (start + 5 > buf.length) return null;
  const descriptor = buf[start + 4], single = (descriptor & 0x20) !== 0;
  if (descriptor & 8) throw new Error('Reserved zstd frame bit');
  const contentSizeBytes = [single ? 1 : 0, 2, 4, 8][descriptor >>> 6];
  let at = start + 5 + (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + contentSizeBytes;
  for (;;) {
    if (at + 3 > buf.length) return null;
    const block = buf.readUIntLE(at, 3), type = (block >>> 1) & 3;
    if (type === 3) throw new Error('Reserved zstd block type');
    at += 3 + (type === 1 ? 1 : block >>> 3);
    if (at > buf.length) return null;
    if (block & 1) { at += descriptor & 4 ? 4 : 0; return at <= buf.length ? at : null; }
  }
}

// dsh's concatenated zstd log is versioned, private storage. Incomplete tails
// remain unread until a complete frame arrives; callers surface partial data.
export function decodeFrom(buf, start = 0) {
  const events = [];
  let end = start, at = start, invalidLines = 0, carry = Buffer.alloc(0), pending = [];
  while (at < buf.length) {
    let next, decoded;
    try {
      next = frameEnd(buf, at);
      if (next === null) break;
      decoded = zlib.zstdDecompressSync(buf.subarray(at, next), { maxOutputLength: 64 * 1024 * 1024 });
    } catch { break; }
    carry = Buffer.concat([carry, decoded]);
    let newline;
    while ((newline = carry.indexOf(10)) !== -1) {
      const line = carry.subarray(0, newline).toString('utf8');
      carry = carry.subarray(newline + 1);
      if (!line.trim()) continue;
      try { pending.push(JSON.parse(line)); } catch { invalidLines++; }
    }
    at = next;
    // Only advance an incremental reader past complete JSONL records. If a
    // frame splits a record (or a UTF-8 character), re-read it on the next tick.
    if (!carry.length) { events.push(...pending); pending = []; end = next; }
  }
  return { events, end, invalidLines, complete: end === buf.length && invalidLines === 0 };
}

export function readEvents(file) {
  const size = fs.statSync(file).size;
  if (size > 128 * 1024 * 1024) throw new Error('Session exceeds the 128 MiB reader limit');
  const buf = fs.readFileSync(file);
  if (file.endsWith('.zstd')) return decodeFrom(buf);
  const events = []; let invalidLines = 0;
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { invalidLines++; }
  }
  return { events, end: buf.length, invalidLines, complete: invalidLines === 0 };
}

export function listSessionFiles(root) {
  const found = [];
  let projects; try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { return found; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const folder = path.join(root, project.name);
    let sessions; try { sessions = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      for (const name of ['session.v3.jsonl.zstd', 'session.v3.jsonl']) {
        const file = path.join(folder, session.name, name);
        try { found.push({ id: session.name.replace(/^session-/, ''), file, mtime: fs.statSync(file).mtimeMs }); break; } catch {}
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

export function sessionState(openTurns, lastEnd, mtime, now = Date.now()) {
  if (openTurns > 0) return now - mtime < 5 * 60e3 ? 'active' : 'quiet';
  return lastEnd === 'completed' ? 'done' : (lastEnd || 'empty');
}

function usageSample(event) {
  if (event.type === 'assistant/message' && event.data?.usage) return event.data.usage;
  for (const record of [...(event.data?.stream || [])].reverse()) {
    if (record.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage;
  }
  return null;
}

// Match the installed dsh v3 usage semantics: final settlement replaces the
// same turn/step's attempt sample; a retry boundary starts a new billed attempt.
// Reasoning is already included in outputTokens and must not be added again.
export function collectUsage(events) {
  const totals = Object.fromEntries(tokenKeys.map(k => [k, 0]));
  let previous = null, samples = 0, missing = 0;
  for (const event of events) {
    const data = event.data || {};
    if (event.type === 'llm/retry-started') {
      if (previous?.turn === data.turn && previous?.step === data.step) previous = null;
      continue;
    }
    if (!['assistant/message', 'assistant/attempt'].includes(event.type)) continue;
    const sample = usageSample(event);
    if (!sample) { missing++; continue; }
    const values = [sample.inputTokens, sample.outputTokens, sample.cacheReadTokens ?? 0, sample.cacheWriteTokens ?? 0];
    if (!values.every(v => Number.isSafeInteger(v) && v >= 0) || !Number.isInteger(data.turn) || !Number.isInteger(data.step)) { missing++; continue; }
    const replacing = previous && previous.turn === data.turn && previous.step === data.step;
    for (let i = 0; i < tokenKeys.length; i++) totals[tokenKeys[i]] += values[i] - (replacing ? previous.values[i] : 0);
    previous = { turn: data.turn, step: data.step, values };
    if (!replacing) samples++;
  }
  return { available: samples > 0, scope: 'matched_session_only', samples, missingSamples: missing, tokens: samples ? totals : null };
}

export function matchSession(root, marker, startedAt) {
  const matches = []; let unreadable = 0;
  for (const session of listSessionFiles(root)) {
    if (session.mtime < startedAt - 2000) continue;
    try {
      const decoded = readEvents(session.file);
      if (!decoded.events.some(e => e.type === 'user/message' && e.data?.source?.kind === 'user' &&
        e.data.content?.some(p => p.type === 'text' && p.text?.endsWith('\n' + marker + '\n')))) continue;
      matches.push({ ...session, logComplete: decoded.complete, usage: collectUsage(decoded.events) });
    } catch { unreadable++; }
  }
  if (matches.length !== 1) return { matched: false, reason: matches.length ? 'ambiguous_session' : 'session_not_found', unreadable };
  return { matched: true, ...matches[0] };
}
