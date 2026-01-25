import type {
  FaceLandmarker,
  FaceLandmarkerResult,
} from "@mediapipe/tasks-vision";

type FaceLoopParams = {
  video: HTMLVideoElement;
  landmarker: FaceLandmarker;
  fps?: number;
  onResult: (result: FaceLandmarkerResult) => void;
};

export function startFaceLoop({
  video,
  landmarker,
  fps = 12,
  onResult,
}: FaceLoopParams) {
  let stopped = false;
  let timeoutId: number | null = null;
  const intervalMs = Math.max(1, Math.round(1000 / fps));

  const tick = () => {
    if (stopped) return;
    const nowMs = performance.now();
    const result = landmarker.detectForVideo(video, nowMs);
    onResult(result);
    timeoutId = window.setTimeout(tick, intervalMs);
  };

  timeoutId = window.setTimeout(tick, intervalMs);

  return () => {
    stopped = true;
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  };
}
