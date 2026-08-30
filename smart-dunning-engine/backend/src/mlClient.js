// src/mlClient.js
// Thin HTTP client for the Python FastAPI ML Diagnostic Core.

const ML_SERVICE_URL = process.env.ML_SERVICE_URL || "http://localhost:8000";

/**
 * Calls POST /predict on the ML service. Throws on non-2xx so callers can
 * decide how to degrade (e.g. fall back to a conservative default policy).
 */
async function diagnose({
  transactionId,
  bankCode,
  paymentMethod,
  errorCode,
  timestampHour,
  dayOfMonth,
  amountInr,
  pastUserFailureCount,
}) {
  const res = await fetch(`${ML_SERVICE_URL}/predict`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transaction_id: transactionId,
      bank_code: bankCode,
      payment_method: paymentMethod,
      error_code: errorCode,
      timestamp_hour: timestampHour,
      day_of_month: dayOfMonth,
      amount_inr: amountInr,
      past_user_failure_count: pastUserFailureCount,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ML service /predict failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  return {
    failureClassification: data.failure_classification,
    confidence: data.confidence,
    optimalRetryDelayHours: data.optimal_retry_delay_hours,
    recommendedAction: data.recommended_action, // "QUEUED_RETRY" | "SMART_LINK_DISPATCHED"
    rationale: data.rationale,
  };
}

module.exports = { diagnose, ML_SERVICE_URL };
