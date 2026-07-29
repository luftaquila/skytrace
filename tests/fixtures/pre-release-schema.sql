CREATE TABLE receivers (
  id TEXT PRIMARY KEY,
  name TEXT,
  public_name TEXT,
  lat REAL,
  lon REAL,
  show_position INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  last_ip TEXT,
  user_agent TEXT,
  total_ingests INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE receiver_tokens (
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
  source_json TEXT NOT NULL,
  batch_id INTEGER,
  PRIMARY KEY (receiver_id, hex),
  FOREIGN KEY (receiver_id) REFERENCES receivers(id) ON DELETE CASCADE,
  FOREIGN KEY (batch_id) REFERENCES ingest_batches(id) ON DELETE SET NULL
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
  batch_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (hex, receiver_id, position_at),
  FOREIGN KEY (receiver_id) REFERENCES receivers(id) ON DELETE CASCADE,
  FOREIGN KEY (batch_id) REFERENCES ingest_batches(id) ON DELETE SET NULL
);
CREATE TABLE aircraft_sightings (
  hex TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  total_observations INTEGER NOT NULL DEFAULT 0,
  last_flight TEXT
);
CREATE TABLE coverage_receiver_state (
  receiver_id TEXT PRIMARY KEY,
  schema_key TEXT NOT NULL,
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
  schema_key TEXT NOT NULL,
  cell_x INTEGER NOT NULL,
  cell_y INTEGER NOT NULL,
  cell_z INTEGER NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  altitude_ft REAL NOT NULL,
  last_seen_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (receiver_id, schema_key, cell_x, cell_y, cell_z),
  FOREIGN KEY (receiver_id) REFERENCES receivers(id) ON DELETE CASCADE
);
CREATE INDEX idx_receiver_current_observed ON receiver_aircraft_current(observed_at);
CREATE INDEX idx_receiver_current_hex ON receiver_aircraft_current(hex);
CREATE INDEX idx_track_hex_time ON track_points(hex, position_at);
CREATE INDEX idx_track_time ON track_points(position_at);
CREATE INDEX idx_track_receiver_id ON track_points(receiver_id, id);
CREATE INDEX idx_track_receiver_time ON track_points(receiver_id, position_at, id);
CREATE INDEX idx_batches_receiver_time ON ingest_batches(receiver_id, received_at);
CREATE INDEX idx_coverage_cells_active
  ON coverage_cells(receiver_id, schema_key, last_seen_at);
CREATE INDEX idx_coverage_track_state_time
  ON coverage_track_state(receiver_id, position_at);
