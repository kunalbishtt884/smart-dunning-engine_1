// src/components/CyberScene3D.jsx
//
// Interactive 3D WebGL scene rendering the recovery pipeline as a cybernetic
// transaction network: Ingestion Portal -> ML Diagnostic Core -> Bank Delay
// Queue Orbits / Smart Link Dispatch -> Salvaged Vault. Live transactions
// (driven by `pipeline:event` messages) travel between nodes as glowing
// particles along quadratic Bezier splines.

import React, { useMemo, useRef, useState, useCallback } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Text, Sparkles, Trail } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";

const BANKS = ["HDFC", "SBI", "ICICI", "AXIS", "KOTAK"];

const NODES = {
  INGESTION: new THREE.Vector3(-7.5, 0, 0),
  ML_CORE: new THREE.Vector3(-2.2, 0.6, 0),
  BANK_HUB: new THREE.Vector3(2.6, 1.8, 0),
  SMART_LINK: new THREE.Vector3(2.6, -2.2, 0),
  VAULT: new THREE.Vector3(8, 0, 0),
};

const BANK_RING_RADIUS = 2.1;

function bankNodePosition(bankCode) {
  const idx = Math.max(0, BANKS.indexOf(bankCode));
  const angle = (idx / BANKS.length) * Math.PI * 2;
  return new THREE.Vector3(
    NODES.BANK_HUB.x + Math.cos(angle) * BANK_RING_RADIUS,
    NODES.BANK_HUB.y + Math.sin(angle) * BANK_RING_RADIUS * 0.5,
    Math.sin(angle * 1.3) * 1.2
  );
}

const EVENT_COLORS = {
  DETECTED: "#e879f9",
  DIAGNOSING: "#f59e0b",
  QUEUED_RETRY: "#22d3ee",
  SMART_LINK_DISPATCHED: "#a78bfa",
  RECOVERED: "#34d399",
  PERMANENTLY_FAILED: "#ef4444",
};

/** Glowing node primitive shared by all pipeline stages. */
function GlowNode({ position, color, label, sublabel, size = 0.55, pulse = 0 }) {
  const meshRef = useRef();
  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    const t = clock.getElapsedTime();
    const wobble = 1 + Math.sin(t * 2 + position.x) * 0.05 + pulse * 0.15;
    meshRef.current.scale.setScalar(wobble);
  });

  return (
    <group position={position}>
      <mesh ref={meshRef}>
        <icosahedronGeometry args={[size, 1]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={1.8}
          roughness={0.25}
          metalness={0.4}
          wireframe={false}
        />
      </mesh>
      <mesh scale={1.9}>
        <icosahedronGeometry args={[size, 0]} />
        <meshBasicMaterial color={color} wireframe transparent opacity={0.12} />
      </mesh>
      {label && (
        <Text
          position={[0, -size - 0.55, 0]}
          fontSize={0.28}
          color="#e6e9f5"
          anchorX="center"
          anchorY="middle"
        >
          {label}
        </Text>
      )}
      {sublabel && (
        <Text
          position={[0, -size - 0.9, 0]}
          fontSize={0.18}
          color="#9aa4c0"
          anchorX="center"
          anchorY="middle"
        >
          {sublabel}
        </Text>
      )}
    </group>
  );
}

/** Static faint spline connecting two nodes, for visual circuitry context. */
function ConnectionSpline({ from, to, arc = 1.4, color = "#334155" }) {
  const points = useMemo(() => {
    const mid = from.clone().lerp(to, 0.5).add(new THREE.Vector3(0, arc, 0));
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
    return curve.getPoints(40);
  }, [from, to, arc]);

  const geometry = useMemo(() => new THREE.BufferGeometry().setFromPoints(points), [points]);

  return (
    <line geometry={geometry}>
      <lineBasicMaterial color={color} transparent opacity={0.35} />
    </line>
  );
}

/** A single live transaction traveling from one node to another. */
function TransactionParticle({ from, to, color, arc, duration = 1.4, onArrive }) {
  const meshRef = useRef();
  const tRef = useRef(0);
  const arrivedRef = useRef(false);

  const curve = useMemo(() => {
    const mid = from.clone().lerp(to, 0.5).add(new THREE.Vector3(0, arc, (Math.random() - 0.5) * 0.8));
    return new THREE.QuadraticBezierCurve3(from, mid, to);
  }, [from, to, arc]);

  useFrame((_, delta) => {
    if (arrivedRef.current || !meshRef.current) return;
    tRef.current = Math.min(1, tRef.current + delta / duration);
    const point = curve.getPoint(tRef.current);
    meshRef.current.position.copy(point);
    const pulse = 1 + Math.sin(tRef.current * Math.PI) * 0.6;
    meshRef.current.scale.setScalar(pulse);

    if (tRef.current >= 1 && !arrivedRef.current) {
      arrivedRef.current = true;
      onArrive?.();
    }
  });

  return (
    <Trail width={2} length={5} color={color} attenuation={(t) => t * t}>
      <mesh ref={meshRef} position={from}>
        <sphereGeometry args={[0.12, 12, 12]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={3} />
      </mesh>
    </Trail>
  );
}

function currentNodeForCase(caseState) {
  switch (caseState?.lastType) {
    case "DETECTED":
      return NODES.INGESTION;
    case "DIAGNOSING":
      return NODES.ML_CORE;
    case "QUEUED_RETRY":
      return bankNodePosition(caseState.bankCode);
    case "SMART_LINK_DISPATCHED":
      return NODES.SMART_LINK;
    default:
      return NODES.ML_CORE;
  }
}

function targetNodeForEvent(evt) {
  switch (evt.type) {
    case "DETECTED":
      return NODES.INGESTION;
    case "DIAGNOSING":
      return NODES.ML_CORE;
    case "QUEUED_RETRY":
      return bankNodePosition(evt.bankCode);
    case "SMART_LINK_DISPATCHED":
      return NODES.SMART_LINK;
    case "RECOVERED":
      return NODES.VAULT;
    case "PERMANENTLY_FAILED":
      return new THREE.Vector3(evt.bankCode ? bankNodePosition(evt.bankCode).x : 0, -5, 0);
    default:
      return NODES.ML_CORE;
  }
}

/**
 * Reduces the raw pipeline-event stream into a map of active traveling
 * particles keyed by paymentId. Exposed as a hook so App.jsx can also read
 * aggregate counts for the HUD without re-deriving state.
 */
export function usePipelineParticles(events) {
  const [journeys, setJourneys] = useState({});
  const caseMemory = useRef({}); // paymentId -> { lastType, bankCode }

  const ingest = useCallback((evt) => {
    const memory = caseMemory.current[evt.paymentId] || {};
    const from = currentNodeForCase(memory).clone();
    const to = targetNodeForEvent(evt).clone();

    caseMemory.current[evt.paymentId] = { lastType: evt.type, bankCode: evt.bankCode || memory.bankCode };

    setJourneys((prev) => ({
      ...prev,
      [evt.paymentId + ":" + evt.type + ":" + Date.now()]: {
        paymentId: evt.paymentId,
        from,
        to,
        color: EVENT_COLORS[evt.type] || "#38bdf8",
        terminal: evt.type === "RECOVERED" || evt.type === "PERMANENTLY_FAILED",
      },
    }));
  }, []);

  const removeJourney = useCallback((key) => {
    setJourneys((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  return { journeys, ingest, removeJourney };
}

function BankRing() {
  return (
    <group>
      {BANKS.map((bank) => {
        const pos = bankNodePosition(bank);
        return (
          <React.Fragment key={bank}>
            <ConnectionSpline from={NODES.ML_CORE} to={pos} arc={0.6} color="#1c2130" />
            <GlowNode position={pos} color="#0ea5e9" label={bank} size={0.32} />
          </React.Fragment>
        );
      })}
      <Text position={[NODES.BANK_HUB.x, NODES.BANK_HUB.y + 2.6, 0]} fontSize={0.24} color="#64748b" anchorX="center">
        BANK DELAY QUEUE ORBITS
      </Text>
    </group>
  );
}

function SceneContents({ journeys, onArrive }) {
  return (
    <>
      <ambientLight intensity={0.35} />
      <pointLight position={[0, 5, 5]} intensity={40} color="#7dd3fc" />
      <pointLight position={[-8, 2, 2]} intensity={30} color="#e879f9" />
      <pointLight position={[8, 0, 2]} intensity={35} color="#34d399" />

      <Sparkles count={120} scale={[20, 10, 6]} size={1.5} speed={0.2} color="#334155" />

      <ConnectionSpline from={NODES.INGESTION} to={NODES.ML_CORE} arc={1.2} />
      <ConnectionSpline from={NODES.ML_CORE} to={NODES.SMART_LINK} arc={-1.0} color="#3b1e5c" />
      <ConnectionSpline from={NODES.BANK_HUB} to={NODES.VAULT} arc={1.0} />
      <ConnectionSpline from={NODES.SMART_LINK} to={NODES.VAULT} arc={-1.0} />

      <GlowNode position={NODES.INGESTION} color="#c026d3" label="INGESTION PORTAL" sublabel="webhook intake" size={0.7} />
      <GlowNode position={NODES.ML_CORE} color="#f59e0b" label="ML DIAGNOSTIC CORE" sublabel="root-cause + delay model" size={0.65} pulse={0.4} />
      <GlowNode position={NODES.SMART_LINK} color="#a78bfa" label="SMART LINK DISPATCH" sublabel="manual salvage path" size={0.45} />
      <GlowNode position={NODES.VAULT} color="#10b981" label="SALVAGED VAULT" sublabel="recovered revenue" size={0.8} />

      <BankRing />

      {Object.entries(journeys).map(([key, j]) => (
        <TransactionParticle
          key={key}
          from={j.from}
          to={j.to}
          color={j.color}
          arc={j.terminal ? 0.6 : 1.3}
          duration={j.terminal ? 1.1 : 1.6}
          onArrive={() => onArrive(key)}
        />
      ))}

      <OrbitControls
        enablePan={false}
        minDistance={8}
        maxDistance={26}
        autoRotate
        autoRotateSpeed={0.35}
      />
    </>
  );
}

export default function CyberScene3D({ journeys, onArrive }) {
  return (
    <Canvas
      camera={{ position: [0, 3, 15], fov: 45 }}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      dpr={[1, 1.75]}
    >
      <color attach="background" args={["#05050a"]} />
      <fog attach="fog" args={["#05050a", 14, 30]} />
      <SceneContents journeys={journeys} onArrive={onArrive} />
      <EffectComposer multisampling={0}>
        <Bloom intensity={1.1} luminanceThreshold={0.15} luminanceSmoothing={0.4} mipmapBlur />
        <Vignette eskil={false} offset={0.2} darkness={0.9} />
      </EffectComposer>
    </Canvas>
  );
}
