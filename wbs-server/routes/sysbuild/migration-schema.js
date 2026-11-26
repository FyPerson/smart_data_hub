'use strict';
// Only the explicit maintenance tool creates the ledger. Retain the exact
// definition used by versions 1–6 so historical databases can be checked.
const definition = (limit) => `CREATE TABLE IF NOT EXISTS sysbuild_schema_migrations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 from_version INTEGER NOT NULL CHECK (from_version BETWEEN 0 AND ${limit}),
 to_version INTEGER NOT NULL CHECK (to_version BETWEEN 1 AND ${limit} AND to_version > from_version),
 contract_sha256 TEXT NOT NULL CHECK (length(contract_sha256) = 64),
 backup_sha256 TEXT NOT NULL CHECK (length(backup_sha256) = 64),
 applied_at DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
)`;
const LEDGER_SQL_V1 = definition(6);
const LEDGER_SQL_V2 = definition(7);
const LEDGER_SQL_V3 = definition(8);
const LEDGER_SQL = definition(9);
module.exports = { LEDGER_SQL, LEDGER_SQL_V1, LEDGER_SQL_V2, LEDGER_SQL_V3 };
