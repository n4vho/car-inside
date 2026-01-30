import { useEffect, useMemo, useRef, useState } from "react";
import { CatStage } from "./components/CatStage";
import { HiddenCamera } from "./components/HiddenCamera";
import { listMemes, getMeme } from "./memes/memeRegistry";
import { preloadAllMemes } from "./memes/preloadMemes";
import { createFaceLandmarker } from "./vision/faceLandmarker";
import { startFaceLoop } from "./vision/runLoop";
import type { FaceLandmarker, FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import {
  classifyExpression,
  getBlendshapeDebug,
  computeBlendshapeSignals,
  computeSignals,
  type ExpressionLabel,
  type ExpressionSignals,
  type ExpressionThresholds,
} from "./logic/expression";
import { mapExpressionToMeme } from "./logic/mapToMeme";
import { LabelStabilizer, SignalSmoother } from "./logic/smoother";

type Status = "Idle" | "Loading" | "Running" | string;

function classifyFromRanges(
  signals: ExpressionSignals,
  min: ExpressionSignals,
  max: ExpressionSignals
): ExpressionLabel {
  const mouthRange = max.mouthOpen - min.mouthOpen;
  const smileRange = max.smile - min.smile;
  const eyeRange = max.eyeOpen - min.eyeOpen;

  if (mouthRange < 0.05 && smileRange < 0.05 && eyeRange < 0.05) {
    return "NEUTRAL";
  }

  const screamT = min.mouthOpen + mouthRange * 0.7;
  const smileT = min.smile + smileRange * 0.75;
  const smileMouthMax = min.mouthOpen + mouthRange * 0.6;
  const squintT = min.eyeOpen + eyeRange * 0.4;

  const mouthMargin = mouthRange * 0.08;
  const smileMargin = smileRange * 0.08;
  const eyeMargin = eyeRange * 0.08;

  if (signals.mouthOpen > screamT + mouthMargin) return "SCREAM";
  if (signals.smile > smileT + smileMargin && signals.mouthOpen < smileMouthMax) {
    return "SMILE";
  }
  if (signals.eyeOpen < squintT - eyeMargin * 0.5 && signals.mouthOpen < smileMouthMax) {
    return "SQUINT";
  }
  return "NEUTRAL";
}

function App() {
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState<Status>("Idle");
  const [debug, setDebug] = useState(false);
  const [sensitivity, setSensitivity] = useState(50);
  const [selectedKey, setSelectedKey] = useState("neutral");
  const [faceDetected, setFaceDetected] = useState(false);
  const [expressionLabel, setExpressionLabel] =
    useState<ExpressionLabel>("NEUTRAL");
  const [signals, setSignals] = useState<ExpressionSignals | null>(null);
  const [signalSource, setSignalSource] = useState<"blendshapes" | "landmarks">(
    "landmarks"
  );
  const [blendshapeDebug, setBlendshapeDebug] = useState<{
    jawOpen: number;
    mouthFunnel: number;
    mouthSmile: number;
    mouthUpperUp: number;
    eyeSquint: number;
  } | null>(null);
  const [calibrated, setCalibrated] = useState(false);
  const [extremesDump, setExtremesDump] = useState<string>("");
  const [videoInfo, setVideoInfo] = useState<{
    width: number;
    height: number;
    facingMode?: string;
    deviceId?: string;
  } | null>(null);
  const lastDetectedAtRef = useRef<number | null>(null);
  const lastFaceStateRef = useRef(false);
  const FACE_HOLD_MS = 500;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastVideoTimeRef = useRef<number | null>(null);
  const lastVideoTimeAtRef = useRef<number>(0);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const stopLoopRef = useRef<null | (() => void)>(null);
  const smootherRef = useRef(new SignalSmoother<ExpressionSignals>(0.25));
  const labelStabilizerRef = useRef(
    new LabelStabilizer<ExpressionLabel>("NEUTRAL", 5, 600)
  );
  const resetLabelStabilizer = () => {
    labelStabilizerRef.current = new LabelStabilizer<ExpressionLabel>(
      "NEUTRAL",
      5,
      600
    );
  };
  const loopStartedRef = useRef(false);
  const toothySmileRef = useRef(false);
  const calibrationRef = useRef<{
    count: number;
    baseline: ExpressionSignals;
  }>({
    count: 0,
    baseline: { faceW: 1, mouthOpen: 0, smile: 0, eyeOpen: 0 },
  });
  const extremesRef = useRef<{
    min: ExpressionSignals | null;
    max: ExpressionSignals | null;
    maxMouthOpen: ExpressionSignals | null;
    minMouthOpen: ExpressionSignals | null;
    maxSmile: ExpressionSignals | null;
    minSmile: ExpressionSignals | null;
    maxEyeOpen: ExpressionSignals | null;
    minEyeOpen: ExpressionSignals | null;
  }>({
    min: null,
    max: null,
    maxMouthOpen: null,
    minMouthOpen: null,
    maxSmile: null,
    minSmile: null,
    maxEyeOpen: null,
    minEyeOpen: null,
  });

  const showHttpWarning =
    typeof window !== "undefined" &&
    window.location.protocol === "http:" &&
    !["localhost", "127.0.0.1"].includes(window.location.hostname);

  const currentMemeAsset = useMemo(() => getMeme(selectedKey), [selectedKey]);

  const handleStart = async () => {
    setStatus("Loading");
    await preloadAllMemes(listMemes());
    setStarted(true);
  };

  useEffect(() => {
    if (!started && stopLoopRef.current) {
      stopLoopRef.current();
      stopLoopRef.current = null;
    }
  }, [started]);

  useEffect(() => {
    return () => {
      if (stopLoopRef.current) {
        stopLoopRef.current();
        stopLoopRef.current = null;
      }
    };
  }, []);

  return (
    <>
      {started ? (
        <CatStage asset={currentMemeAsset} />
      ) : (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "#000",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 18,
          }}
        >
          Press Start to begin
        </div>
      )}

      <HiddenCamera
        started={started}
        showPreview={debug}
        onVideoReady={async (videoEl) => {
          try {
            videoRef.current = videoEl;
            const stream = videoEl.srcObject as MediaStream | null;
            const track = stream?.getVideoTracks()[0];
            const settings = track?.getSettings();
            setVideoInfo({
              width: videoEl.videoWidth,
              height: videoEl.videoHeight,
              facingMode: settings?.facingMode,
              deviceId: settings?.deviceId,
            });

            if (!landmarkerRef.current) {
              landmarkerRef.current = await createFaceLandmarker();
            }

            if (stopLoopRef.current) {
              stopLoopRef.current();
            }

            stopLoopRef.current = startFaceLoop({
              video: videoEl,
              landmarker: landmarkerRef.current,
              onResult: (result: FaceLandmarkerResult) => {
                if (!loopStartedRef.current) {
                  loopStartedRef.current = true;
                  if (status === "Loading") {
                    setStatus("Running");
                  }
                }

                const video = videoRef.current;
                if (!video || video.readyState < 2) {
                  lastDetectedAtRef.current = null;
                  if (lastFaceStateRef.current) {
                    lastFaceStateRef.current = false;
                    setFaceDetected(false);
                  }
                  resetLabelStabilizer();
                  setSelectedKey("neutral");
                  if (debug) {
                    setSignals(null);
                    setExpressionLabel("NEUTRAL");
                  }
                  return;
                }

                const now = performance.now();
                if (lastVideoTimeRef.current === null) {
                  lastVideoTimeRef.current = video.currentTime;
                  lastVideoTimeAtRef.current = now;
                } else if (video.currentTime === lastVideoTimeRef.current) {
                  if (now - lastVideoTimeAtRef.current > 600) {
                    lastDetectedAtRef.current = null;
                    if (lastFaceStateRef.current) {
                      lastFaceStateRef.current = false;
                      setFaceDetected(false);
                    }
                    resetLabelStabilizer();
                    setSelectedKey("neutral");
                    if (debug) {
                      setSignals(null);
                      setExpressionLabel("NEUTRAL");
                    }
                    return;
                  }
                } else {
                  lastVideoTimeRef.current = video.currentTime;
                  lastVideoTimeAtRef.current = now;
                }

                const stream = video.srcObject as MediaStream | null;
                const track = stream?.getVideoTracks()[0];
                if (!track || track.readyState !== "live") {
                  lastDetectedAtRef.current = null;
                  if (lastFaceStateRef.current) {
                    lastFaceStateRef.current = false;
                    setFaceDetected(false);
                  }
                  resetLabelStabilizer();
                  setSelectedKey("neutral");
                  if (debug) {
                    setSignals(null);
                    setExpressionLabel("NEUTRAL");
                    setBlendshapeDebug(null);
                  }
                  return;
                }

                const detected = (result.faceLandmarks?.length ?? 0) > 0;

                if (detected) {
                  lastDetectedAtRef.current = now;
                }

                const withinHold =
                  lastDetectedAtRef.current !== null &&
                  now - lastDetectedAtRef.current < FACE_HOLD_MS;
                const stableDetected = detected || withinHold;

                if (!detected) {
                  lastDetectedAtRef.current = null;
                }

                if (stableDetected !== lastFaceStateRef.current) {
                  lastFaceStateRef.current = stableDetected;
                  setFaceDetected(stableDetected);

                  if (debug) {
                    // eslint-disable-next-line no-console
                    console.info(`[vision] faceDetected=${stableDetected}`);
                  }
                }

                const stabilizer = labelStabilizerRef.current;
                let nextLabel: ExpressionLabel = "NEUTRAL";

                if (!stableDetected) {
                  resetLabelStabilizer();
                  setSelectedKey("neutral");
                  if (debug) {
                    setSignals(null);
                    setExpressionLabel("NEUTRAL");
                  }
                  return;
                }

                if (stableDetected) {
                  const blendSignals = computeBlendshapeSignals(
                    result.faceBlendshapes?.[0]?.categories
                  );
                  const blendDebug = getBlendshapeDebug(
                    result.faceBlendshapes?.[0]?.categories
                  );
                  const landmarkSignals = result.faceLandmarks?.[0]
                    ? computeSignals(result.faceLandmarks[0])
                    : null;
                  const blendStrength =
                    (blendDebug?.jawOpen ?? 0) +
                    (blendDebug?.mouthSmile ?? 0) +
                    (blendDebug?.eyeSquint ?? 0);
                  const useBlendshapes =
                    !!blendSignals && blendStrength >= 0.15;
                  const rawSignals = useBlendshapes
                    ? blendSignals
                    : landmarkSignals;

                  if (!rawSignals) {
                    resetLabelStabilizer();
                    setSelectedKey("neutral");
                    if (debug) {
                      setSignals(null);
                      setExpressionLabel("NEUTRAL");
                      setSignalSource(
                        result.faceBlendshapes?.[0]?.categories
                          ? "blendshapes"
                          : "landmarks"
                      );
                    }
                    return;
                  }

                  const smoothSignals = smootherRef.current.update(rawSignals);
                  if (!useBlendshapes) {
                    const calib = calibrationRef.current;
                    if (calib.count < 15) {
                      const nextCount = calib.count + 1;
                      calib.baseline = {
                        faceW:
                          (calib.baseline.faceW * calib.count +
                            smoothSignals.faceW) /
                          nextCount,
                        mouthOpen:
                          (calib.baseline.mouthOpen * calib.count +
                            smoothSignals.mouthOpen) /
                          nextCount,
                        smile:
                          (calib.baseline.smile * calib.count +
                            smoothSignals.smile) /
                          nextCount,
                        eyeOpen:
                          (calib.baseline.eyeOpen * calib.count +
                            smoothSignals.eyeOpen) /
                          nextCount,
                      };
                      calib.count = nextCount;
                      if (nextCount === 15) {
                        setCalibrated(true);
                      }
                    }
                  } else if (!calibrated) {
                    setCalibrated(true);
                  }

                  if (debug) {
                    setSignals(smoothSignals);
                    setSignalSource(useBlendshapes ? "blendshapes" : "landmarks");
                    setBlendshapeDebug(blendDebug);
                  }

                  if (useBlendshapes) {
                    const thresholds: ExpressionThresholds = {
                      mouthOpenScream: 0.2,
                      smile: 0.2,
                      mouthOpenSmileMax: 0.25,
                      eyeOpenSquint: 0.5,
                    };
                    nextLabel = classifyExpression(smoothSignals, thresholds);
                    toothySmileRef.current =
                      (blendDebug?.mouthUpperUp ?? 0) > 0.25 ||
                      (blendDebug?.jawOpen ?? 0) > 0.15;
                  } else {
                    const extremes = extremesRef.current;
                    if (!extremes.min) extremes.min = { ...smoothSignals };
                    if (!extremes.max) extremes.max = { ...smoothSignals };
                    extremes.min = {
                      faceW: Math.min(extremes.min.faceW, smoothSignals.faceW),
                      mouthOpen: Math.min(
                        extremes.min.mouthOpen,
                        smoothSignals.mouthOpen
                      ),
                      smile: Math.min(extremes.min.smile, smoothSignals.smile),
                      eyeOpen: Math.min(
                        extremes.min.eyeOpen,
                        smoothSignals.eyeOpen
                      ),
                    };
                    extremes.max = {
                      faceW: Math.max(extremes.max.faceW, smoothSignals.faceW),
                      mouthOpen: Math.max(
                        extremes.max.mouthOpen,
                        smoothSignals.mouthOpen
                      ),
                      smile: Math.max(extremes.max.smile, smoothSignals.smile),
                      eyeOpen: Math.max(
                        extremes.max.eyeOpen,
                        smoothSignals.eyeOpen
                      ),
                    };
                    nextLabel = classifyFromRanges(
                      smoothSignals,
                      extremes.min,
                      extremes.max
                    );
                    toothySmileRef.current =
                      smoothSignals.mouthOpen >
                      extremes.min.mouthOpen +
                        (extremes.max.mouthOpen - extremes.min.mouthOpen) * 0.6;
                  }

                  if (!useBlendshapes) {
                    const extremes = extremesRef.current;
                    if (
                      !extremes.maxMouthOpen ||
                      smoothSignals.mouthOpen >
                        extremes.maxMouthOpen.mouthOpen
                    ) {
                      extremes.maxMouthOpen = { ...smoothSignals };
                    }
                    if (
                      !extremes.minMouthOpen ||
                      smoothSignals.mouthOpen <
                        extremes.minMouthOpen.mouthOpen
                    ) {
                      extremes.minMouthOpen = { ...smoothSignals };
                    }
                    if (
                      !extremes.maxSmile ||
                      smoothSignals.smile > extremes.maxSmile.smile
                    ) {
                      extremes.maxSmile = { ...smoothSignals };
                    }
                    if (
                      !extremes.minSmile ||
                      smoothSignals.smile < extremes.minSmile.smile
                    ) {
                      extremes.minSmile = { ...smoothSignals };
                    }
                    if (
                      !extremes.maxEyeOpen ||
                      smoothSignals.eyeOpen > extremes.maxEyeOpen.eyeOpen
                    ) {
                      extremes.maxEyeOpen = { ...smoothSignals };
                    }
                    if (
                      !extremes.minEyeOpen ||
                      smoothSignals.eyeOpen < extremes.minEyeOpen.eyeOpen
                    ) {
                      extremes.minEyeOpen = { ...smoothSignals };
                    }
                  }

                  if (debug) {
                    setExpressionLabel(nextLabel);
                  }
                } else if (debug) {
                  setSignals(null);
                  setExpressionLabel("NEUTRAL");
                  setBlendshapeDebug(null);
                }

                const stableLabel = stabilizer.update(nextLabel, now);
                let nextKey = mapExpressionToMeme(stableLabel);
                if (stableLabel === "SMILE" && toothySmileRef.current) {
                  nextKey = "grin";
                }
                setSelectedKey((prev) => (prev === nextKey ? prev : nextKey));
                if (debug) {
                  setExpressionLabel(stableLabel);
                }
              },
            });

            setStatus("Running");
          } catch (error) {
            const msg =
              error instanceof Error
                ? error.message
                : "Failed to initialize face tracking.";
            setStatus(msg);
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
        {showHttpWarning ? (
          <div style={{ color: "#ffcc66" }}>
            Camera may be blocked on non-HTTPS (except localhost).
          </div>
        ) : null}
        <div>Face: {faceDetected ? "detected" : "none"}</div>
        {videoInfo ? (
          <div>
            Video: {videoInfo.width}x{videoInfo.height}
            {videoInfo.facingMode ? ` (${videoInfo.facingMode})` : ""}
          </div>
        ) : null}
        {debug ? (
          <div>
            Label: {expressionLabel}
            {signals
              ? ` | mouthOpen=${signals.mouthOpen.toFixed(3)} smile=${signals.smile.toFixed(
                  3
                )} eyeOpen=${signals.eyeOpen.toFixed(3)}`
              : ""}
            {!calibrated && signalSource === "landmarks" ? " | calibrating" : ""}
            {signals && calibrated && signalSource === "landmarks"
              ? ` | ΔmouthOpen=${(
                  signals.mouthOpen - calibrationRef.current.baseline.mouthOpen
                ).toFixed(3)} Δsmile=${(
                  signals.smile - calibrationRef.current.baseline.smile
                ).toFixed(3)} ΔeyeOpen=${(
                  signals.eyeOpen - calibrationRef.current.baseline.eyeOpen
                ).toFixed(3)}`
              : ""}
            {signals ? ` | source=${signalSource}` : ""}
            {blendshapeDebug
              ? ` | jawOpen=${blendshapeDebug.jawOpen.toFixed(3)} smileRaw=${blendshapeDebug.mouthSmile.toFixed(
                  3
                )} upperUp=${blendshapeDebug.mouthUpperUp.toFixed(
                  3
                )} eyeSquint=${blendshapeDebug.eyeSquint.toFixed(3)}`
              : ""}
          </div>
        ) : null}
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
        {debug ? (
          <button
            onClick={() => {
              const extremes = extremesRef.current;
              setExtremesDump(JSON.stringify(extremes, null, 2));
              // eslint-disable-next-line no-console
              console.info("[debug] delta extremes", extremes);
            }}
          >
            Log extremes
          </button>
        ) : null}
      </div>
      {debug && extremesDump ? (
        <pre
          style={{
            position: "fixed",
            left: 16,
            bottom: 16,
            maxWidth: 360,
            maxHeight: 260,
            overflow: "auto",
            padding: "10px 12px",
            background: "rgba(0, 0, 0, 0.75)",
            color: "#fff",
            fontSize: 12,
            borderRadius: 6,
            whiteSpace: "pre-wrap",
          }}
        >
          {extremesDump}
        </pre>
      ) : null}
    </>
  );
}

export default App;
