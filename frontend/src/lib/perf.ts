export interface FrontendDiagnostics {
  listRefreshMs: number;
  searchMs: number;
  previewMs: number;
}

const recent: FrontendDiagnostics = {
  listRefreshMs: 0,
  searchMs: 0,
  previewMs: 0,
};

export function recordFrontendTiming(
  name: keyof FrontendDiagnostics,
  startedAt: number,
): void {
  recent[name] = Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
}

export function frontendDiagnostics(): FrontendDiagnostics {
  return { ...recent };
}
