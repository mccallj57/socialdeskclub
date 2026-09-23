import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class Conflict extends Error {
  constructor() { super("This writing changed in another window. Reload it before saving so neither version is lost."); this.status = 409; }
}
export class SQLiteStore {
  constructor(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec("CREATE TABLE IF NOT EXISTS documents (pk TEXT NOT NULL, sk TEXT NOT NULL, value TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(pk,sk))");
  }
  async get(pk, sk) {
    const r = this.db.prepare("SELECT value FROM documents WHERE pk=? AND sk=?").get(pk, sk);
    return r ? JSON.parse(r.value) : null;
  }
  async list(pk, prefix) {
    return this.db.prepare("SELECT value FROM documents WHERE pk=? AND substr(sk,1,?)=? ORDER BY sk").all(pk, prefix.length, prefix).map(r => JSON.parse(r.value));
  }
  async commit(ops) {
    this.db.transaction(() => {
      for (const op of ops) {
        const row = this.db.prepare("SELECT revision FROM documents WHERE pk=? AND sk=?").get(op.pk, op.sk);
        if (op.expected !== undefined && (row?.revision ?? 0) !== op.expected) throw new Conflict();
        if (op.remove) this.db.prepare("DELETE FROM documents WHERE pk=? AND sk=?").run(op.pk, op.sk);
        else this.db.prepare("INSERT INTO documents VALUES(?,?,?,?) ON CONFLICT(pk,sk) DO UPDATE SET value=excluded.value,revision=excluded.revision").run(op.pk, op.sk, JSON.stringify(op.value), op.value.version ?? 1);
      }
    })();
  }
}
