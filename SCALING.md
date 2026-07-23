# Scalability contract

Skytrace may run as a personal receiver today, but new data paths must remain
partitionable for multi-receiver operators and worldwide traffic.

## Required invariants

- Ingest work must be proportional to the submitted batch, never to total
  retained history.
- Historical consumers must use time windows plus indexed cursors. A global
  `ORDER BY ... LIMIT n` must not silently redefine a time-based product
  contract.
- CPU-heavy geometry, exports, and analytics run outside the HTTP event loop.
  Published results are immutable snapshots, swapped only after a complete
  successful build.
- Background jobs are idempotent, non-overlapping, resumable from persisted
  cursors, and partitioned by a stable ownership key such as `receiver_id`.
- Derived data must expire by its product retention window even when raw
  history is retained longer.
- Browser payloads must be bounded by the visible viewport, explicit
  pagination/cursors, or spatial tiles before the dataset becomes global.
- One receiver, aircraft, or tenant must not force recomputation of unrelated
  partitions.
- Health endpoints expose background-job readiness and failure state without
  making live ingest depend on that job.

## Coverage implementation

Coverage uses `receiver_id` partitions. A worker consumes new `track_points`
by monotonically increasing row id, interpolates only short plausible track
segments, and upserts fixed-resolution 3D evidence cells. `last_seen_at`
provides exact "observed at least once within the window" expiration without
rescanning raw history. The mesh worker reads active cells for each receiver
and atomically publishes the completed snapshot. Its persistent per-receiver
mesh cache means an unchanged partition is reused; new evidence, cell expiry,
receiver metadata changes, and schema/window changes invalidate only the
affected partition. A process restart safely rebuilds the cache from the
derived cells.

The default SQLite/WAL deployment is a single-node profile. Its worker
boundary and receiver-keyed tables are migration seams, not a claim that
SQLite is a worldwide database. Before multi-node or worldwide operation:

1. Move raw tracks and derived cells to a partitioned server database.
2. Replace the in-process timer with a leased/distributed job queue.
3. Assign receiver partitions to worker shards.
4. Publish coverage as viewport-addressed spatial tiles instead of one global
   response.
5. Load-test ingest, storage growth, worker lag, tile size, and browser layer
   count against the intended deployment envelope.
