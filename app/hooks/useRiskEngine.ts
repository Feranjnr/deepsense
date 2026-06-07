"use client";

import { useEffect, useRef, useState } from "react";
import type { PolicyState } from "./useRiskGuardian";

// ─── Types ──────────────────────────────────────────────────────────────────

type PriceMap = Record<string, { usd: number; chg: number }>;

type PriceSnapshot = {
  prices: PriceMap;
  ts: number; // Date.now() at capture time
};

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type RiskAssessment = {
  score: number;
  level: RiskLevel;
  reasons: string[];
  timestamp: number;
};

export type ActionLogEntry = {
  action: string;
  score: number;
  timestamp: number;
  txDigest?: string;
};

type UseRiskEngineParams = {
  prices: PriceMap | null;
  pythPrices?: Record<string, { usd: number; conf?: number }> | null;
  policyState: PolicyState | null;
  enabled: boolean;
  walletConnected: boolean;
  demoMode?: boolean;
};

// ─── Demo mode ───────────────────────────────────────────────────────────────
// Overrides live prices to simulate a correlated market crash.
// All scoring logic runs unchanged — the reasons array is realistic.
const DEMO_OVERRIDES: Record<string, { chg: number; usd?: number }> = {
  sui:        { chg: -15 },
  ethereum:   { chg: -12 },
  bitcoin:    { chg: -9  },
  tether:     { chg: -3, usd: 0.97 },
  "usd-coin": { chg: 0 },
};

function applyDemoMode(base: PriceMap): PriceMap {
  const result = { ...base };
  for (const [key, override] of Object.entries(DEMO_OVERRIDES)) {
    result[key] = {
      usd: override.usd ?? base[key]?.usd ?? 1,
      chg: override.chg,
    };
  }
  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function scoreToLevel(score: number): RiskLevel {
  if (score >= 86) return "CRITICAL";
  if (score >= 61) return "HIGH";
  if (score >= 31) return "MEDIUM";
  return "LOW";
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function pct(a: number, b: number): number {
  if (b === 0) return 0;
  return ((a - b) / b) * 100;
}

// ─── Core scoring ────────────────────────────────────────────────────────────

function calculateRiskScore(
  prices: PriceMap,
  history: PriceSnapshot[],
): { score: number; level: RiskLevel; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // ── a) Price crash detection (0–40 pts) ──────────────────────────────────
  const crashAssets: [string, string][] = [
    ["sui",       "SUI"],
    ["ethereum",  "ETH"],
    ["bitcoin",   "BTC"],
  ];

  for (const [cgId, label] of crashAssets) {
    const chg = prices[cgId]?.chg ?? 0;
    if (chg <= -10) {
      score += 30;
      reasons.push(`${label} down ${Math.abs(chg).toFixed(1)}% in 24h`);
    } else if (chg <= -5) {
      score += 15;
      reasons.push(`${label} down ${Math.abs(chg).toFixed(1)}% in 24h`);
    } else if (chg <= -3) {
      score += 5;
      reasons.push(`${label} down ${Math.abs(chg).toFixed(1)}% in 24h`);
    }
  }

  // ── b) Volatility clustering (0–25 pts) ──────────────────────────────────
  const recent = history.slice(-3);
  if (recent.length >= 2) {
    for (let i = 1; i < recent.length; i++) {
      const prev = recent[i - 1].prices["sui"]?.usd;
      const curr = recent[i].prices["sui"]?.usd;
      if (!prev || !curr) continue;
      const swing = Math.abs(pct(curr, prev));
      const secs = Math.round((recent[i].ts - recent[i - 1].ts) / 1000);
      if (swing > 2) {
        score += 15;
        reasons.push(
          `High SUI volatility: ${swing.toFixed(2)}% swing in ${secs}s`,
        );
        break;
      } else if (swing > 1) {
        score += 8;
        reasons.push(
          `Elevated SUI volatility: ${swing.toFixed(2)}% swing in ${secs}s`,
        );
        break;
      }
    }
  }

  // ── c) Correlation risk (0–20 pts) ───────────────────────────────────────
  const suiChg = prices["sui"]?.chg ?? 0;
  const ethChg = prices["ethereum"]?.chg ?? 0;
  if (suiChg < -2 && ethChg < -2) {
    score += 20;
    reasons.push(
      `Correlated sell-off: SUI and ETH declining together`,
    );
  } else if (suiChg < -2 || ethChg < -2) {
    score += 5;
  }

  // ── d) Stablecoin de-peg (0–15 pts) ─────────────────────────────────────
  const usdtPrice = prices["tether"]?.usd ?? 1;
  const usdcPrice = prices["usd-coin"]?.usd ?? 1;
  const usdtDev = Math.abs(usdtPrice - 1) * 100;
  const usdcDev = Math.abs(usdcPrice - 1) * 100;
  const maxDev = Math.max(usdtDev, usdcDev);
  const depegAsset = usdtDev >= usdcDev ? "USDT" : "USDC";
  const depegPrice = usdtDev >= usdcDev ? usdtPrice : usdcPrice;

  if (maxDev > 0.5) {
    score += 15;
    reasons.push(
      `Stablecoin de-peg warning: ${depegAsset} at $${depegPrice.toFixed(4)}`,
    );
  } else if (maxDev > 0.2) {
    score += 5;
    reasons.push(
      `Stablecoin drift: ${depegAsset} at $${depegPrice.toFixed(4)}`,
    );
  }

  const clamped = clamp(score, 0, 100);
  return { score: clamped, level: scoreToLevel(clamped), reasons };
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useRiskEngine({
  prices,
  pythPrices,
  policyState,
  enabled,
  walletConnected,
  demoMode = false,
}: UseRiskEngineParams) {
  const [riskAssessment, setRiskAssessment] = useState<RiskAssessment | null>(null);
  const [actionLog, setActionLog]           = useState<ActionLogEntry[]>([]);
  const [isActing, setIsActing]             = useState(false);

  const priceHistory     = useRef<PriceSnapshot[]>([]);
  const lastOnChainScore = useRef<number>(-1);

  // Merge CoinGecko + Pyth: Pyth wins where available.
  const mergedPrices: PriceMap | null = (() => {
    if (!prices && !pythPrices) return null;
    const base: PriceMap = prices ? { ...prices } : {};
    if (pythPrices) {
      for (const [key, val] of Object.entries(pythPrices)) {
        // Preserve existing chg from CoinGecko; override usd with Pyth price.
        base[key] = { usd: val.usd, chg: base[key]?.chg ?? 0 };
      }
    }
    return base;
  })();

  // In demo mode, override prices with a simulated crash scenario.
  // calculateRiskScore runs unchanged — reasons look realistic.
  const effectivePrices: PriceMap | null = demoMode && mergedPrices
    ? applyDemoMode(mergedPrices)
    : mergedPrices;

  // Dep key changes when prices or demo toggle changes.
  const effectiveKey = (demoMode ? "demo|" : "") + JSON.stringify(effectivePrices);

  useEffect(() => {
    if (!enabled || !effectivePrices) return;

    // Push snapshot (cap at 10)
    priceHistory.current = [
      ...priceHistory.current,
      { prices: effectivePrices, ts: Date.now() },
    ].slice(-10);

    const { score, level, reasons } = calculateRiskScore(effectivePrices, priceHistory.current);

    // Only update state when score actually changes to avoid unnecessary renders.
    setRiskAssessment((prev) => {
      if (prev !== null && prev.score === score) return prev;
      console.log(
        `[RiskEngine] Score: ${score} (${level}) — ${reasons.length ? reasons.join(" | ") : "no elevated factors"}`,
      );
      return { score, level, reasons, timestamp: Date.now() };
    });

    // Queue pending actions when score diverges enough from last on-chain value.
    const onChain = policyState?.risk_score ?? lastOnChainScore.current;
    const delta = Math.abs(score - onChain);
    const updateAction = `PENDING: Update risk score to ${score}`;
    const pauseAction  = `PENDING: Pause protocol — risk critical (score ${score})`;

    if (delta >= 10 && walletConnected && policyState?.agent_active) {
      setActionLog((prev) => {
        if (prev.length > 0 && prev[0].action === updateAction) return prev;
        lastOnChainScore.current = score;
        return [{ action: updateAction, score, timestamp: Date.now() }, ...prev].slice(0, 50);
      });
    }

    if (score > 90 && !policyState?.is_paused && walletConnected && policyState?.agent_active) {
      setActionLog((prev) => {
        if (prev.some((e) => e.action === pauseAction)) return prev;
        return [{ action: pauseAction, score, timestamp: Date.now() }, ...prev].slice(0, 50);
      });
    }
  // effectiveKey is the stable dep — includes demoMode prefix so toggling demo re-runs scorer.
  // policyState and walletConnected are intentionally omitted; they are snapshot-read
  // to avoid re-running the scorer on every 10s guardian refetch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveKey, enabled]);

  return {
    riskAssessment,
    actionLog,
    priceHistory: priceHistory.current,
    isActing,
  };
}
