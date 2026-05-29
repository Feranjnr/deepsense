"use client";

import { useEffect, useRef, useState } from "react";
import { HermesClient } from "@pythnetwork/hermes-client";

// Price feed IDs (hex)
const FEED_IDS = {
  sui:      "0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744",
  eth:      "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  btc:      "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  usdt:     "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
  usdc:     "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
} as const;

const FEED_KEYS = Object.keys(FEED_IDS) as (keyof typeof FEED_IDS)[];

// Maps hook key → CoinGecko-style PriceMap key so useRiskEngine can consume it.
const KEY_MAP: Record<keyof typeof FEED_IDS, string> = {
  sui:  "sui",
  eth:  "ethereum",
  btc:  "bitcoin",
  usdt: "tether",
  usdc: "usd-coin",
};

export type PythPriceEntry = {
  usd: number;
  conf: number;
  feedId: string;
};

export type PythPriceMap = Record<string, PythPriceEntry>;

const hermes = new HermesClient("https://hermes.pyth.network");

function parsePythPrice(parsed: any): { usd: number; conf: number } {
  const priceStr: string = parsed?.price?.price ?? "0";
  const expo: number = parsed?.price?.expo ?? 0;
  const confStr: string = parsed?.price?.conf ?? "0";
  const usd = Number(priceStr) * Math.pow(10, expo);
  const conf = Number(confStr) * Math.pow(10, expo);
  return { usd, conf };
}

export function usePythPrices() {
  const [pythPrices, setPythPrices] = useState<PythPriceMap | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const timerRef                    = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchPrices() {
    try {
      const ids = FEED_KEYS.map(k => FEED_IDS[k]);
      const result = await hermes.getLatestPriceUpdates(ids, { parsed: true });
      const parsed = (result as any).parsed as any[];
      if (!parsed || parsed.length === 0) return;

      const map: PythPriceMap = {};
      parsed.forEach((item: any, i: number) => {
        const key = FEED_KEYS[i];
        const cgKey = KEY_MAP[key];
        const { usd, conf } = parsePythPrice(item);
        map[cgKey] = { usd, conf, feedId: FEED_IDS[key] };
      });

      setPythPrices(map);
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchPrices();
    timerRef.current = setInterval(fetchPrices, 10_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { pythPrices, loading, error };
}
