import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // three ships untranspiled modern syntax in some subpaths (examples/jsm/**).
  // Bundling it here rather than treating it as untouched runtime code.
  transpilePackages: ["three"],

  // Law (e) in docs/ARCHITECTURE.md: the sim is deterministic and must never be
  // double-invoked. React Strict Mode double-renders effects in dev, which is fine
  // for DOM UI but will be revisited when the game loop mounts in P05.
  reactStrictMode: true,
};

export default nextConfig;
