import type { MemeAsset } from "../memes/memeRegistry";
import "../styles/app.css";

type CatStageProps = {
  asset: MemeAsset;
};

export function CatStage({ asset }: CatStageProps) {
  return (
    <div className="cat-stage">
      {asset.type === "image" ? (
        <img
          key={asset.src}
          className="cat-stage__media"
          src={asset.src}
          alt={asset.key}
        />
      ) : (
        <video
          key={asset.src}
          className="cat-stage__media"
          src={asset.src}
          loop
          muted
          playsInline
          autoPlay
        />
      )}
    </div>
  );
}
