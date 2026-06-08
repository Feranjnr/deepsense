"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProtocolPosition = {
  protocol: string;
  type: string;
  asset: string;
  objectId: string;
  fields: Record<string, unknown>;
  rawType: string;
  details: {
    liquidity?: string;
    balance?: string;
    coinTypeA?: string;
    coinTypeB?: string;
    [key: string]: string | undefined;
  };
  // Enriched by SDK fetchers when available
  healthFactor?: number;   // Navi account-level health factor (0–∞, >1 = safe)
  usdValue?: number;       // decimal-adjusted token amount × USD price
};

type HookResult = {
  positions: ProtocolPosition[];
  loading: boolean;
  error: string | null;
  protocolCounts: Record<string, number>;
};

// ─── Asset extraction helpers ─────────────────────────────────────────────────

const COIN_SYMBOLS: Record<string, string> = {
  "0x2::sui::sui":                                                                    "SUI",
  "0x5d4b302506645c3a13cd8c5f0ddc6aba02ad24abf5e0a231dff76c990c531b86::coin::coin": "USDC",
  "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::coin": "USDT",
  "0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d78bf3ec1":                       "ETH",
  "0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::coin": "BTC",
};

const COIN_KEYWORDS: [string, string][] = [
  ["usdc",  "USDC"],
  ["usdt",  "USDT"],
  ["weth",  "WETH"],
  ["cetus", "CETUS"],
  ["deep",  "DEEP"],
  ["navx",  "NAVX"],
  ["buck",  "BUCK"],
  ["hasui", "haSUI"],
  ["vsui",  "vSUI"],
  ["afsui", "afSUI"],
  ["sui",   "SUI"],
  ["eth",   "ETH"],
  ["btc",   "BTC"],
];

function coinTypeToSymbol(coinType: string): string {
  const lower = coinType.toLowerCase().replace(/\s/g, "");
  for (const [k, v] of Object.entries(COIN_SYMBOLS)) {
    if (lower.startsWith(k.toLowerCase())) return v;
  }
  const parts = lower.split("::");
  const last = parts[parts.length - 1];
  for (const [kw, sym] of COIN_KEYWORDS) {
    if (last.includes(kw)) return sym;
  }
  const rawLast = coinType.split("::").pop() ?? coinType;
  return rawLast.length <= 8 ? rawLast.toUpperCase() : rawLast.slice(0, 8).toUpperCase();
}

function extractGenericAsset(rawType: string): string {
  const m = rawType.match(/<([^,>]+)/);
  if (!m) return "?";
  return coinTypeToSymbol(m[1].trim());
}

function extractAllGenerics(rawType: string): string[] {
  const inner = rawType.match(/<(.+)>/);
  if (!inner) return [];
  const parts: string[] = [];
  let depth = 0, cur = "";
  for (const ch of inner[1]) {
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.map(coinTypeToSymbol);
}

// ─── Navi Protocol SDK fetcher ────────────────────────────────────────────────
// Navi stores all supply/borrow positions in a shared Storage object keyed by
// address. getOwnedObjects never returns these — the SDK is required.
// navi-sdk is CJS-only so Turbopack handles it without ESM static analysis.
//
// USD values come from Navi's own on-chain price oracle (getCoinOracleInfo)
// rather than an external price feed, so they match Navi's UI exactly.
// The oracle returns { price: u256, decimals: u8 } per asset.
//
// Navi normalises all token balances to 9 decimal places internally.
// getNAVIPortfolio(addr, false) returns rawBalance × interestIndex (no /1e9).
// Dividing by 1e9 converts to human-readable token amount.

async function fetchNaviPositions(
  address: string,
  network: string,
  // cgPrices kept in signature for hook compatibility — not used here
  _cgPrices?: Record<string, { usd: number; chg: number }> | null,
): Promise<ProtocolPosition[]> {
  try {
    // navi-sdk re-exports CallFunctions and address config from its main entry
    const navi = await import("navi-sdk") as any;
    const {
      NAVISDKClient,
      pool: naviPool,
      getReserveData,
      getCoinOracleInfo,
    } = navi;

    // NAVISDKClient auto-generates a throwaway mnemonic internally.
    // The generated account is never used for signing — all calls are read-only.
    const sdkClient = new NAVISDKClient({
      networkType:      network === "mainnet" ? "mainnet" : "testnet",
      numberOfAccounts: 1,
    });
    const account = sdkClient.accounts[0];
    const suiClient = account.client; // underlying Sui RPC client

    // Fetch portfolio and reserve metadata in parallel.
    // Health factor is isolated so its failure cannot block positions.
    const [portfolio, reserveData] = await Promise.all([
      account.getNAVIPortfolio(address, false) as Promise<Map<string, { borrowBalance: number; supplyBalance: number }>>,
      (getReserveData(address, suiClient) as Promise<any[]>).catch((err: unknown) => {
        console.error("[useProtocolPositions] Navi getReserveData error:", err);
        return [] as any[];
      }),
    ]);

    // Health factor in its own isolated try/catch — never cancels position fetch.
    let rawHealth: number | null = null;
    try {
      rawHealth = await account.getHealthFactor(address) as number;
    } catch (err) {
      console.error("[useProtocolPositions] Navi getHealthFactor error:", err);
    }

    // Build assetId → oracle_id map from reserve metadata
    const assetToOracleId = new Map<number, number>();
    for (const r of reserveData) {
      assetToOracleId.set(Number(r.id), Number(r.oracle_id));
    }

    // Fetch oracle prices for all reserves, keyed by oracle_id
    const oracleMap = new Map<number, number>(); // oracle_id → USD price
    if (reserveData.length > 0) {
      try {
        const oracleIds = [...new Set(reserveData.map((r: any) => Number(r.oracle_id)))] as number[];
        const oracleInfos: any[] = await getCoinOracleInfo(suiClient, oracleIds);
        for (const o of oracleInfos) {
          if (o.valid) {
            // price is a u256 bigint string; decimals is u8
            oracleMap.set(Number(o.oracle_id), Number(o.price) / Math.pow(10, Number(o.decimals)));
          }
        }
      } catch (err) {
        console.error("[useProtocolPositions] Navi getCoinOracleInfo error:", err);
      }
    }

    // Convert Navi's account-level health factor to 0–100 for the shared HEALTH column.
    // hf ≥ 2 → 100% (comfortably safe), hf = 1 → 50% (at threshold), hf < 1 → <50% (at risk).
    const naviHealthPct: number | undefined =
      rawHealth != null && isFinite(rawHealth)
        ? Math.round(Math.min(rawHealth / 2, 1) * 100)
        : undefined;

    const results: ProtocolPosition[] = [];

    portfolio.forEach(({ supplyBalance, borrowBalance }, assetKey: string) => {
      const sym = assetKey.toUpperCase();

      // Look up oracle price: poolKey → assetId (from navi-sdk pool config) → oracle_id → USD
      const poolConfig = naviPool?.[assetKey];
      const assetId: number | undefined = poolConfig?.assetId;
      const oracleId = assetId != null ? assetToOracleId.get(assetId) : undefined;
      const usdPrice: number | null = oracleId != null ? (oracleMap.get(oracleId) ?? null) : null;

      if (supplyBalance > 0) {
        const amount = supplyBalance / 1e9;
        results.push({
          protocol:     "Navi Protocol",
          type:         "LEND",
          asset:        sym,
          objectId:     `navi-lend-${sym}-${address}`,
          fields:       { supplyBalance },
          rawType:      "navi_protocol::storage::SupplyPosition",
          details:      { balance: amount.toFixed(amount < 1 ? 4 : 2) },
          healthFactor: rawHealth ?? undefined,
          usdValue:     usdPrice != null ? amount * usdPrice : undefined,
        });
      }
      if (borrowBalance > 0) {
        const amount = borrowBalance / 1e9;
        results.push({
          protocol:     "Navi Protocol",
          type:         "BORROW",
          asset:        sym,
          objectId:     `navi-borrow-${sym}-${address}`,
          fields:       { borrowBalance },
          rawType:      "navi_protocol::storage::BorrowPosition",
          details:      { balance: amount.toFixed(amount < 1 ? 4 : 2) },
          healthFactor: rawHealth ?? undefined,
          usdValue:     usdPrice != null ? amount * usdPrice : undefined,
        });
      }
    });

    // Stamp the account-level health percentage on every Navi position via details
    // so it survives the ProtocolPosition → adapter mapping in page.tsx.
    if (naviHealthPct !== undefined) {
      for (const pos of results) pos.details.healthPct = String(naviHealthPct);
    }

    return results;
  } catch (e) {
    console.error("[useProtocolPositions] Navi SDK error:", e);
    return [];
  }
}

// ─── Fallback: raw object scan ────────────────────────────────────────────────
// Covers protocols without a compatible SDK:
//   Scallop   — finds owned ObligationKey caps (indicates active obligation)
//   Cetus     — LP NFTs are owned objects; type pattern is stable
//   Aftermath, Bluefin, SuiLend, DeepBook, Turbos, Ember
//
// Plain Coin<T> wallet balance objects are always excluded.
// Note: @scallop-io/sui-scallop-sdk and @cetusprotocol/cetus-sui-clmm-sdk both
// ship ESM builds that import SuiClient/getFullnodeUrl from @mysten/sui/client,
// which no longer exists in @mysten/sui v2. Those SDKs are deferred until the
// upstream packages pin to the new API.

const COIN_OBJ_RE = /^0x0*2::coin::Coin</i;

type FallbackRule = {
  protocol: string;
  match: string[];
  inferType: (rawType: string) => string;
  inferAsset: (rawType: string) => string;
};

const FALLBACK_RULES: FallbackRule[] = [
  {
    protocol: "Scallop",
    match: [
      "0x7e58bd0fa4c3f44eb4f0fb1f328dc1627e76af1dc0d8a260b8f0e93d87d7d905",
      "scallop",
    ],
    inferType: (t) =>
      /borrow/i.test(t) ? "BORROW" : /supply|deposit/i.test(t) ? "LEND" : "POSITION",
    inferAsset: extractGenericAsset,
  },
  {
    protocol: "Cetus",
    match: [
      "0x1eabed72c53feb73c44d09aa6f6f9cad0a3e2c3e0d07a0b0e7083451d33a4f7c",
      "cetus",
      "clmm",
    ],
    inferType: () => "LP",
    inferAsset: (t) => {
      const coins = extractAllGenerics(t);
      return coins.length >= 2 ? `${coins[0]}/${coins[1]}` : coins[0] || "LP";
    },
  },
  {
    protocol: "Aftermath Finance",
    match: ["aftermath", "af_lp", "af_amm"],
    inferType: (t) => (/stake/i.test(t) ? "STAKE" : "LP"),
    inferAsset: extractGenericAsset,
  },
  {
    protocol: "Bluefin",
    match: ["bluefin", "0xb24b6789e088b876afabca733bed2299fbc9e2d6369be4d1a67f9dfe62f28002"],
    inferType: () => "POSITION",
    inferAsset: extractGenericAsset,
  },
  {
    protocol: "SuiLend",
    match: [
      "0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1",
      "suilend",
    ],
    inferType: (t) =>
      /borrow/i.test(t) ? "BORROW" : /deposit|reserve/i.test(t) ? "LEND" : "POSITION",
    inferAsset: extractGenericAsset,
  },
  {
    protocol: "Turbos Finance",
    match: ["turbos"],
    inferType: () => "LP",
    inferAsset: (t) => {
      const coins = extractAllGenerics(t);
      return coins.length >= 2 ? `${coins[0]}/${coins[1]}` : coins[0] || "LP";
    },
  },
  {
    protocol: "DeepBook",
    match: [
      "0x000000000000000000000000000000000000000000000000000000000000dee9",
      "deepbook",
    ],
    inferType: (t) => (/custodian|account/i.test(t) ? "POSITION" : "LP"),
    inferAsset: extractGenericAsset,
  },
  {
    protocol: "Ember",
    match: ["ember"],
    inferType: () => "STAKE",
    inferAsset: extractGenericAsset,
  },
];

async function fetchFallbackPositions(
  client: SuiJsonRpcClient,
  address: string,
): Promise<ProtocolPosition[]> {
  const all: unknown[] = [];
  let cursor: string | null = null;
  let pages = 0;

  while (pages < 10) {
    const page = await client.getOwnedObjects({
      owner: address,
      cursor,
      limit: 50,
      options: { showType: true, showContent: true },
    });

    const p = page as any;
    if (Array.isArray(p.data)) all.push(...p.data);
    pages++;
    if (!p.hasNextPage || !p.nextCursor) break;
    cursor = p.nextCursor as string;
  }

  const found: ProtocolPosition[] = [];
  for (const obj of all) {
    const data = (obj as any).data;
    if (!data) continue;
    const rawType: string = data.type ?? "";
    if (!rawType) continue;

    // Exclude plain wallet coin objects — these are balances, not DeFi positions
    if (COIN_OBJ_RE.test(rawType)) continue;

    const lower = rawType.toLowerCase();
    const rule = FALLBACK_RULES.find((r) =>
      r.match.some((m) => lower.includes(m.toLowerCase())),
    );
    if (!rule) continue;

    const fields: Record<string, unknown> = data.content?.fields ?? {};
    const details: ProtocolPosition["details"] = {};
    const liq = fields["liquidity"] ?? fields["lp_amount"] ?? fields["lp_balance"];
    if (liq != null) details.liquidity = String(liq);
    const bal = fields["balance"] ?? fields["amount"] ?? fields["value"] ?? fields["coin_amount"];
    if (bal != null) details.balance = String(bal);
    const ctA = fields["coin_type_a"] ?? fields["type_a"];
    if (ctA != null) details.coinTypeA = coinTypeToSymbol(String(ctA));
    const ctB = fields["coin_type_b"] ?? fields["type_b"];
    if (ctB != null) details.coinTypeB = coinTypeToSymbol(String(ctB));

    found.push({
      protocol: rule.protocol,
      type:     rule.inferType(rawType),
      asset:    rule.inferAsset(rawType),
      objectId: String(data.objectId ?? ""),
      fields,
      rawType,
      details,
    });
  }
  return found;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useProtocolPositions(
  walletAddress: string | null,
  network: string,
  cgPrices?: Record<string, { usd: number; chg: number }> | null,
): HookResult {
  const [positions, setPositions] = useState<ProtocolPosition[]>([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const timerRef                  = useRef<ReturnType<typeof setInterval> | null>(null);

  const rpcUrl = network === "mainnet"
    ? getJsonRpcFullnodeUrl("mainnet")
    : getJsonRpcFullnodeUrl("testnet");

  // Stable JSON key so the effect only re-runs when prices actually change
  const pricesKey = cgPrices ? JSON.stringify(cgPrices) : "null";

  const fetchAll = useCallback(async () => {
    if (!walletAddress) {
      setPositions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const client = new SuiJsonRpcClient({ url: rpcUrl, network: network as "mainnet" | "testnet" });

      // Navi SDK and raw scanner run in parallel; each is independently fault-tolerant.
      const [naviPos, fallbackPos] = await Promise.all([
        fetchNaviPositions(walletAddress, network, cgPrices),
        fetchFallbackPositions(client, walletAddress),
      ]);

      setPositions([...naviPos, ...fallbackPos]);
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddress, rpcUrl, network, pricesKey]);

  useEffect(() => {
    fetchAll();
    if (walletAddress) {
      timerRef.current = setInterval(fetchAll, 30_000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [fetchAll, walletAddress]);

  const protocolCounts: Record<string, number> = {};
  for (const p of positions) {
    protocolCounts[p.protocol] = (protocolCounts[p.protocol] ?? 0) + 1;
  }

  return { positions, loading, error, protocolCounts };
}
