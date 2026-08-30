# Autonomous Smart-Dunning & Mandate Salvage Engine

Built for the **Razorpay AI Builder Internship — Track 3: AI Revenue Recovery**.

An intelligent, fault-tolerant subscription-payment recovery engine that:

1. Intercepts failed payment webhooks (HMAC-verified, idempotency-locked).
2. Diagnoses the root cause with ML (`GradientBoostingRegressor` + `RandomForestClassifier`) trained on a realistic synthetic dataset of 12,000 failed transactions.
3. Orchestrates recovery — automated retries or smart payment links — under strict financial guardrails (hard attempt caps, 72h windows, zero double-charges).
4. Visualizes every state transition live inside an interactive, cybernetic 3D WebGL pipeline.

## Architecture

```
                       ┌──────────────────┐
  Razorpay Webhook ───▶│ Backend (Node.js)│──HTTP──▶ ML Service (FastAPI)
                       │ Express + BullMQ │◀────────  RandomForest + GBR
                       │ + Socket.IO      │
                       └────────┬─────────┘
                                │ pipeline:event (WebSocket)
                                ▼
                       ┌──────────────────┐
                       │ Frontend (Vite)  │
                       │ React Three Fiber│
                       │ CyberScene3D +   │
                       │ Glassmorphic HUD │
                       └──────────────────┘
        PostgreSQL (recovery_cases, recovery_audit_logs, webhook_events)
        Redis (idempotency locks + BullMQ delayed-retry queue)
```

## State Machine

```
DETECTED → DIAGNOSING → QUEUED_RETRY ────────▶ RECOVERED
                      └▶ SMART_LINK_DISPATCHED ┘
                      └▶ PERMANENTLY_FAILED (attempt cap / window expired)
```

Enforced in `backend/src/stateMachine.js`: illegal transitions throw, terminal
states can never re-open, and every transition writes an immutable row to
`recovery_audit_logs` with the ML confidence score and decision rationale.

## Quick start (Docker Compose)

```bash
docker compose up --build
```

This brings up Postgres (schema auto-applied from `schema.sql`), Redis, the
FastAPI ML service (trains on first boot from the synthetic dataset baked
into its image), the Node.js backend on `:4000`, and the Vite frontend on
`:5173`. Open **http://localhost:5173** and use the Interactive Simulation
Sandbox buttons in the HUD to trigger a live recovery run end-to-end.

Before pointing this at a real Razorpay account, edit `backend/.env` and set
`RAZORPAY_WEBHOOK_SECRET` (and optionally `RAZORPAY_KEY_ID` /
`RAZORPAY_KEY_SECRET` to place real recurring charges instead of running the
retry worker's deterministic simulation mode).

## Running services individually (development)

```bash
# 1. Generate the synthetic dataset
python3 generate_fintech_dataset.py

# 2. ML service
cd ml-service && pip install -r requirements.txt --break-system-packages
uvicorn app:app --reload --port 8000

# 3. Postgres + Redis (or point DATABASE_URL/REDIS_URL at existing instances)
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine
psql postgres://postgres:postgres@localhost:5432/postgres -f schema.sql
docker run -d -p 6379:6379 redis:7-alpine

# 4. Backend
cd backend && npm install && cp .env.example .env && npm run dev

# 5. Frontend
cd frontend && npm install && cp .env.example .env && npm run dev
```

## Financial safety guardrails

| Guardrail | Where enforced |
|---|---|
| HMAC SHA256 webhook signature verification | `backend/src/webhookHandler.js::verifySignature` |
| Idempotency lock (`lock:webhook:<payment_id>`) | `backend/src/redisLock.js` |
| Hard cap of 3 attempts / 72h per mandate | `backend/src/stateMachine.js::assertWithinAttemptCap` |
| No transitions out of a terminal state | `backend/src/stateMachine.js::assertNotTerminal` |
| Full audit trail of every decision | `recovery_audit_logs` table, written inside the same DB transaction as every state transition |

## Repository layout

```
generate_fintech_dataset.py     synthetic dataset generator (12,000 rows)
schema.sql                      PostgreSQL schema, indexes, audit views
docker-compose.yml              5-service orchestration

ml-service/
  app.py                        FastAPI: /predict, /train, /health
  requirements.txt / Dockerfile

backend/
  server.js                     Express + Socket.IO + BullMQ wiring, sandbox endpoints
  src/stateMachine.js            state machine + guardrails
  src/webhookHandler.js          signature verification + orchestration
  src/retryWorker.js             BullMQ worker executing delayed retries
  src/redisLock.js               distributed idempotency lock
  src/mlClient.js / src/db.js    ML client, Postgres pool + audit logging

frontend/
  src/components/CyberScene3D.jsx   R3F/Three.js pipeline visualization
  src/components/HUDOverlay.jsx     glassmorphic metrics + simulation sandbox
  src/lib/pipelineSocket.js         Socket.IO client + REST helpers
```
