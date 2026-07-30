import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

export function nowIso() {
  return new Date().toISOString();
}

function secureDatabaseDirectory(dir) {
  const resolved = path.resolve(dir);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`database directory must be a real directory: ${resolved}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    // Never turn a shared sticky directory such as /tmp, or the filesystem root, private.
    if ((stat.mode & 0o1000) !== 0 || resolved === path.parse(resolved).root) {
      throw new Error(`database directory must not be shared: ${resolved}`);
    }
    fs.chmodSync(resolved, 0o700);
  }
  if ((fs.lstatSync(resolved).mode & 0o077) !== 0) {
    throw new Error(`database directory permissions must be 0700: ${resolved}`);
  }
}

function rejectDatabaseSymlink(file) {
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`database path must be a regular file: ${file}`);
  }
}

function secureDatabaseFile(file) {
  if (!fs.existsSync(file)) return;
  rejectDatabaseSymlink(file);
  fs.chmodSync(file, 0o600);
  if ((fs.lstatSync(file).mode & 0o177) !== 0) {
    throw new Error(`database file permissions must be 0600: ${file}`);
  }
}

export function openDatabase(dbPath, options = {}) {
  if (dbPath === ":memory:") {
    const db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    if (options.ensureSchema !== false) ensureSchema(db);
    return db;
  }
  const resolved = path.resolve(dbPath);
  secureDatabaseDirectory(path.dirname(resolved));
  rejectDatabaseSymlink(resolved);
  const db = new Database(resolved);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    if (options.ensureSchema !== false) ensureSchema(db);
    for (const file of [resolved, `${resolved}-wal`, `${resolved}-shm`]) secureDatabaseFile(file);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const CANONICAL_SCHEMA = `
    CREATE TABLE receivers (
      id TEXT PRIMARY KEY,
      name TEXT,
      public_name TEXT,
      lat REAL,
      lon REAL,
      last_seen_at TEXT,
      last_ip TEXT,
      user_agent TEXT,
      total_ingests INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS receiver_tokens (
      receiver_id TEXT NOT NULL,
      token_hash TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_used_at TEXT,
      FOREIGN KEY (receiver_id) REFERENCES receivers(id) ON DELETE CASCADE
    );

    CREATE TABLE ingest_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receiver_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      source_now TEXT,
      aircraft_count INTEGER NOT NULL,
      accepted_count INTEGER NOT NULL,
      track_points INTEGER NOT NULL DEFAULT 0,
      remote_addr TEXT,
      FOREIGN KEY (receiver_id) REFERENCES receivers(id) ON DELETE CASCADE
    );

    CREATE TABLE receiver_aircraft_current (
      receiver_id TEXT NOT NULL,
      hex TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      position_at TEXT,
      lat REAL,
      lon REAL,
      flight TEXT,
      alt_baro REAL,
      alt_geom REAL,
      on_ground INTEGER NOT NULL DEFAULT 0,
      gs REAL,
      ias REAL,
      tas REAL,
      mach REAL,
      track REAL,
      true_heading REAL,
      mag_heading REAL,
      baro_rate REAL,
      geom_rate REAL,
      track_rate REAL,
      roll REAL,
      squawk TEXT,
      category TEXT,
      source_type TEXT,
      source_kind TEXT,
      emergency TEXT,
      nav_qnh REAL,
      nav_altitude_mcp REAL,
      nav_altitude_fms REAL,
      nav_heading REAL,
      wd REAL,
      ws REAL,
      oat REAL,
      tat REAL,
      nac_p INTEGER,
      nac_v INTEGER,
      nic INTEGER,
      nic_baro INTEGER,
      rc INTEGER,
      sil INTEGER,
      sil_type TEXT,
      version INTEGER,
      alert INTEGER,
      spi INTEGER,
      non_icao INTEGER NOT NULL DEFAULT 0,
      messages INTEGER,
      rssi REAL,
      seen_seconds REAL,
      seen_pos_seconds REAL,
      PRIMARY KEY (receiver_id, hex),
      FOREIGN KEY (receiver_id) REFERENCES receivers(id) ON DELETE CASCADE
    );

    CREATE TABLE track_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hex TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      position_at TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      alt_baro REAL,
      alt_geom REAL,
      on_ground INTEGER NOT NULL DEFAULT 0,
      gs REAL,
      ias REAL,
      tas REAL,
      mach REAL,
      track REAL,
      true_heading REAL,
      mag_heading REAL,
      baro_rate REAL,
      geom_rate REAL,
      wd REAL,
      ws REAL,
      oat REAL,
      tat REAL,
      source_type TEXT,
      messages INTEGER,
      rssi REAL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (hex, receiver_id, position_at),
      FOREIGN KEY (receiver_id) REFERENCES receivers(id) ON DELETE CASCADE
    );

    CREATE TABLE coverage_receiver_state (
      receiver_id TEXT PRIMARY KEY,
      config_key TEXT NOT NULL,
      origin_lat REAL NOT NULL,
      origin_lon REAL NOT NULL,
      last_track_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (receiver_id) REFERENCES receivers(id) ON DELETE CASCADE
    );

    CREATE TABLE coverage_track_state (
      receiver_id TEXT NOT NULL,
      hex TEXT NOT NULL,
      position_at TEXT NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      altitude_ft REAL NOT NULL,
      PRIMARY KEY (receiver_id, hex),
      FOREIGN KEY (receiver_id) REFERENCES receivers(id) ON DELETE CASCADE
    );

    CREATE TABLE coverage_cells (
      receiver_id TEXT NOT NULL,
      config_key TEXT NOT NULL,
      cell_x INTEGER NOT NULL,
      cell_y INTEGER NOT NULL,
      cell_z INTEGER NOT NULL,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      altitude_ft REAL NOT NULL,
      last_seen_at TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (receiver_id, config_key, cell_x, cell_y, cell_z),
      FOREIGN KEY (receiver_id) REFERENCES receivers(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_receiver_current_observed ON receiver_aircraft_current(observed_at);
    CREATE INDEX idx_receiver_current_hex ON receiver_aircraft_current(hex);
    CREATE INDEX idx_track_hex_time ON track_points(hex, position_at, id);
    CREATE INDEX idx_track_hex_id ON track_points(hex, id);
    CREATE INDEX idx_track_time ON track_points(position_at);
    CREATE INDEX idx_track_receiver_id ON track_points(receiver_id, id);
    CREATE INDEX idx_track_receiver_time ON track_points(receiver_id, position_at, id);
    CREATE INDEX idx_batches_received ON ingest_batches(received_at, id);
    CREATE INDEX idx_batches_receiver_time ON ingest_batches(receiver_id, received_at);
    CREATE INDEX idx_coverage_cells_active
      ON coverage_cells(receiver_id, config_key, last_seen_at);
    CREATE INDEX idx_coverage_track_state_time
      ON coverage_track_state(receiver_id, position_at);
`;

const CANONICAL_TABLE_COLUMNS = {
  receivers: [
    "id", "name", "public_name", "lat", "lon", "last_seen_at", "last_ip", "user_agent",
    "total_ingests", "created_at", "updated_at",
  ],
  receiver_tokens: ["receiver_id", "token_hash", "created_at", "last_used_at"],
  ingest_batches: [
    "id", "receiver_id", "received_at", "source_now", "aircraft_count", "accepted_count",
    "track_points", "remote_addr",
  ],
  receiver_aircraft_current: [
    "receiver_id", "hex", "observed_at", "position_at", "lat", "lon", "flight", "alt_baro",
    "alt_geom", "on_ground", "gs", "ias", "tas", "mach", "track", "true_heading",
    "mag_heading", "baro_rate", "geom_rate", "track_rate", "roll", "squawk", "category",
    "source_type", "source_kind", "emergency", "nav_qnh", "nav_altitude_mcp",
    "nav_altitude_fms", "nav_heading", "wd", "ws", "oat", "tat", "nac_p", "nac_v",
    "nic", "nic_baro", "rc", "sil", "sil_type", "version", "alert", "spi", "non_icao",
    "messages", "rssi", "seen_seconds", "seen_pos_seconds",
  ],
  track_points: [
    "id", "hex", "receiver_id", "observed_at", "position_at", "lat", "lon", "alt_baro",
    "alt_geom", "on_ground", "gs", "ias", "tas", "mach", "track", "true_heading",
    "mag_heading", "baro_rate", "geom_rate", "wd", "ws", "oat", "tat", "source_type",
    "messages", "rssi", "created_at",
  ],
  coverage_receiver_state: [
    "receiver_id", "config_key", "origin_lat", "origin_lon", "last_track_id", "updated_at",
  ],
  coverage_track_state: [
    "receiver_id", "hex", "position_at", "lat", "lon", "altitude_ft",
  ],
  coverage_cells: [
    "receiver_id", "config_key", "cell_x", "cell_y", "cell_z", "lat", "lon",
    "altitude_ft", "last_seen_at", "hit_count",
  ],
};

const CANONICAL_INDEXES = new Set([
  "idx_receiver_current_observed",
  "idx_receiver_current_hex",
  "idx_track_hex_time",
  "idx_track_hex_id",
  "idx_track_time",
  "idx_track_receiver_id",
  "idx_track_receiver_time",
  "idx_batches_received",
  "idx_batches_receiver_time",
  "idx_coverage_cells_active",
  "idx_coverage_track_state_time",
]);

function normalizedSql(sql) {
  return String(sql || "").replace(/\s+/g, " ").trim();
}

function normalizedObjectSql(row) {
  const sql = normalizedSql(row.sql);
  if (row.type !== "table") return sql;
  const escapedName = row.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return sql.replace(
    new RegExp(`^CREATE TABLE ["'\`]?(?:${escapedName})["'\`]?`, "i"),
    `CREATE TABLE ${row.name}`,
  );
}

function schemaFingerprint(db) {
  const objects = db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
      AND type IN ('table', 'index')
    ORDER BY type, name
  `).all().map((row) => ({
    type: row.type,
    name: row.name,
    table: row.tbl_name,
    sql: normalizedObjectSql(row),
  }));
  const tables = objects.filter((object) => object.type === "table").map((object) => object.name);
  const details = {};
  for (const table of tables) {
    details[table] = {
      columns: db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map((row) => ({
        name: row.name,
        type: row.type,
        notNull: row.notnull,
        defaultValue: row.dflt_value,
        primaryKey: row.pk,
      })),
      foreignKeys: db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(table)})`).all().map((row) => ({
        id: row.id,
        seq: row.seq,
        table: row.table,
        from: row.from,
        to: row.to,
        onUpdate: row.on_update,
        onDelete: row.on_delete,
        match: row.match,
      })),
      indexes: db.prepare(`PRAGMA index_list(${JSON.stringify(table)})`).all().map((row) => ({
        name: row.name,
        unique: row.unique,
        origin: row.origin,
        partial: row.partial,
        columns: db.prepare(`PRAGMA index_info(${JSON.stringify(row.name)})`).all()
          .map((column) => column.name),
      })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  return crypto.createHash("sha256")
    .update(JSON.stringify({ objects, details }))
    .digest("hex");
}

let expectedCanonicalFingerprint;
function canonicalFingerprint() {
  if (expectedCanonicalFingerprint) return expectedCanonicalFingerprint;
  const fixture = new Database(":memory:");
  try {
    fixture.exec(CANONICAL_SCHEMA);
    expectedCanonicalFingerprint = schemaFingerprint(fixture);
  } finally {
    fixture.close();
  }
  return expectedCanonicalFingerprint;
}

function canonicalSchemaProblems(db) {
  const problems = [];
  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);
  const expectedTables = Object.keys(CANONICAL_TABLE_COLUMNS).sort();
  if (tables.join("\n") !== expectedTables.join("\n")) {
    problems.push(`tables are ${tables.join(", ") || "(none)"}`);
  }
  for (const [table, expectedColumns] of Object.entries(CANONICAL_TABLE_COLUMNS)) {
    if (!tables.includes(table)) continue;
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (columns.join("\n") !== expectedColumns.join("\n")) {
      problems.push(`${table} columns are ${columns.join(", ")}`);
    }
  }
  const indexes = new Set(db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'
  `).all().map((row) => row.name));
  if (
    indexes.size !== CANONICAL_INDEXES.size
    || [...CANONICAL_INDEXES].some((name) => !indexes.has(name))
  ) {
    problems.push(`indexes are ${[...indexes].sort().join(", ") || "(none)"}`);
  }
  if (problems.length === 0 && schemaFingerprint(db) !== canonicalFingerprint()) {
    problems.push("table constraints, foreign keys or index definitions differ");
  }
  return problems;
}

export function ensureSchema(db) {
  const tableCount = db.prepare(`
    SELECT count(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).get().count;
  if (tableCount === 0) {
    db.exec(CANONICAL_SCHEMA);
  }
  const problems = canonicalSchemaProblems(db);
  if (problems.length > 0) {
    throw new Error(
      `database schema does not match this Skytrace version (${problems.join("; ")})`,
    );
  }
}

export function syncReceiverTokens(db, receiverTokens) {
  const upsertReceiver = db.prepare(`
    INSERT INTO receivers (id, name, public_name, updated_at)
    VALUES (@id, @id, @id, @now)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
  `);
  const upsertToken = db.prepare(`
    INSERT INTO receiver_tokens (receiver_id, token_hash)
    VALUES (@receiverId, @tokenHash)
    ON CONFLICT(token_hash) DO UPDATE SET receiver_id = excluded.receiver_id
  `);
  const listTokens = db.prepare("SELECT token_hash FROM receiver_tokens");
  const deleteToken = db.prepare("DELETE FROM receiver_tokens WHERE token_hash = ?");

  const tx = db.transaction((entries) => {
    const configuredHashes = new Set();
    for (const entry of entries) {
      const tokenHash = hashToken(entry.token);
      configuredHashes.add(tokenHash);
      upsertReceiver.run({ id: entry.receiverId, now: nowIso() });
      upsertToken.run({ receiverId: entry.receiverId, tokenHash });
    }
    for (const row of listTokens.all()) {
      if (!configuredHashes.has(row.token_hash)) deleteToken.run(row.token_hash);
    }
  });
  tx(receiverTokens || []);
}
