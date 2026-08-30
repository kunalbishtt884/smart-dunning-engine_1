// src/lib/pipelineSocket.js
//
// Thin wrapper around the Socket.IO client that normalizes backend
// `pipeline:event` messages and, if no backend is reachable within a short
// grace period, falls back to generating clearly-labeled synthetic demo
// events so the 3D canvas is never just an empty void when running the
// frontend standalone (e.g. `vite dev` without docker-compose up).

import { io } from "socket.io-client";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";
const CONNECT_GRACE_PERIOD_MS = 4000;

const BANKS = ["HDFC", "SBI", "ICICI", "AXIS", "KOTAK"];
const DEMO_PAYMENT_STAGES = ["DETECTED", "DIAGNOSING", "QUEUED_RETRY", "RECOVERED"];

function randomOf(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * subscribe(callback) -> unsubscribe function
 * callback receives normalized events:
 *   { type, caseId, paymentId, bankCode, amountInr, retryDelayHours, confidence, smartLinkUrl, source }
 */
export function subscribeToPipeline(callback) {
  const socket = io(BACKEND_URL, { transports: ["websocket"], reconnectionAttempts: 5 });

  let connected = false;
  let demoInterval = null;
  let demoTimeout = null;

  socket.on("connect", () => {
    connected = true;
    if (demoInterval) clearInterval(demoInterval);
    if (demoTimeout) clearTimeout(demoTimeout);
  });

  socket.on("pipeline:event", (evt) => {
    callback({ ...evt, source: "live" });
  });

  const startDemoMode = () => {
    if (connected || demoInterval) return;
    let tick = 0;
    demoInterval = setInterval(() => {
      tick += 1;
      const paymentId = `demo_${tick}`;
      const bankCode = randomOf(BANKS);
      const stageIdx = tick % DEMO_PAYMENT_STAGES.length;
      callback({
        type: DEMO_PAYMENT_STAGES[stageIdx],
        caseId: paymentId,
        paymentId,
        bankCode,
        amountInr: Math.round(Math.random() * 8000 + 199),
        confidence: Number((Math.random() * 0.3 + 0.65).toFixed(2)),
        retryDelayHours: Number((Math.random() * 6 + 0.5).toFixed(1)),
        source: "demo",
      });
    }, 1400);
  };

  demoTimeout = setTimeout(startDemoMode, CONNECT_GRACE_PERIOD_MS);

  return () => {
    if (demoInterval) clearInterval(demoInterval);
    if (demoTimeout) clearTimeout(demoTimeout);
    socket.disconnect();
  };
}

export async function triggerSimulation(presetKey) {
  const res = await fetch(`${BACKEND_URL}/api/simulations/${presetKey}`, { method: "POST" });
  if (!res.ok) throw new Error(`Simulation trigger failed: ${res.status}`);
  return res.json();
}

export async function fetchMetrics() {
  const res = await fetch(`${BACKEND_URL}/api/metrics`);
  if (!res.ok) throw new Error(`Metrics fetch failed: ${res.status}`);
  return res.json();
}

export async function fetchSimulationPresets() {
  const res = await fetch(`${BACKEND_URL}/api/simulations`);
  if (!res.ok) throw new Error(`Presets fetch failed: ${res.status}`);
  return res.json();
}

export { BACKEND_URL };
