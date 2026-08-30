// server.js
// Entry point: wires up Express, Socket.IO, Redis (BullMQ + locks), Postgres,
// the webhook route, the retry worker, and the Simulation Sandbox endpoints
// that the HUD's preset trigger buttons POST to.

require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server: SocketIOServer } = require("socket.io");
const { Queue } = require("bullmq");
const Redis = require("ioredis");
const { v4: uuidv4 } = require("uuid");

const { pool } = require("./src/db");
const { buildWebhookHandler, processFailedPaymentEvent } = require("./src/webhookHandler");
const { buildRetryWorker } = require("./src/retryWorker");

const PORT = process.env.PORT || 4000;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: process.env.FRONTEND_ORIGIN || "*" },
});

// --- Redis connections -------------------------------------------------
// BullMQ requires its own ioredis connection with maxRetriesPerRequest: null.
const bullConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const lockRedisClient = new Redis(REDIS_URL);

const retryQueue = new Queue("recovery-retry", { connection: bullConnection });

// --- Middleware ----------------------------------------------------------
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "*" }));

// Capture the raw request body (needed for HMAC signature verification)
// while still populating req.body with the parsed JSON for convenience.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// --- Routes ----------------------------------------------------------------

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Razorpay (or Razorpay-shaped) webhook endpoint.
app.post(
  "/webhooks/razorpay",
  buildWebhookHandler({ redisClient: lockRedisClient, io, retryQueue })
);

// Live HUD metrics (Gross Failed Volume, Salvaged Revenue, Net Salvage Rate, Churn Prevented).
app.get("/api/metrics", async (_req, res) => {
  const { rows } = await pool.query("SELECT * FROM recovery_metrics");
  res.json(rows[0]);
});

// Recent cases feed for the pipeline / node inspector panel.
app.get("/api/cases", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const { rows } = await pool.query(
    "SELECT * FROM recovery_cases ORDER BY updated_at DESC LIMIT $1",
    [limit]
  );
  res.json(rows);
});

app.get("/api/cases/:paymentId/audit-log", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT al.* FROM recovery_audit_logs al
     JOIN recovery_cases c ON c.id = al.case_id
     WHERE c.payment_id = $1
     ORDER BY al.created_at ASC`,
    [req.params.paymentId]
  );
  res.json(rows);
});

// --- Interactive Simulation Sandbox ---------------------------------------
// The HUD's preset trigger buttons POST here to demonstrate the live 3D
// recovery pipeline without needing a real Razorpay webhook delivery.

const SIMULATION_PRESETS = {
  sbi_2am_maintenance_crash: {
    label: "Simulate 2 AM SBI Maintenance Crash",
    bank_code: "SBI",
    payment_method: "UPI_AUTOPAY",
    error_code: "GATEWAY_DOWNTIME",
    amount_inr: () => Number((Math.random() * 2000 + 199).toFixed(2)),
  },
  eom_low_balance: {
    label: "Simulate EOM Low Balance",
    bank_code: "HDFC",
    payment_method: "DEBIT_CARD_MANDATE",
    error_code: "INSUFFICIENT_FUNDS",
    amount_inr: () => Number((Math.random() * 8000 + 499).toFixed(2)),
  },
  expired_mandate: {
    label: "Simulate Expired Mandate",
    bank_code: "ICICI",
    payment_method: "CREDIT_CARD",
    error_code: "CARD_EXPIRED",
    amount_inr: () => Number((Math.random() * 15000 + 999).toFixed(2)),
  },
};

app.get("/api/simulations", (_req, res) => {
  res.json(
    Object.entries(SIMULATION_PRESETS).map(([key, preset]) => ({
      key,
      label: preset.label,
    }))
  );
});

app.post("/api/simulations/:presetKey", async (req, res) => {
  const preset = SIMULATION_PRESETS[req.params.presetKey];
  if (!preset) {
    return res.status(404).json({ error: `Unknown simulation preset '${req.params.presetKey}'.` });
  }

  const syntheticPayload = {
    payment_id: `sim_${uuidv4()}`,
    subscription_id: `sub_sim_${uuidv4().slice(0, 8)}`,
    customer_id: `cust_sim_${uuidv4().slice(0, 8)}`,
    bank_code: preset.bank_code,
    payment_method: preset.payment_method,
    error_code: preset.error_code,
    amount_inr: preset.amount_inr(),
  };

  try {
    const result = await processFailedPaymentEvent(syntheticPayload, { io, retryQueue });
    res.status(200).json({ status: "simulated", payload: syntheticPayload, finalState: result.current_state });
  } catch (err) {
    console.error("[simulation] error", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Socket.IO -------------------------------------------------------------
io.on("connection", (socket) => {
  console.log(`[socket.io] client connected: ${socket.id}`);
  socket.on("disconnect", () => console.log(`[socket.io] client disconnected: ${socket.id}`));
});

// --- Boot --------------------------------------------------------------
const retryWorker = buildRetryWorker({ connection: bullConnection, io, retryQueue });

retryWorker.on("failed", (job, err) => {
  console.error(`[retryWorker] Job ${job?.id} failed:`, err.message);
});

server.listen(PORT, () => {
  console.log(`[server] Smart-Dunning orchestrator listening on :${PORT}`);
  console.log(`[server] ML service: ${process.env.ML_SERVICE_URL || "http://localhost:8000"}`);
});

process.on("SIGTERM", async () => {
  console.log("[server] SIGTERM received, shutting down gracefully...");
  await retryWorker.close();
  await retryQueue.close();
  await pool.end();
  server.close(() => process.exit(0));
});

module.exports = { app, server, io };
