export type MemeType = "image" | "video";

export interface MemeAsset {
  key: string;
  type: MemeType;
  src: string;
}

export const DEFAULT_MEME_KEY = "neutral";

export const MEMES: Record<string, MemeAsset> = {
  neutral: { key: "neutral", type: "image", src: "/memes/neutral.jpeg" },
  smile: { key: "smile", type: "image", src: "/memes/smile.jpg" },
  grin: { key: "grin", type: "image", src: "/memes/grin.png" },
  scream: { key: "scream", type: "image", src: "/memes/scream.png" },
  judging: { key: "judging", type: "image", src: "/memes/judging.jpg" },
  tilt_left: { key: "tilt_left", type: "image", src: "/memes/tilt_left.jpg" },
  tilt_right: { key: "tilt_right", type: "image", src: "/memes/tilt_right.jpeg" },
  look_left: { key: "look_left", type: "image", src: "/memes/look_left.png" },
  look_right: { key: "look_right", type: "image", src: "/memes/look_right.jpg" },
  look_up: { key: "look_up", type: "image", src: "/memes/look_up.jpeg" },
  look_down: { key: "look_down", type: "image", src: "/memes/look_down.png" },
};

export function getMeme(key: string): MemeAsset {
  return MEMES[key] ?? MEMES[DEFAULT_MEME_KEY];
}

export function listMemes(): MemeAsset[] {
  return Object.values(MEMES);
}
