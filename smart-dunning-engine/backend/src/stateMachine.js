// src/stateMachine.js
// Explicit finite-state machine governing every recovery case:
//
//   DETECTED -> DIAGNOSING -> QUEUED_RETRY | SMART_LINK_DISPATCHED
//                                  -> RECOVERED | PERMANENTLY_FAILED
//
// Every transition is validated against this table, persisted to
// recovery_cases, and mirrored into recovery_audit_logs. Invalid transitions
// throw rather than silently no-op, so a bug upstream fails loudly instead of
// corrupting financial state.

const { pool, writeAuditLog } = require("./db");

const STATES = Object.freeze({
  DETECTED: "DETECTED",
  DIAGNOSING: "DIAGNOSING",
  QUEUED_RETRY: "QUEUED_RETRY",
  SMART_LINK_DISPATCHED: "SMART_LINK_DISPATCHED",
  RECOVERED: "RECOVERED",
  PERMANENTLY_FAILED: "PERMANENTLY_FAILED",
});

const TERMINAL_STATES = new Set([STATES.RECOVERED, STATES.PERMANENTLY_FAILED]);

const ALLOWED_TRANSITIONS = {
  [STATES.DETECTED]: [STATES.DIAGNOSING],
  [STATES.DIAGNOSING]: [
    STATES.QUEUED_RETRY,
    STATES.SMART_LINK_DISPATCHED,
    STATES.PERMANENTLY_FAILED, // e.g. ML unavailable + attempt cap already hit
  ],
  [STATES.QUEUED_RETRY]: [
    STATES.RECOVERED,
    STATES.DIAGNOSING, // retry failed again -> re-diagnose
    STATES.PERMANENTLY_FAILED, // attempt cap or window exceeded
  ],
  [STATES.SMART_LINK_DISPATCHED]: [
    STATES.RECOVERED,
    STATES.PERMANENTLY_FAILED, // link expired / window exceeded
  ],
  [STATES.RECOVERED]: [],
  [STATES.PERMANENTLY_FAILED]: [],
};

const MAX_ATTEMPTS_DEFAULT = 3;
const ATTEMPT_WINDOW_HOURS = 72;

class InvalidTransitionError extends Error {
  constructor(fromState, toState) {
    super(`Illegal state transition: ${fromState} -> ${toState}`);
    this.name = "InvalidTransitionError";
    this.fromState = fromState;
    this.toState = toState;
  }
}

class GuardrailViolationError extends Error {
  constructor(message) {
    super(message);
    this.name = "GuardrailViolationError";
  }
}

function assertTransitionAllowed(fromState, toState) {
  const allowed = ALLOWED_TRANSITIONS[fromState] || [];
  if (!allowed.includes(toState)) {
    throw new InvalidTransitionError(fromState, toState);
  }
}

/**
 * Guardrail: hard cap of `max_attempts` recovery attempts (default 3) within
 * a rolling `ATTEMPT_WINDOW_HOURS` (default 72h) window per mandate. Called
 * before any transition into QUEUED_RETRY or SMART_LINK_DISPATCHED.
 */
function assertWithinAttemptCap(caseRow) {
  const windowExpired = new Date(caseRow.window_expires_at).getTime() < Date.now();
  if (windowExpired) {
    throw new GuardrailViolationError(
      `Recovery window expired for payment ${caseRow.payment_id} ` +
        `(window_expires_at=${caseRow.window_expires_at}).`
    );
  }
  if (caseRow.attempt_count >= (caseRow.max_attempts || MAX_ATTEMPTS_DEFAULT)) {
    throw new GuardrailViolationError(
      `Attempt cap reached for payment ${caseRow.payment_id} ` +
        `(${caseRow.attempt_count}/${caseRow.max_attempts}).`
    );
  }
}

/**
 * Guardrail: never transition a case that is already terminal. Prevents a
 * duplicate/late webhook from re-opening a resolved case, which is how
 * double-charges happen.
 */
function assertNotTerminal(caseRow) {
  if (TERMINAL_STATES.has(caseRow.current_state)) {
    throw new GuardrailViolationError(
      `Case ${caseRow.payment_id} is already terminal (${caseRow.current_state}); refusing further transitions.`
    );
  }
}

/**
 * Transition a case to a new state inside a DB transaction, incrementing
 * attempt_count when entering an active-recovery state, and writing the
 * audit log row. Returns the updated case row.
 */
async function transition({
  caseId,
  toState,
  mlConfidence = null,
  decisionRationale = null,
  metadata = {},
  extraFields = {}, // e.g. { failure_classification, optimal_retry_delay_hours, next_retry_at, smart_link_url }
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT * FROM recovery_cases WHERE id = $1 FOR UPDATE",
      [caseId]
    );
    if (rows.length === 0) {
      throw new Error(`No recovery_case found with id=${caseId}`);
    }
    const caseRow = rows[0];

    assertNotTerminal(caseRow);
    assertTransitionAllowed(caseRow.current_state, toState);

    const enteringActiveRecovery =
      toState === STATES.QUEUED_RETRY || toState === STATES.SMART_LINK_DISPATCHED;
    if (enteringActiveRecovery) {
      assertWithinAttemptCap(caseRow);
    }

    const incrementAttempt = enteringActiveRecovery ? 1 : 0;
    const resolvedAt = TERMINAL_STATES.has(toState) ? new Date() : caseRow.resolved_at;

    const setClauses = [
      "current_state = $1",
      "attempt_count = attempt_count + $2",
      "resolved_at = $3",
    ];
    const values = [toState, incrementAttempt, resolvedAt];
    let paramIndex = values.length;

    for (const [field, value] of Object.entries(extraFields)) {
      paramIndex += 1;
      setClauses.push(`${field} = $${paramIndex}`);
      values.push(value);
    }

    paramIndex += 1;
    values.push(caseId);

    const updateQuery = `
      UPDATE recovery_cases
      SET ${setClauses.join(", ")}
      WHERE id = $${paramIndex}
      RETURNING *;
    `;
    const updated = await client.query(updateQuery, values);

    await client.query(
      `INSERT INTO recovery_audit_logs
         (case_id, payment_id, from_state, to_state, ml_confidence, decision_rationale, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        caseId,
        caseRow.payment_id,
        caseRow.current_state,
        toState,
        mlConfidence,
        decisionRationale,
        JSON.stringify(metadata),
      ]
    );

    await client.query("COMMIT");
    return updated.rows[0];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  STATES,
  TERMINAL_STATES,
  ALLOWED_TRANSITIONS,
  MAX_ATTEMPTS_DEFAULT,
  ATTEMPT_WINDOW_HOURS,
  InvalidTransitionError,
  GuardrailViolationError,
  assertTransitionAllowed,
  assertWithinAttemptCap,
  assertNotTerminal,
  transition,
  writeAuditLog,
};
