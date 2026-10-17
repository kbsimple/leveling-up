// Build identity injected by vite.config.ts.

export interface BuildInfo {
  service: string;
  version: string;
  releaseDate: string;
  builtAt: string;
  commit: string;
  commitShort: string;
  branch: string;
  context: string;
  features: Record<string, boolean>;
  deps: Record<string, string>;
}

declare const __BUILD_INFO__: BuildInfo;

export const BUILD: BuildInfo = __BUILD_INFO__;
