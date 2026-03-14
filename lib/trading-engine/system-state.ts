/**
 * Global system state for engine pause and IP ban cooldowns.
 * Used by run-ws-broadcast-server (broadcast + toggle), execution-engine and ws-manager (report bans).
 */

export interface SystemState {
  isEnginePaused: boolean;
  binanceBanUntil: number;
  bybitBanUntil: number;
}

let systemState: SystemState = {
  isEnginePaused: false,
  binanceBanUntil: 0,
  bybitBanUntil: 0,
};

export function getSystemState(): SystemState {
  return { ...systemState };
}

export function setEnginePaused(paused: boolean): void {
  systemState.isEnginePaused = paused;
}

export function reportBinanceBan(banUntilMs: number): void {
  if (banUntilMs > systemState.binanceBanUntil) {
    systemState.binanceBanUntil = banUntilMs;
  }
}

export function reportBybitBan(banUntilMs: number): void {
  if (banUntilMs > systemState.bybitBanUntil) {
    systemState.bybitBanUntil = banUntilMs;
  }
}

/** Parse ban timestamp from error message (e.g. "banned until 1773413265843" or "retry after 60"). */
export function parseBanUntilFromError(status: number, bodyText: string): number {
  const now = Date.now();
  if (status === 418 || status === 429) {
    const untilMatch = bodyText.match(/banned\s+until\s+(\d+)/i) ?? bodyText.match(/until\s+(\d+)/i);
    if (untilMatch) return Math.max(now, Number(untilMatch[1]));
    const retryMatch = bodyText.match(/retry[-\s]?after\s+(\d+)/i) ?? bodyText.match(/"retryAfter"?\s*:\s*(\d+)/i);
    if (retryMatch) return now + Number(retryMatch[1]) * 1000;
    // Default cooldown for 418/429 when no timestamp: 5 minutes
    return now + 5 * 60 * 1000;
  }
  return 0;
}
