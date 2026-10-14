// Call records on disk (SQLite, via Node's built-in node:sqlite), so call
// history and recordings survive restarts. Records older than the retention
// period are deleted, together with their recording files.

import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface CallRecord {
  sid: string;
  direction: string;
  from: string;
  to: string;
  status: string;
  parentCallSid?: string;
  createdAt: string;
  answeredAt?: string;
  endedAt?: string;
  duration?: number;
  /** Why the call ended, when the gateway ended it (e.g. "gateway-shutdown"). */
  endedReason?: string;
}

export interface RecordingRecord {
  name: string;
  callSid: string;
  createdAt: string;
  durationSeconds?: number;
}

/** Calls that can still change; anything else is final. */
const LIVE_STATUSES = ["queued", "ringing", "in-progress"];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS calls (
    sid TEXT PRIMARY KEY,
    direction TEXT NOT NULL,
    from_number TEXT NOT NULL,
    to_number TEXT NOT NULL,
    status TEXT NOT NULL,
    parent_call_sid TEXT,
    created_at TEXT NOT NULL,
    answered_at TEXT,
    ended_at TEXT,
    duration INTEGER,
    ended_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS calls_created_at ON calls (created_at);
  CREATE TABLE IF NOT EXISTS recordings (
    name TEXT PRIMARY KEY,
    call_sid TEXT NOT NULL,
    created_at TEXT NOT NULL,
    duration_seconds INTEGER
  );
  CREATE INDEX IF NOT EXISTS recordings_call_sid ON recordings (call_sid);
`;

type Row = Record<string, string | number | null>;

function toCall(row: Row): CallRecord {
  return {
    sid: String(row.sid),
    direction: String(row.direction),
    from: String(row.from_number),
    to: String(row.to_number),
    status: String(row.status),
    parentCallSid: (row.parent_call_sid as string | null) ?? undefined,
    createdAt: String(row.created_at),
    answeredAt: (row.answered_at as string | null) ?? undefined,
    endedAt: (row.ended_at as string | null) ?? undefined,
    duration: (row.duration as number | null) ?? undefined,
    endedReason: (row.ended_reason as string | null) ?? undefined,
  };
}

export class CallStore {
  private readonly db: DatabaseSync;

  /** `file` is a path, or ":memory:" for a throwaway database. */
  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;");
    this.db.exec(SCHEMA);
  }

  saveCall(call: CallRecord): void {
    this.db
      .prepare(
        `INSERT INTO calls (sid, direction, from_number, to_number, status, parent_call_sid,
                            created_at, answered_at, ended_at, duration, ended_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (sid) DO UPDATE SET
           status = excluded.status, answered_at = excluded.answered_at, ended_at = excluded.ended_at,
           duration = excluded.duration, ended_reason = COALESCE(excluded.ended_reason, calls.ended_reason)`,
      )
      .run(
        call.sid, call.direction, call.from, call.to, call.status, call.parentCallSid ?? null,
        call.createdAt, call.answeredAt ?? null, call.endedAt ?? null, call.duration ?? null,
        call.endedReason ?? null,
      );
  }

  getCall(sid: string): CallRecord | undefined {
    const row = this.db.prepare("SELECT * FROM calls WHERE sid = ?").get(sid) as Row | undefined;
    return row ? toCall(row) : undefined;
  }

  /** Newest first. `before` pages backwards by creation time. */
  listCalls(options: { limit?: number; status?: string; before?: string } = {}): CallRecord[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (options.status) {
      where.push("status = ?");
      args.push(options.status);
    }
    if (options.before) {
      where.push("created_at < ?");
      args.push(options.before);
    }
    const sql = `SELECT * FROM calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY created_at DESC LIMIT ?`;
    args.push(Math.min(Math.max(options.limit ?? 50, 1), 1000));
    return (this.db.prepare(sql).all(...args) as Row[]).map(toCall);
  }

  saveRecording(recording: RecordingRecord): void {
    this.db
      .prepare(
        `INSERT INTO recordings (name, call_sid, created_at, duration_seconds) VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET duration_seconds = excluded.duration_seconds`,
      )
      .run(recording.name, recording.callSid, recording.createdAt, recording.durationSeconds ?? null);
  }

  listRecordings(callSid: string): RecordingRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM recordings WHERE call_sid = ? ORDER BY created_at")
      .all(callSid) as Row[];
    return rows.map((row) => ({
      name: String(row.name),
      callSid: String(row.call_sid),
      createdAt: String(row.created_at),
      durationSeconds: (row.duration_seconds as number | null) ?? undefined,
    }));
  }

  /**
   * Calls left "live" by a previous run that stopped without finishing them
   * (a crash or kill). They can't be resumed, so mark them failed.
   */
  closeOrphans(reason: string, now = new Date()): string[] {
    const placeholders = LIVE_STATUSES.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT sid FROM calls WHERE status IN (${placeholders})`)
      .all(...LIVE_STATUSES) as Row[];
    this.db
      .prepare(
        `UPDATE calls SET status = 'failed', ended_at = COALESCE(ended_at, ?), ended_reason = ?
         WHERE status IN (${placeholders})`,
      )
      .run(now.toISOString(), reason, ...LIVE_STATUSES);
    return rows.map((r) => String(r.sid));
  }

  /** Delete calls (and their recordings, including the files) older than `days`. */
  async purge(days: number, recordingsDir: string, now = new Date()): Promise<{ calls: number; recordings: number }> {
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    const recordings = this.db
      .prepare(
        `SELECT r.name FROM recordings r JOIN calls c ON c.sid = r.call_sid
         WHERE c.created_at < ? AND c.status NOT IN ('queued', 'ringing', 'in-progress')`,
      )
      .all(cutoff) as Row[];
    for (const { name } of recordings) {
      // Names are generated by the gateway (CA…-N), never user input, but stay inside the dir anyway.
      if (/^CA[0-9a-f]{32}-\d+$/.test(String(name))) {
        await rm(path.join(recordingsDir, `${name}.wav`), { force: true });
      }
    }
    this.db
      .prepare(
        `DELETE FROM recordings WHERE call_sid IN (
           SELECT sid FROM calls WHERE created_at < ? AND status NOT IN ('queued', 'ringing', 'in-progress'))`,
      )
      .run(cutoff);
    const deleted = this.db
      .prepare("DELETE FROM calls WHERE created_at < ? AND status NOT IN ('queued', 'ringing', 'in-progress')")
      .run(cutoff);
    return { calls: Number(deleted.changes), recordings: recordings.length };
  }

  close(): void {
    this.db.close();
  }
}
