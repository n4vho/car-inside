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

type FaceLandmark = { x: number; y: number };

function getTongueConfidence(
  video: HTMLVideoElement,
  landmarks: FaceLandmark[],
  canvas: HTMLCanvasElement
): number | null {
  const mouthLeft = landmarks[61];
  const mouthRight = landmarks[291];
  const upperLip = landmarks[13];
  const lowerLip = landmarks[14];
  if (!mouthLeft || !mouthRight || !upperLip || !lowerLip) return null;

  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;

  const left = mouthLeft.x * width;
  const right = mouthRight.x * width;
  const top = upperLip.y * height;
  const bottom = lowerLip.y * height;
  const mouthWidth = Math.max(right - left, 1);
  const mouthHeight = Math.max(bottom - top, 1);

  const sampleWidth = Math.max(6, Math.floor(mouthWidth * 0.5));
  const sampleHeight = Math.max(4, Math.floor(mouthHeight * 0.6));
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2 + mouthHeight * 0.1;
  const sampleX = Math.max(0, Math.floor(centerX - sampleWidth / 2));
  const sampleY = Math.max(0, Math.floor(centerY - sampleHeight / 2));
  const clampedWidth = Math.min(sampleWidth, width - sampleX);
  const clampedHeight = Math.min(sampleHeight, height - sampleY);
  if (clampedWidth <= 0 || clampedHeight <= 0) return null;

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  canvas.width = clampedWidth;
  canvas.height = clampedHeight;
  ctx.drawImage(
    video,
    sampleX,
    sampleY,
    clampedWidth,
    clampedHeight,
    0,
    0,
    clampedWidth,
    clampedHeight
  );
  const data = ctx.getImageData(0, 0, clampedWidth, clampedHeight).data;
  let redCount = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    total += 1;
    const redDominant =
      r > 50 && r > g + 10 && r > b + 10 && r - (g + b) / 2 > 8;
    if (redDominant) {
      redCount += 1;
    }
  }
  if (total === 0) return null;
  return redCount / total;
}

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
  const [rawExpressionLabel, setRawExpressionLabel] =
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
    tongueOut: number;
    eyeSquint: number;
  } | null>(null);
  const [tongueConfidence, setTongueConfidence] = useState<number | null>(null);
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
  const tongueCanvasRef = useRef<HTMLCanvasElement | null>(null);
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
  const tongueHoldUntilRef = useRef<number>(0);
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
          <button
            onClick={handleStart}
            style={{
              padding: "10px 16px",
              fontSize: 16,
              borderRadius: 6,
              border: "1px solid #555",
              background: "#111",
              color: "#fff",
              cursor: "pointer",
            }}
          >
            Start
          </button>
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
                  setSignals(null);
                  setExpressionLabel("NEUTRAL");
                  setRawExpressionLabel("NEUTRAL");
                  setTongueConfidence(null);
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
                    setSignals(null);
                    setExpressionLabel("NEUTRAL");
                    setRawExpressionLabel("NEUTRAL");
                    setTongueConfidence(null);
                    setSignalSource(
                      result.faceBlendshapes?.[0]?.categories
                        ? "blendshapes"
                        : "landmarks"
                    );
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

                  setSignals(smoothSignals);
                  setSignalSource(useBlendshapes ? "blendshapes" : "landmarks");
                  setBlendshapeDebug(blendDebug);

                  if (useBlendshapes) {
                    const tongueScore = blendDebug?.tongueOut ?? 0;
                    const mouthFunnel = blendDebug?.mouthFunnel ?? 0;
                    const mouthSmile = blendDebug?.mouthSmile ?? 0;
                    const jawOpen = blendDebug?.jawOpen ?? 0;
                    const tongueProxy =
                      tongueScore >= 0.2 ||
                      (nextLabel === "SCREAM" &&
                        jawOpen >= 0.35 &&
                        mouthFunnel >= 0.01 &&
                        mouthSmile <= 0.45);
                    const thresholds: ExpressionThresholds = {
                      tongueOut: 0.5,
                      mouthOpenScream: 0.2,
                      smile: 0.2,
                      mouthOpenSmileMax: 0.25,
                      eyeOpenSquint: 0.5,
                    };
                    nextLabel = classifyExpression(smoothSignals, thresholds);
                    if (tongueProxy) {
                      nextLabel = "FREAKY";
                    }
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

                  if (landmarkSignals && video) {
                    if (!tongueCanvasRef.current) {
                      tongueCanvasRef.current =
                        document.createElement("canvas");
                    }
                    const tongueScore = getTongueConfidence(
                      video,
                      result.faceLandmarks?.[0] as FaceLandmark[],
                      tongueCanvasRef.current
                    );
                    setTongueConfidence(tongueScore);
                    if (
                      typeof tongueScore === "number" &&
                      tongueScore >= 0.25 &&
                      landmarkSignals.mouthOpen > 0.1
                    ) {
                      tongueHoldUntilRef.current = now + 700;
                    }
                    if (
                      tongueHoldUntilRef.current > now &&
                      landmarkSignals.mouthOpen > 0.08
                    ) {
                      nextLabel = "FREAKY";
                    }
                  } else {
                    setTongueConfidence(null);
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

                  setRawExpressionLabel(nextLabel);
                } else {
                  setSignals(null);
                  setExpressionLabel("NEUTRAL");
                  setRawExpressionLabel("NEUTRAL");
                  setBlendshapeDebug(null);
                  setTongueConfidence(null);
                }

                const stableLabel = stabilizer.update(nextLabel, now);
                let nextKey = mapExpressionToMeme(stableLabel);
                if (stableLabel === "SMILE" && toothySmileRef.current) {
                  nextKey = "grin";
                }
                setSelectedKey((prev) => (prev === nextKey ? prev : nextKey));
                setExpressionLabel(stableLabel);
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
        {!started ? (
          <button onClick={handleStart} disabled={status === "Loading"}>
            Start
          </button>
        ) : null}
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
            Label: {expressionLabel} (raw {rawExpressionLabel})
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
                )} tongueOut=${blendshapeDebug.tongueOut.toFixed(
                  3
                )} funnel=${blendshapeDebug.mouthFunnel.toFixed(
                  3
                )} eyeSquint=${blendshapeDebug.eyeSquint.toFixed(3)}`
              : ""}
            {tongueConfidence !== null
              ? ` | tongueConf=${tongueConfidence.toFixed(3)}`
              : ""}
          </div>
        ) : null}
      </div>

      {debug ? (
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
        </div>
      ) : null}
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
