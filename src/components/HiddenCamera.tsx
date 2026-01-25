import { useEffect, useRef } from "react";

type HiddenCameraProps = {
  started: boolean;
  showPreview?: boolean;
  onVideoReady: (videoEl: HTMLVideoElement) => void;
  onError: (msg: string) => void;
};

function stopStream(stream: MediaStream | null) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function toFriendlyError(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Camera access was denied. Please allow camera permissions.";
      case "NotFoundError":
      case "OverconstrainedError":
        return "No compatible camera was found.";
      case "NotReadableError":
        return "Camera is already in use by another application.";
      default:
        return "Unable to access the camera.";
    }
  }

  return "Unable to access the camera.";
}

export function HiddenCamera({
  started,
  showPreview = false,
  onVideoReady,
  onError,
}: HiddenCameraProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onVideoReadyRef = useRef(onVideoReady);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onVideoReadyRef.current = onVideoReady;
  }, [onVideoReady]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    let cancelled = false;

    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false,
        });

        if (cancelled) {
          stopStream(stream);
          return;
        }

        const videoEl = videoRef.current;
        if (!videoEl) {
          stopStream(stream);
          return;
        }

        streamRef.current = stream;
        videoEl.autoplay = true;
        videoEl.muted = true;
        videoEl.playsInline = true;
        videoEl.srcObject = stream;

        const handleLoaded = async () => {
          videoEl.removeEventListener("loadedmetadata", handleLoaded);
          try {
            await videoEl.play();
          } catch {
            // Ignore play errors; some browsers require user interaction.
          }

          if (!cancelled) {
            onVideoReadyRef.current(videoEl);
          }
        };

        videoEl.addEventListener("loadedmetadata", handleLoaded);
      } catch (error) {
        if (!cancelled) {
          onErrorRef.current(toFriendlyError(error));
        }
      }
    };

    if (started) {
      startCamera();
    } else {
      stopStream(streamRef.current);
      streamRef.current = null;
    }

    return () => {
      cancelled = true;
      stopStream(streamRef.current);
      streamRef.current = null;
    };
  }, [started]);

  return (
    <video
      ref={videoRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        right: showPreview ? 16 : undefined,
        bottom: showPreview ? 16 : undefined,
        width: showPreview ? 220 : "1px",
        height: showPreview ? "auto" : "1px",
        opacity: showPreview ? 1 : 0,
        pointerEvents: "none",
        zIndex: 10,
        borderRadius: showPreview ? 8 : undefined,
        boxShadow: showPreview ? "0 2px 8px rgba(0, 0, 0, 0.35)" : undefined,
      }}
    />
  );
}
