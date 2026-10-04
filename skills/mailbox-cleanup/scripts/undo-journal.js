"use strict";

/**
 * undo-journal.js — the one undo authority for a MailKeeper run.
 *
 * The desktop runtime and the workspace CLI both reverse runs, so both go
 * through this journal at <workspace>/.mailkeeper/undo/<runId>.json, guarded
 * by <runId>.lock. It holds selectors and outcomes only, never credentials.
 *
 * Protocol: lock → read → refuse while any chunk is pending or unresolved →
 * for each chunk: record it pending (durable) → dispatch → record the outcome
 * (durable) → unlock. A chunk left pending by a crash keeps blocking: a dead
 * lock holder is no evidence its move did not happen. Only a future
 * authenticated reconciliation may clear pending or unresolved work.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BATCH = 200;

function fault(code, message = code) {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}

// Keyed by the original action, so a reversal of `to → from` is recognised.
function actionKey(account, uid, from, to) {
  return JSON.stringify([account, String(uid), from, to]);
}

function files(stateDir, runId) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(runId || "")) throw fault("MAILKEEPER_RUN_INVALID", "Valid runId is required");
  const dir = path.join(stateDir, "undo");
  return { dir, journal: path.join(dir, `${runId}.json`), lock: path.join(dir, `${runId}.lock`) };
}

function blank(runId) {
  return { schemaVersion: 1, runId, reversed: [], pending: [], unresolved: [], history: [] };
}

function read(stateDir, runId) {
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(files(stateDir, runId).journal, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw fault("MAILKEEPER_UNDO_JOURNAL_UNREADABLE", "The run's undo journal is unreadable");
  }
  if (journal?.schemaVersion !== 1 || journal.runId !== runId || !Array.isArray(journal.reversed) ||
      !Array.isArray(journal.pending) || !Array.isArray(journal.unresolved)) {
    throw fault("MAILKEEPER_UNDO_JOURNAL_UNREADABLE", "The run's undo journal is unreadable");
  }
  return journal;
}

function write(stateDir, runId, journal) {
  const target = files(stateDir, runId).journal;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(journal, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, target);
}

// Called when a run first records mailbox moves: a run without a journal
// predates it, and its undo history is unknown to the journal.
function ensure(stateDir, runId) {
  if (!read(stateDir, runId)) write(stateDir, runId, blank(runId));
}

function lock(stateDir, runId) {
  const { dir, lock: file } = files(stateDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => fs.rmSync(file, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let holder = NaN;
      try { holder = Number(fs.readFileSync(file, "utf8")); } catch { /* Treated as dead below. */ }
      let alive = Number.isInteger(holder) && holder > 0;
      if (alive) {
        try { process.kill(holder, 0); } catch (probe) { alive = probe.code !== "ESRCH"; }
      }
      if (alive) throw fault("MAILKEEPER_UNDO_BUSY", "An undo for this run is already in progress");
      // The dead holder's pending chunks stay in the journal and keep blocking.
      fs.rmSync(file, { force: true });
    }
  }
  throw fault("MAILKEEPER_UNDO_BUSY", "An undo for this run is already in progress");
}

/**
 * Reverse a run's moves under the journal.
 *
 * actions: every recorded move ({ account, uid, from, to }); select() limits
 * this call (for example to one account) while completion still covers all.
 * dispatch({ account, from, to, uids }) moves one chunk back and resolves only
 * on confirmation. A failure is not_started only when it carries that proven
 * outcome; anything else is uncertain.
 * legacy: how to treat a run without a journal: { allow: false } refuses;
 * { allow: true, undoneAt } adopts it, and an earlier record of completion
 * (undoneAt) is kept rather than replayed.
 */
async function reverse({ stateDir, runId, actions, select = () => true, dispatch, dryRun = false, legacy = { allow: false }, by = null }) {
  const release = lock(stateDir, runId);
  try {
    let journal = read(stateDir, runId); // Under the guard: never a stale copy.
    if (!journal) {
      if (!legacy.allow) throw fault("MAILKEEPER_UNDO_LEGACY", "This run predates the shared undo journal. Undo it from MailKeeper in RealTimeX.");
      journal = { ...blank(runId), legacy: true, ...(legacy.undoneAt ? { undoneAt: legacy.undoneAt } : {}) };
      if (!dryRun) write(stateDir, runId, journal);
    }
    if (journal.undoneAt) return { reused: true, undoneAt: journal.undoneAt, reversed: 0, skipped: [], dryRun };
    if (journal.pending.length || journal.unresolved.length) {
      throw fault("MAILKEEPER_UNDO_UNRESOLVED", "Review the interrupted undo before trying again");
    }

    const confirmed = new Set(journal.reversed);
    const remaining = actions.filter((a) => !confirmed.has(actionKey(a.account, a.uid, a.from, a.to)));
    const groups = new Map();
    for (const a of remaining.filter(select)) {
      const key = JSON.stringify([a.account, a.to, a.from]);
      if (!groups.has(key)) groups.set(key, { account: a.account, from: a.to, to: a.from, uids: [] });
      groups.get(key).uids.push(String(a.uid));
    }
    if (dryRun) {
      return { reused: false, dryRun, reversed: [...groups.values()].reduce((n, g) => n + g.uids.length, 0), skipped: [] };
    }

    let reversed = 0;
    const skipped = [];
    let stopped = false;
    for (const group of groups.values()) {
      if (stopped) {
        skipped.push({ account: group.account, from: group.from, to: group.to, count: group.uids.length, code: "MAILKEEPER_UNDO_STOPPED" });
        continue;
      }
      for (let i = 0; i < group.uids.length; i += BATCH) {
        const attempt = { attemptId: crypto.randomUUID(), account: group.account, from: group.from, to: group.to,
          uids: group.uids.slice(i, i + BATCH), at: new Date().toISOString() };
        journal.pending.push(attempt);
        write(stateDir, runId, journal); // If this fails, nothing is launched.
        let outcome = "confirmed";
        let failure = null;
        try {
          await dispatch({ account: attempt.account, from: attempt.from, to: attempt.to, uids: attempt.uids });
        } catch (error) {
          outcome = error?.attempt?.outcome === "not_started" ? "not_started" : "uncertain";
          failure = { code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || "") ? error.code : "EMAIL_RESULT_UNCERTAIN",
            operationId: typeof error?.attempt?.operationId === "string" ? error.attempt.operationId : null };
        }
        journal.pending = journal.pending.filter((entry) => entry.attemptId !== attempt.attemptId);
        if (outcome === "confirmed") {
          journal.reversed.push(...attempt.uids.map((uid) => actionKey(attempt.account, uid, attempt.to, attempt.from)));
          reversed += attempt.uids.length;
        } else if (outcome === "uncertain") {
          journal.unresolved.push({ ...attempt, operationId: failure.operationId, code: failure.code });
        }
        // If recording the outcome fails, the pending marker stays and blocks.
        write(stateDir, runId, journal);
        if (failure) {
          skipped.push({ account: group.account, from: group.from, to: group.to, count: group.uids.length - i,
            code: failure.code, attempt: { operationId: failure.operationId, outcome } });
          stopped = true; // Stop after any failure; the cause may affect every chunk.
          break;
        }
      }
    }
    const complete = new Set(journal.reversed);
    if (!skipped.length && actions.every((a) => complete.has(actionKey(a.account, a.uid, a.from, a.to)))) {
      journal.undoneAt = new Date().toISOString();
    }
    journal.history = [...(journal.history || []), { at: new Date().toISOString(), by, reversed, skipped }].slice(-20);
    write(stateDir, runId, journal);
    return { reused: false, dryRun, reversed, skipped, ...(journal.undoneAt ? { undoneAt: journal.undoneAt } : {}) };
  } finally {
    release();
  }
}

module.exports = { actionKey, ensure, read, reverse, BATCH };
