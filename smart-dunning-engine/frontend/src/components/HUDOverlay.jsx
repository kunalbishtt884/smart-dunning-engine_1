// src/components/HUDOverlay.jsx
//
// Glassmorphic HUD: live revenue-recovery metric cards + the Interactive
// Simulation Sandbox control panel whose preset buttons POST to the backend
// to demonstrate the live 3D recovery pipeline in real time.

import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Activity, IndianRupee, ShieldCheck, Zap, Radio, AlertTriangle } from "lucide-react";
import { fetchMetrics, triggerSimulation } from "../lib/pipelineSocket";

const SIMULATION_PRESETS = [
  { key: "sbi_2am_maintenance_crash", label: "2 AM SBI Maintenance Crash", icon: Zap },
  { key: "eom_low_balance", label: "EOM Low Balance", icon: IndianRupee },
  { key: "expired_mandate", label: "Expired Mandate", icon: AlertTriangle },
];

function formatInr(value) {
  const n = Number(value || 0);
  return `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function MetricCard({ icon: Icon, label, value, accent }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-panel rounded-xl px-4 py-3 min-w-[168px]"
    >
      <div className="flex items-center gap-2 text-mist text-xs uppercase tracking-wider mb-1">
        <Icon size={14} style={{ color: accent }} />
        {label}
      </div>
      <div className="font-mono text-xl font-semibold" style={{ color: accent }}>
        {value}
      </div>
    </motion.div>
  );
}

export default function HUDOverlay({ liveConnected, recentEvent }) {
  const [metrics, setMetrics] = useState(null);
  const [simInFlight, setSimInFlight] = useState(null);
  const [simError, setSimError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await fetchMetrics();
        if (!cancelled) setMetrics(data);
      } catch (err) {
        // Backend not reachable (e.g. static frontend preview) — HUD just
        // keeps showing placeholder dashes rather than throwing.
      }
    };
    poll();
    const id = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [recentEvent]);

  const runSimulation = async (presetKey) => {
    setSimInFlight(presetKey);
    setSimError(null);
    try {
      await triggerSimulation(presetKey);
    } catch (err) {
      setSimError(`${presetKey} failed — is the backend running?`);
    } finally {
      setTimeout(() => setSimInFlight(null), 800);
    }
  };

  return (
    <div className="pointer-events-none absolute inset-0 p-5 flex flex-col justify-between font-display">
      {/* Top bar: title + connection state */}
      <div className="flex items-start justify-between">
        <div className="glass-panel rounded-xl px-5 py-3 pointer-events-auto">
          <h1 className="text-lg font-semibold tracking-tight">
            Autonomous Smart-Dunning &amp; Mandate Salvage Engine
          </h1>
          <p className="text-mist text-xs mt-0.5">Razorpay AI Builder Internship — Track 3: AI Revenue Recovery</p>
        </div>
        <div className="glass-panel rounded-xl px-4 py-3 flex items-center gap-2 pointer-events-auto">
          <Radio size={14} className={liveConnected ? "text-salvage" : "text-diagnostic"} />
          <span className="text-xs font-mono text-mist">
            {liveConnected ? "LIVE PIPELINE CONNECTED" : "SANDBOX DEMO MODE"}
          </span>
        </div>
      </div>

      {/* Metric cards */}
      <div className="flex flex-wrap gap-3 pointer-events-auto">
        <MetricCard
          icon={Activity}
          label="Gross Failed Volume"
          value={formatInr(metrics?.gross_failed_volume_inr)}
          accent="#ef4444"
        />
        <MetricCard
          icon={ShieldCheck}
          label="Salvaged Revenue"
          value={formatInr(metrics?.salvaged_revenue_inr)}
          accent="#34d399"
        />
        <MetricCard
          icon={Zap}
          label="Net Salvage Rate"
          value={`${metrics?.net_salvage_rate_pct ?? 0}%`}
          accent="#22d3ee"
        />
        <MetricCard
          icon={ShieldCheck}
          label="Churn Prevented"
          value={metrics?.churn_prevented_count ?? 0}
          accent="#a78bfa"
        />
      </div>

      {/* Simulation Sandbox */}
      <div className="glass-panel rounded-xl px-5 py-4 pointer-events-auto self-start">
        <div className="text-xs uppercase tracking-wider text-mist mb-3">
          Interactive Simulation Sandbox
        </div>
        <div className="flex flex-wrap gap-2">
          {SIMULATION_PRESETS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => runSimulation(key)}
              disabled={simInFlight === key}
              className="flex items-center gap-2 rounded-lg border border-panel-border bg-panel/60 px-3 py-2 text-sm hover:border-cyanpulse/60 hover:shadow-glow transition-all disabled:opacity-50"
            >
              <Icon size={14} className="text-cyanpulse" />
              {simInFlight === key ? "Dispatching…" : `Simulate ${label}`}
            </button>
          ))}
        </div>
        {simError && <p className="text-terminal text-xs mt-2">{simError}</p>}
        {recentEvent && (
          <p className="text-mist text-xs mt-3 font-mono">
            latest: <span className="text-cyanpulse">{recentEvent.type}</span> ·{" "}
            {recentEvent.paymentId}
            {recentEvent.bankCode ? ` · ${recentEvent.bankCode}` : ""}
          </p>
        )}
      </div>
    </div>
  );
}
