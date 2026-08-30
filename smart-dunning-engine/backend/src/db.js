// src/db.js
// Shared PostgreSQL connection pool + audit-logging helper.

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  console.error("[db] Unexpected idle client error", err);
});

/**
 * Insert an immutable audit-log row. Every state transition, ML confidence
 * score, and decision rationale must flow through this function per the
 * fintech guardrail requirements.
 */
async function writeAuditLog({
  caseId,
  paymentId,
  fromState,
  toState,
  mlConfidence = null,
  decisionRationale = null,
  metadata = {},
}) {
  const query = `
    INSERT INTO recovery_audit_logs
      (case_id, payment_id, from_state, to_state, ml_confidence, decision_rationale, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id, created_at;
  `;
  const values = [
    caseId,
    paymentId,
    fromState,
    toState,
    mlConfidence,
    decisionRationale,
    JSON.stringify(metadata),
  ];
  const { rows } = await pool.query(query, values);
  return rows[0];
}

module.exports = { pool, writeAuditLog };
