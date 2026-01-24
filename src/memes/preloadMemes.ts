import type { MemeAsset } from "./memeRegistry";

const TIMEOUT_MS = 7000;

function devLog(message: string): void {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.info(message);
  }
}

export function preloadMeme(asset: MemeAsset): Promise<void> {
  return new Promise((resolve, reject) => {
    const src = asset.src;
    let settled = false;

    const finishResolve = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const timeoutId = window.setTimeout(() => {
      devLog(`[memes] preload timeout: ${asset.key}`);
      finishResolve();
    }, TIMEOUT_MS);

    const clearTimer = () => window.clearTimeout(timeoutId);

    if (asset.type === "image") {
      const img = new Image();

      img.onload = () => {
        clearTimer();
        finishResolve();
      };

      img.onerror = () => {
        clearTimer();
        finishReject(new Error(`Failed to preload image: ${src}`));
      };

      img.src = src;
      return;
    }

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = src;

    const cleanup = () => {
      video.oncanplaythrough = null;
      video.onerror = null;
    };

    const tryResolve = () => {
      if (video.readyState >= 3) {
        cleanup();
        clearTimer();
        finishResolve();
      }
    };

    video.oncanplaythrough = () => {
      cleanup();
      clearTimer();
      finishResolve();
    };

    video.onerror = () => {
      cleanup();
      clearTimer();
      finishReject(new Error(`Failed to preload video: ${src}`));
    };

    tryResolve();
  });
}

export async function preloadAllMemes(assets: MemeAsset[]): Promise<void> {
  const results = await Promise.allSettled(assets.map(preloadMeme));
  const failures = results.filter((result) => result.status === "rejected");

  if (failures.length > 0) {
    devLog(`[memes] preload failures: ${failures.length}`);
  }
}
