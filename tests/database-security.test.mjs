import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../server/db.mjs";

function permissions(file) {
  return fs.statSync(file).mode & 0o777;
}

test("database directory and SQLite files are private", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "skytrace-db-security-"));
  const dir = path.join(root, "data");
  fs.mkdirSync(dir, { mode: 0o755 });
  const dbPath = path.join(dir, "skytrace.db");
  const db = openDatabase(dbPath);
  try {
    db.prepare("INSERT INTO receivers (id) VALUES (?)").run("rx-1");
    assert.equal(permissions(dir), 0o700);
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      assert.equal(permissions(file), 0o600, file);
    }
  } finally {
    db.close();
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("database symlinks are rejected before SQLite opens them", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "skytrace-db-symlink-"));
  const target = path.join(root, "target.db");
  const link = path.join(root, "skytrace.db");
  fs.writeFileSync(target, "not a database", { mode: 0o600 });
  fs.symlinkSync(target, link);
  try {
    assert.throws(() => openDatabase(link), /must be a regular file/);
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});
