import { useMemo, useState } from "react";
import { CatStage } from "./components/CatStage";
import { HiddenCamera } from "./components/HiddenCamera";
import { listMemes, getMeme } from "./memes/memeRegistry";
import { preloadAllMemes } from "./memes/preloadMemes";

type Status = "Idle" | "Loading" | "Running" | string;

function App() {
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState<Status>("Idle");
  const [debug, setDebug] = useState(false);
  const [sensitivity, setSensitivity] = useState(50);
  const [selectedKey, setSelectedKey] = useState("neutral");

  const currentMemeAsset = useMemo(() => getMeme(selectedKey), [selectedKey]);

  const handleStart = async () => {
    setStatus("Loading");
    await preloadAllMemes(listMemes());
    setStarted(true);
    setStatus("Running");
  };

  return (
    <>
      <CatStage asset={currentMemeAsset} />

      <HiddenCamera
        started={started}
        onVideoReady={() => {
          if (status !== "Running") {
            setStatus("Running");
          }
        }}
        onError={(msg) => setStatus(msg)}
      />

      <div
        style={{
          position: "fixed",
          left: 16,
          top: 16,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          padding: "10px 12px",
          background: "rgba(0, 0, 0, 0.6)",
          color: "#fff",
          fontSize: 14,
          borderRadius: 6,
        }}
      >
        <button onClick={handleStart} disabled={status === "Loading"}>
          Start
        </button>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={debug}
            onChange={(event) => setDebug(event.target.checked)}
          />
          Debug
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Sensitivity
          <input
            type="range"
            min={0}
            max={100}
            value={sensitivity}
            onChange={(event) => setSensitivity(Number(event.target.value))}
          />
        </label>
        <div>Status: {status}</div>
      </div>

      <div
        style={{
          position: "fixed",
          right: 16,
          top: 16,
          display: "flex",
          gap: 8,
          padding: "10px 12px",
          background: "rgba(0, 0, 0, 0.6)",
          color: "#fff",
          fontSize: 14,
          borderRadius: 6,
        }}
      >
        {["neutral", "smile", "scream", "judging"].map((key) => (
          <button key={key} onClick={() => setSelectedKey(key)}>
            {key}
          </button>
        ))}
      </div>
    </>
  );
}

export default App;
