// src/retryWorker.js
// BullMQ worker that executes delayed retry jobs queued by webhookHandler.js
// when a case enters QUEUED_RETRY. Each job either salvages the mandate
// (-> RECOVERED) or, if attempts are exhausted, cycles back through
// DIAGNOSING or falls to PERMANENTLY_FAILED.

const { Worker } = require("bullmq");
const Razorpay = require("razorpay");
const { pool } = require("./db");
const {
  STATES,
  GuardrailViolationError,
  transition,
} = require("./stateMachine");
const { diagnoseAndRoute } = require("./webhookHandler");

const razorpay =
  process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
    ? new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      })
    : null;

/**
 * Attempts to re-charge the mandate. In a real deployment this calls the
 * Razorpay Recurring Payments "charge" API for the underlying subscription.
 * Falls back to a deterministic simulation when no live credentials are
 * configured, so the Simulation Sandbox works out-of-the-box in a demo/dev
 * environment.
 */
async function attemptRecharge(caseRow) {
  if (razorpay) {
    try {
      // Real integration point — subscription_id must be present on the case.
      await razorpay.subscriptions.charge(caseRow.subscription_id, {
        // Razorpay's recurring-charge API details vary by mandate type; this
        // is deliberately minimal so it's obvious where to extend it.
      });
      return { success: true };
    } catch (err) {
      return { success: false, reason: err.message };
    }
  }

  // Simulation mode: bias success by predicted classification/confidence so
  // the sandbox demo behaves plausibly instead of randomly.
  const confidence = Number(caseRow.ml_confidence || 0.5);
  const success = Math.random() < confidence;
  return { success, reason: success ? null : "simulated_bank_decline" };
}

function buildRetryWorker({ connection, io, retryQueue }) {
  return new Worker(
    "recovery-retry",
    async (job) => {
      const { caseId, paymentId } = job.data;

      const { rows } = await pool.query("SELECT * FROM recovery_cases WHERE id = $1", [caseId]);
      if (rows.length === 0) {
        console.warn(`[retryWorker] Case ${caseId} not found; skipping job.`);
        return;
      }
      const caseRow = rows[0];

      if (caseRow.current_state !== STATES.QUEUED_RETRY) {
        // Case moved on (e.g. resolved manually, or already terminal) —
        // idempotency guard against stale delayed jobs.
        console.log(
          `[retryWorker] Case ${paymentId} no longer QUEUED_RETRY (now ${caseRow.current_state}); skipping.`
        );
        return;
      }

      const { success, reason } = await attemptRecharge(caseRow);

      if (success) {
        const recovered = await transition({
          caseId,
          toState: STATES.RECOVERED,
          decisionRationale: "Recovery retry succeeded — mandate salvaged.",
        });
        io?.emit("pipeline:event", {
          type: "RECOVERED",
          caseId: recovered.id,
          paymentId: recovered.payment_id,
          amountInr: Number(recovered.amount_inr),
        });
        return recovered;
      }

      // Retry failed. Re-diagnose if attempts remain, else fail permanently.
      try {
        const rediagnosing = await transition({
          caseId,
          toState: STATES.DIAGNOSING,
          decisionRationale: `Retry attempt failed (${reason}); re-diagnosing before next action.`,
        });
        io?.emit("pipeline:event", {
          type: "DIAGNOSING",
          caseId: rediagnosing.id,
          paymentId: rediagnosing.payment_id,
        });
        // Immediately route the re-diagnosed case onward (QUEUED_RETRY /
        // SMART_LINK_DISPATCHED / PERMANENTLY_FAILED) — without this, a case
        // that bounces back to DIAGNOSING after a failed retry would sit
        // here forever with nothing left to advance it.
        return await diagnoseAndRoute(rediagnosing, { io, retryQueue });
      } catch (err) {
        if (err instanceof GuardrailViolationError) {
          const failed = await transition({
            caseId,
            toState: STATES.PERMANENTLY_FAILED,
            decisionRationale: err.message,
          });
          io?.emit("pipeline:event", {
            type: "PERMANENTLY_FAILED",
            caseId: failed.id,
            paymentId: failed.payment_id,
          });
          return failed;
        }
        throw err;
      }
    },
    { connection }
  );
}

module.exports = { buildRetryWorker, attemptRecharge };
