import type { ExpressionLabel } from "./expression";

export function mapExpressionToMeme(label: ExpressionLabel): string {
  switch (label) {
    case "SCREAM":
      return "scream";
    case "SMILE":
      return "smile";
    case "SQUINT":
      return "judging";
    case "NEUTRAL":
    default:
      return "neutral";
  }
}
