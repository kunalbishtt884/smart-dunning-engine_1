-- schema.sql
-- Autonomous Smart-Dunning & Mandate Salvage Engine — PostgreSQL schema

CREATE TYPE recovery_state AS ENUM (
    'DETECTED',
    'DIAGNOSING',
    'QUEUED_RETRY',
    'SMART_LINK_DISPATCHED',
    'RECOVERED',
    'PERMANENTLY_FAILED'
);

-- One row per subscription/mandate payment that has failed at least once.
CREATE TABLE IF NOT EXISTS recovery_cases (
    id                      BIGSERIAL PRIMARY KEY,
    payment_id              TEXT NOT NULL UNIQUE,        -- Razorpay payment/mandate id
    subscription_id         TEXT,
    customer_id             TEXT,
    bank_code               TEXT NOT NULL,
    payment_method          TEXT NOT NULL,
    error_code              TEXT NOT NULL,
    amount_inr              NUMERIC(12, 2) NOT NULL,
    current_state           recovery_state NOT NULL DEFAULT 'DETECTED',
    attempt_count           INTEGER NOT NULL DEFAULT 0,
    max_attempts            INTEGER NOT NULL DEFAULT 3,
    failure_classification  TEXT,
    ml_confidence            NUMERIC(5, 4),
    optimal_retry_delay_hours NUMERIC(8, 2),
    next_retry_at           TIMESTAMPTZ,
    smart_link_url          TEXT,
    detected_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    window_expires_at       TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '72 hours'),
    resolved_at             TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recovery_cases_state ON recovery_cases (current_state);
CREATE INDEX IF NOT EXISTS idx_recovery_cases_next_retry ON recovery_cases (next_retry_at)
    WHERE current_state = 'QUEUED_RETRY';

-- Full audit trail: every state transition, ML decision, and rationale.
CREATE TABLE IF NOT EXISTS recovery_audit_logs (
    id                  BIGSERIAL PRIMARY KEY,
    case_id             BIGINT NOT NULL REFERENCES recovery_cases (id) ON DELETE CASCADE,
    payment_id          TEXT NOT NULL,
    from_state          recovery_state,
    to_state            recovery_state NOT NULL,
    ml_confidence       NUMERIC(5, 4),
    decision_rationale  TEXT,
    metadata            JSONB DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_case_id ON recovery_audit_logs (case_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_payment_id ON recovery_audit_logs (payment_id);

-- Raw webhook events, kept for idempotency verification & replay/debugging.
CREATE TABLE IF NOT EXISTS webhook_events (
    id              BIGSERIAL PRIMARY KEY,
    event_id        TEXT NOT NULL UNIQUE,   -- Razorpay's x-razorpay-event-id or payload event id
    payment_id      TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    signature_valid BOOLEAN NOT NULL,
    raw_payload     JSONB NOT NULL,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_payment_id ON webhook_events (payment_id);

-- Aggregate revenue-recovery metrics feeding the HUD overlay.
CREATE OR REPLACE VIEW recovery_metrics AS
SELECT
    COALESCE(SUM(amount_inr), 0)                                              AS gross_failed_volume_inr,
    COALESCE(SUM(amount_inr) FILTER (WHERE current_state = 'RECOVERED'), 0)   AS salvaged_revenue_inr,
    COALESCE(
        ROUND(
            100.0 * SUM(amount_inr) FILTER (WHERE current_state = 'RECOVERED')
            / NULLIF(SUM(amount_inr), 0),
            2
        ),
        0
    )                                                                         AS net_salvage_rate_pct,
    COUNT(*) FILTER (WHERE current_state = 'RECOVERED')                       AS churn_prevented_count,
    COUNT(*) FILTER (WHERE current_state = 'PERMANENTLY_FAILED')              AS permanently_failed_count,
    COUNT(*)                                                                  AS total_cases
FROM recovery_cases;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recovery_cases_updated_at ON recovery_cases;
CREATE TRIGGER trg_recovery_cases_updated_at
    BEFORE UPDATE ON recovery_cases
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
