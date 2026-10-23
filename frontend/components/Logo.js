import { config } from "@/lib/config";
import { cn } from "@/lib/utils";

// Renders the configured logo, falling back to the org name as text when no
// logo file has been uploaded yet. `variant="v2"` uses the in-dashboard logo.
export default function Logo({ variant = "v1", height = 40, className = "" }) {
  const src = variant === "v2" ? config.logoV2 : config.logo;

  if (src) {
    return (
      // biome-ignore lint/performance/noImgElement: logo path is white-label configurable, not a build-time asset
      <img
        src={src}
        alt={config.orgName}
        height={height}
        // The height is a prop (a size, not a style choice), so it stays inline.
        style={{ height, width: "auto" }}
        className={className}
      />
    );
  }

  return (
    <span
      className={cn("font-semibold tracking-tight", className)}
      style={{ fontSize: height * 0.5 }}
    >
      {config.orgName}
    </span>
  );
}
