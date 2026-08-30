// src/webhookHandler.js
// Verifies Razorpay webhook signatures (HMAC SHA256), enforces the
// idempotency lock, persists the raw event, drives the DETECTED -> DIAGNOSING
// transition, calls the ML Diagnostic Core, and routes into QUEUED_RETRY /
// SMART_LINK_DISPATCHED / PERMANENTLY_FAILED. Emits WebSocket events at every
// step for the 3D visualizer.

const crypto = require("crypto");
const { pool } = require("./db");
const { RedisLock } = require("./redisLock");
const { diagnose } = require("./mlClient");
const {
  STATES,
  GuardrailViolationError,
  transition,
} = require("./stateMachine");

const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "";

/**
 * Constant-time HMAC SHA256 signature verification. Any unsigned or spoofed
 * payload is rejected before it touches business logic.
 */
function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader || !RAZORPAY_WEBHOOK_SECRET) return false;

  const expected = crypto
    .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(signatureHeader, "utf8");

  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

function extractHourAndDay(date = new Date()) {
  return { hour: date.getUTCHours(), day: date.getUTCDate() };
}

/**
 * Find-or-create the recovery_cases row for an incoming failed-payment event.
 */
async function upsertRecoveryCase(payload) {
  const {
    payment_id: paymentId,
    subscription_id: subscriptionId = null,
    customer_id: customerId = null,
    bank_code: bankCode,
    payment_method: paymentMethod,
    error_code: errorCode,
    amount_inr: amountInr,
  } = payload;

  const { rows: existing } = await pool.query(
    "SELECT * FROM recovery_cases WHERE payment_id = $1",
    [paymentId]
  );
  if (existing.length > 0) {
    return { caseRow: existing[0], isNew: false };
  }

  const { rows: inserted } = await pool.query(
    `INSERT INTO recovery_cases
       (payment_id, subscription_id, customer_id, bank_code, payment_method, error_code, amount_inr, current_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      paymentId,
      subscriptionId,
      customerId,
      bankCode,
      paymentMethod,
      errorCode,
      amountInr,
      STATES.DETECTED,
    ]
  );
  return { caseRow: inserted[0], isNew: true };
}

/**
 * Runs ML diagnosis for a case that is already sitting in DIAGNOSING and
 * routes it onward to QUEUED_RETRY, SMART_LINK_DISPATCHED, or
 * PERMANENTLY_FAILED (attempt cap / ML outage). This is the shared second
 * half of the pipeline: both a fresh webhook (DETECTED -> DIAGNOSING) and a
 * failed retry cycling back (QUEUED_RETRY -> DIAGNOSING, see
 * retryWorker.js) must run through this exact same routing logic, or a case
 * that bounces back to DIAGNOSING after a failed retry would sit there
 * forever with nothing to advance it.
 */
async function diagnoseAndRoute(diagnosingCaseRow, { io, retryQueue }) {
  const { hour, day } = extractHourAndDay();
  const diagnosing = diagnosingCaseRow;

  let diagnosis;
  try {
    diagnosis = await diagnose({
      transactionId: diagnosing.payment_id,
      bankCode: diagnosing.bank_code,
      paymentMethod: diagnosing.payment_method,
      errorCode: diagnosing.error_code,
      timestampHour: hour,
      dayOfMonth: day,
      amountInr: Number(diagnosing.amount_inr),
      pastUserFailureCount: diagnosing.attempt_count,
    });
  } catch (err) {
    // ML service degraded: fail safe into PERMANENTLY_FAILED rather than
    // guessing a financial action with no model backing.
    const failed = await transition({
      caseId: diagnosing.id,
      toState: STATES.PERMANENTLY_FAILED,
      decisionRationale: `ML Diagnostic Core unavailable: ${err.message}`,
    });
    io?.emit("pipeline:event", { type: "PERMANENTLY_FAILED", caseId: failed.id, paymentId: failed.payment_id });
    return failed;
  }

  try {
    if (diagnosis.recommendedAction === "QUEUED_RETRY") {
      const nextRetryAt = new Date(
        Date.now() + diagnosis.optimalRetryDelayHours * 60 * 60 * 1000
      );
      const updated = await transition({
        caseId: diagnosing.id,
        toState: STATES.QUEUED_RETRY,
        mlConfidence: diagnosis.confidence,
        decisionRationale: diagnosis.rationale,
        extraFields: {
          failure_classification: diagnosis.failureClassification,
          ml_confidence: diagnosis.confidence,
          optimal_retry_delay_hours: diagnosis.optimalRetryDelayHours,
          next_retry_at: nextRetryAt,
        },
      });

      if (retryQueue) {
        await retryQueue.add(
          "recovery-retry",
          { caseId: updated.id, paymentId: updated.payment_id },
          { delay: diagnosis.optimalRetryDelayHours * 60 * 60 * 1000 }
        );
      }

      io?.emit("pipeline:event", {
        type: "QUEUED_RETRY",
        caseId: updated.id,
        paymentId: updated.payment_id,
        bankCode: updated.bank_code,
        retryDelayHours: diagnosis.optimalRetryDelayHours,
        confidence: diagnosis.confidence,
      });
      return updated;
    }

    // SMART_LINK_DISPATCHED
    const smartLinkUrl = `https://rzp.io/i/salvage-${diagnosing.payment_id}`;
    const updated = await transition({
      caseId: diagnosing.id,
      toState: STATES.SMART_LINK_DISPATCHED,
      mlConfidence: diagnosis.confidence,
      decisionRationale: diagnosis.rationale,
      extraFields: {
        failure_classification: diagnosis.failureClassification,
        ml_confidence: diagnosis.confidence,
        optimal_retry_delay_hours: diagnosis.optimalRetryDelayHours,
        smart_link_url: smartLinkUrl,
      },
    });

    io?.emit("pipeline:event", {
      type: "SMART_LINK_DISPATCHED",
      caseId: updated.id,
      paymentId: updated.payment_id,
      smartLinkUrl,
      confidence: diagnosis.confidence,
    });
    return updated;
  } catch (err) {
    if (err instanceof GuardrailViolationError) {
      const failed = await transition({
        caseId: diagnosing.id,
        toState: STATES.PERMANENTLY_FAILED,
        decisionRationale: err.message,
      });
      io?.emit("pipeline:event", { type: "PERMANENTLY_FAILED", caseId: failed.id, paymentId: failed.payment_id });
      return failed;
    }
    throw err;
  }
}

/**
 * Core orchestration entry point for a brand-new failed-payment event:
 * DETECTED -> DIAGNOSING -> (delegates routing to diagnoseAndRoute).
 */
async function processFailedPaymentEvent(payload, { io, retryQueue }) {
  const { caseRow } = await upsertRecoveryCase(payload);

  io?.emit("pipeline:event", {
    type: "DETECTED",
    caseId: caseRow.id,
    paymentId: caseRow.payment_id,
    bankCode: caseRow.bank_code,
    amountInr: Number(caseRow.amount_inr),
  });

  // DETECTED -> DIAGNOSING
  const diagnosing = await transition({
    caseId: caseRow.id,
    toState: STATES.DIAGNOSING,
    decisionRationale: "Webhook verified; handing off to ML Diagnostic Core.",
  });

  io?.emit("pipeline:event", {
    type: "DIAGNOSING",
    caseId: diagnosing.id,
    paymentId: diagnosing.payment_id,
  });

  return diagnoseAndRoute(diagnosing, { io, retryQueue });
}

/**
 * Express handler: verify signature -> idempotency lock -> persist raw event
 * -> orchestrate. Returns 200 quickly (Razorpay expects a fast ack); heavy
 * lifting still happens inline here for simplicity, but in production this
 * would enqueue to BullMQ immediately and ack before diagnosis completes.
 */
function buildWebhookHandler({ redisClient, io, retryQueue }) {
  const lock = new RedisLock(redisClient);

  return async function webhookHandler(req, res) {
    const signature = req.headers["x-razorpay-signature"];
    const rawBody = req.rawBody; // populated by the raw-body-capturing middleware in server.js

    const signatureValid = verifySignature(rawBody, signature);
    if (!signatureValid) {
      return res.status(401).json({ error: "Invalid or missing webhook signature." });
    }

    const payload = req.body?.payload?.payment_failure || req.body;
    const eventId = req.body?.id || `${payload.payment_id}-${Date.now()}`;

    // Idempotency Gatekeeper, part 2: Razorpay may redeliver the exact same
    // event_id well after the first delivery already completed (outside the
    // short-lived Redis lock's window), e.g. on a delayed retry from their
    // side. webhook_events.event_id is UNIQUE, so an INSERT that reports zero
    // rows written means we've already processed this exact event — ack and
    // stop, rather than re-running the state machine and double-incrementing
    // attempt_count for a payment that was never actually re-attempted.
    let isNewEvent = true;
    try {
      const insertResult = await pool.query(
        `INSERT INTO webhook_events (event_id, payment_id, event_type, signature_valid, raw_payload)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (event_id) DO NOTHING`,
        [eventId, payload.payment_id, req.body?.event || "payment.failed", signatureValid, req.body]
      );
      isNewEvent = insertResult.rowCount > 0;
    } catch (err) {
      console.error("[webhookHandler] Failed to persist webhook_events row", err);
    }

    if (!isNewEvent) {
      return res.status(200).json({ status: "duplicate_event_ignored", eventId });
    }

    const release = await lock.acquire(payload.payment_id);
    if (!release) {
      // Another in-flight webhook delivery for the same payment_id is already
      // being processed — ack 200 so Razorpay doesn't keep retrying, but do
      // no further work here (idempotency gatekeeper).
      return res.status(200).json({ status: "duplicate_ignored" });
    }

    try {
      const result = await processFailedPaymentEvent(payload, { io, retryQueue });
      return res.status(200).json({ status: "processed", state: result.current_state });
    } catch (err) {
      console.error("[webhookHandler] Processing error", err);
      return res.status(500).json({ error: "Internal processing error." });
    } finally {
      await release();
    }
  };
}

module.exports = {
  verifySignature,
  upsertRecoveryCase,
  diagnoseAndRoute,
  processFailedPaymentEvent,
  buildWebhookHandler,
};
