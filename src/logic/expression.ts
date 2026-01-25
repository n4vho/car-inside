export type ExpressionLabel = "NEUTRAL" | "SMILE" | "SCREAM" | "SQUINT";

export type ExpressionSignals = {
  faceW: number;
  mouthOpen: number;
  smile: number;
  eyeOpen: number;
};

export type ExpressionThresholds = {
  mouthOpenScream: number;
  smile: number;
  mouthOpenSmileMax: number;
  eyeOpenSquint: number;
};

type BlendshapeCategory = { categoryName: string; score: number };

type Landmark = { x: number; y: number; z?: number };

const IDX = {
  leftCheek: 234,
  rightCheek: 454,
  noseTip: 1,
  chin: 152,
  leftEyeOuter: 33,
  leftEyeInner: 133,
  upperLip: 13,
  lowerLip: 14,
  mouthLeft: 61,
  mouthRight: 291,
  leftEyeTop: 159,
  leftEyeBottom: 145,
  rightEyeOuter: 263,
  rightEyeInner: 362,
  rightEyeTop: 386,
  rightEyeBottom: 374,
};

function dist2D(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getScore(
  categories: BlendshapeCategory[],
  name: string
): number | null {
  const item = categories.find((entry) => entry.categoryName === name);
  return item ? item.score : null;
}

export function getBlendshapeDebug(
  categories: BlendshapeCategory[] | undefined
): {
  jawOpen: number;
  mouthFunnel: number;
  mouthSmile: number;
  eyeSquint: number;
} | null {
  if (!categories || categories.length === 0) return null;

  const jawOpen = getScore(categories, "jawOpen") ?? 0;
  const mouthFunnel = getScore(categories, "mouthFunnel") ?? 0;
  const mouthSmileLeft = getScore(categories, "mouthSmileLeft") ?? 0;
  const mouthSmileRight = getScore(categories, "mouthSmileRight") ?? 0;
  const eyeSquintLeft = getScore(categories, "eyeSquintLeft") ?? 0;
  const eyeSquintRight = getScore(categories, "eyeSquintRight") ?? 0;

  return {
    jawOpen,
    mouthFunnel,
    mouthSmile: (mouthSmileLeft + mouthSmileRight) / 2,
    eyeSquint: (eyeSquintLeft + eyeSquintRight) / 2,
  };
}

export function computeBlendshapeSignals(
  categories: BlendshapeCategory[] | undefined
): ExpressionSignals | null {
  if (!categories || categories.length === 0) return null;

  const jawOpen = getScore(categories, "jawOpen") ?? 0;
  const mouthFunnel = getScore(categories, "mouthFunnel") ?? 0;
  const mouthSmileLeft = getScore(categories, "mouthSmileLeft") ?? 0;
  const mouthSmileRight = getScore(categories, "mouthSmileRight") ?? 0;
  const eyeSquintLeft = getScore(categories, "eyeSquintLeft") ?? 0;
  const eyeSquintRight = getScore(categories, "eyeSquintRight") ?? 0;

  const mouthOpen = Math.min(1, jawOpen + mouthFunnel * 0.5);
  const smile = Math.min(1, (mouthSmileLeft + mouthSmileRight) / 2);
  const eyeOpen = Math.max(0, 1 - (eyeSquintLeft + eyeSquintRight) / 2);

  return {
    faceW: 1,
    mouthOpen,
    smile,
    eyeOpen,
  };
}

export function computeSignals(landmarks: Landmark[]): ExpressionSignals {
  const faceW = Math.max(
    dist2D(landmarks[IDX.leftEyeOuter], landmarks[IDX.rightEyeOuter]),
    1e-6
  );
  const faceH = Math.max(
    dist2D(landmarks[IDX.noseTip], landmarks[IDX.chin]),
    1e-6
  );

  const mouthWidth = Math.max(
    dist2D(landmarks[IDX.mouthLeft], landmarks[IDX.mouthRight]),
    1e-6
  );
  const mouthOpen =
    dist2D(landmarks[IDX.upperLip], landmarks[IDX.lowerLip]) / faceH;
  const smile = mouthWidth / faceW;

  const leftEyeWidth = Math.max(
    dist2D(landmarks[IDX.leftEyeOuter], landmarks[IDX.leftEyeInner]),
    1e-6
  );
  const rightEyeWidth = Math.max(
    dist2D(landmarks[IDX.rightEyeInner], landmarks[IDX.rightEyeOuter]),
    1e-6
  );
  const leftEyeOpen =
    dist2D(landmarks[IDX.leftEyeTop], landmarks[IDX.leftEyeBottom]) /
    leftEyeWidth;
  const rightEyeOpen =
    dist2D(landmarks[IDX.rightEyeTop], landmarks[IDX.rightEyeBottom]) /
    rightEyeWidth;
  const eyeOpen = (leftEyeOpen + rightEyeOpen) / 2;

  return { faceW, mouthOpen, smile, eyeOpen };
}

export function classifyExpression(
  signals: ExpressionSignals,
  thresholds: ExpressionThresholds = {
    mouthOpenScream: 0.28,
    smile: 0.62,
    mouthOpenSmileMax: 0.18,
    eyeOpenSquint: 0.12,
  }
): ExpressionLabel {
  const screamTriggered =
    thresholds.mouthOpenScream < 0
      ? signals.mouthOpen < thresholds.mouthOpenScream
      : signals.mouthOpen > thresholds.mouthOpenScream;
  if (screamTriggered) return "SCREAM";

  const smileTriggered =
    thresholds.smile < 0
      ? signals.smile < thresholds.smile
      : signals.smile > thresholds.smile;
  const mouthOk =
    thresholds.mouthOpenSmileMax < 0
      ? signals.mouthOpen > thresholds.mouthOpenSmileMax
      : signals.mouthOpen < thresholds.mouthOpenSmileMax;
  if (smileTriggered && mouthOk) return "SMILE";

  const squintTriggered =
    thresholds.eyeOpenSquint < 0
      ? signals.eyeOpen < thresholds.eyeOpenSquint
      : signals.eyeOpen < thresholds.eyeOpenSquint;
  if (squintTriggered) return "SQUINT";
  return "NEUTRAL";
}
