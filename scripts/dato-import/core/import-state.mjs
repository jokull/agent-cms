import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS record_imports (
  id TEXT PRIMARY KEY,
  model_api_key TEXT NOT NULL,
  source_updated_at TEXT,
  imported_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_record_imports_model ON record_imports(model_api_key);
CREATE INDEX IF NOT EXISTS idx_record_imports_status ON record_imports(status);

CREATE TABLE IF NOT EXISTS asset_queue (
  upload_id TEXT PRIMARY KEY,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  imported_at TEXT,
  error TEXT,
  source_url TEXT,
  filename TEXT,
  mime_type TEXT,
  size INTEGER
);

CREATE INDEX IF NOT EXISTS idx_asset_queue_status_priority ON asset_queue(status, priority DESC);

CREATE TABLE IF NOT EXISTS asset_refs (
  record_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  field_api_key TEXT,
  discovered_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (record_id, upload_id)
);

CREATE TABLE IF NOT EXISTS import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  model_api_key TEXT,
  mode TEXT NOT NULL,
  records_imported INTEGER NOT NULL DEFAULT 0,
  records_skipped INTEGER NOT NULL DEFAULT 0,
  assets_imported INTEGER NOT NULL DEFAULT 0,
  assets_skipped INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
`;

/**
 * @param {string} outDir - base output directory (e.g. scripts/dato-import/out)
 * @param {string} projectId - Dato project/environment identifier
 * @returns {ImportState}
 */
export function openState(outDir, projectId) {
  const dir = join(outDir, projectId);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "import-state.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return new ImportState(db, dbPath);
}

export class ImportState {
  /** @type {Database.Database} */
  #db;
  /** @type {string} */
  dbPath;

  // Prepared statements (lazy)
  #stmts = /** @type {Record<string, Database.Statement>} */ ({});

  constructor(db, dbPath) {
    this.#db = db;
    this.dbPath = dbPath;
  }

  #stmt(key, sql) {
    if (!this.#stmts[key]) {
      this.#stmts[key] = this.#db.prepare(sql);
    }
    return this.#stmts[key];
  }

  close() {
    this.#db.close();
  }

  // ── Record imports ──

  upsertRecord(id, modelApiKey, sourceUpdatedAt, status, error = null) {
    this.#stmt(
      "upsertRecord",
      `INSERT INTO record_imports (id, model_api_key, source_updated_at, imported_at, status, error)
       VALUES (?, ?, ?, datetime('now'), ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         source_updated_at = excluded.source_updated_at,
         imported_at = excluded.imported_at,
         status = excluded.status,
         error = excluded.error`,
    ).run(id, modelApiKey, sourceUpdatedAt, status, error);
  }

  getRecord(id) {
    return this.#stmt("getRecord", `SELECT * FROM record_imports WHERE id = ?`).get(id);
  }

  recordCountsByStatus(modelApiKey = null) {
    const sql = modelApiKey
      ? `SELECT status, COUNT(*) as count FROM record_imports WHERE model_api_key = ? GROUP BY status`
      : `SELECT status, COUNT(*) as count FROM record_imports GROUP BY status`;
    const rows = modelApiKey
      ? this.#db.prepare(sql).all(modelApiKey)
      : this.#db.prepare(sql).all();
    return Object.fromEntries(rows.map((r) => [r.status, r.count]));
  }

  // ── Asset queue ──

  enqueueAsset(uploadId, recordId, fieldApiKey, metadata = {}) {
    this.#stmt(
      "enqueueAsset",
      `INSERT INTO asset_queue (upload_id, priority, source_url, filename, mime_type, size)
       VALUES (?, 1, ?, ?, ?, ?)
       ON CONFLICT(upload_id) DO UPDATE SET
         priority = asset_queue.priority + 1`,
    ).run(uploadId, metadata.sourceUrl ?? null, metadata.filename ?? null, metadata.mimeType ?? null, metadata.size ?? null);

    this.#stmt(
      "insertAssetRef",
      `INSERT OR IGNORE INTO asset_refs (record_id, upload_id, field_api_key) VALUES (?, ?, ?)`,
    ).run(recordId, uploadId, fieldApiKey ?? null);
  }

  /** @returns {{ upload_id: string, source_url: string, filename: string, mime_type: string, size: number, priority: number }[]} */
  pendingAssets(limit = 100) {
    return this.#stmt(
      "pendingAssets",
      `SELECT * FROM asset_queue WHERE status = 'pending' ORDER BY priority DESC LIMIT ?`,
    ).all(limit);
  }

  pendingAssetCount() {
    return this.#stmt("pendingAssetCount", `SELECT COUNT(*) as count FROM asset_queue WHERE status = 'pending'`).get()
      .count;
  }

  updateAssetStatus(uploadId, status, error = null) {
    this.#stmt(
      "updateAssetStatus",
      `UPDATE asset_queue SET status = ?, imported_at = datetime('now'), error = ? WHERE upload_id = ?`,
    ).run(status, error, uploadId);
  }

  assetCountsByStatus() {
    const rows = this.#db.prepare(`SELECT status, COUNT(*) as count FROM asset_queue GROUP BY status`).all();
    return Object.fromEntries(rows.map((r) => [r.status, r.count]));
  }

  referencedAssetCount() {
    return this.#db
      .prepare(
        `SELECT COUNT(DISTINCT upload_id) as count FROM asset_refs
       WHERE upload_id IN (SELECT upload_id FROM asset_queue WHERE status = 'pending')`,
      )
      .get().count;
  }

  // ── Import runs ──

  startRun(mode, modelApiKey = null) {
    const result = this.#stmt(
      "startRun",
      `INSERT INTO import_runs (mode, model_api_key) VALUES (?, ?)`,
    ).run(mode, modelApiKey);
    return /** @type {number} */ (result.lastInsertRowid);
  }

  updateRunProgress(runId, counts) {
    this.#db
      .prepare(
        `UPDATE import_runs SET
       records_imported = ?, records_skipped = ?,
       assets_imported = ?, assets_skipped = ?
       WHERE id = ?`,
      )
      .run(
        counts.recordsImported ?? 0,
        counts.recordsSkipped ?? 0,
        counts.assetsImported ?? 0,
        counts.assetsSkipped ?? 0,
        runId,
      );
  }

  completeRun(runId, error = null) {
    this.#stmt(
      "completeRun",
      `UPDATE import_runs SET completed_at = datetime('now'), error = ? WHERE id = ?`,
    ).run(error, runId);
  }

  latestRun() {
    return this.#db.prepare(`SELECT * FROM import_runs ORDER BY id DESC LIMIT 1`).get();
  }

  activeRun() {
    return this.#db.prepare(`SELECT * FROM import_runs WHERE completed_at IS NULL ORDER BY id DESC LIMIT 1`).get();
  }

  // ── Batch helpers ──

  transaction(fn) {
    return this.#db.transaction(fn)();
  }
}
