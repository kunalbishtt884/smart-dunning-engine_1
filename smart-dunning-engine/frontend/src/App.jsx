import React, { useEffect, useState } from "react";
import CyberScene3D, { usePipelineParticles } from "./components/CyberScene3D.jsx";
import HUDOverlay from "./components/HUDOverlay.jsx";
import { subscribeToPipeline } from "./lib/pipelineSocket.js";

export default function App() {
  const { journeys, ingest, removeJourney } = usePipelineParticles();
  const [liveConnected, setLiveConnected] = useState(false);
  const [recentEvent, setRecentEvent] = useState(null);

  useEffect(() => {
    const unsubscribe = subscribeToPipeline((evt) => {
      setLiveConnected(evt.source === "live");
      setRecentEvent(evt);
      ingest(evt);
    });
    return unsubscribe;
  }, [ingest]);

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-void">
      <CyberScene3D journeys={journeys} onArrive={removeJourney} />
      <HUDOverlay liveConnected={liveConnected} recentEvent={recentEvent} />
    </div>
  );
}
