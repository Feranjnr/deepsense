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
};

type HookResult = {
  positions: ProtocolPosition[];
  loading: boolean;
  error: string | null;
  protocolCounts: Record<string, number>;
};

// ─── Protocol fingerprints ────────────────────────────────────────────────────
// Each entry is tested against the object's full type string (lowercased).

type ProtocolRule = {
  protocol: string;
  // One of these substrings must appear in the type string
  match: string[];
  // Infer position type from type string fragments
  inferType: (rawType: string) => string;
  // Infer asset symbol from the generic type parameter (<0x2::sui::SUI> etc.)
  inferAsset: (rawType: string) => string;
};

const PROTOCOL_RULES: ProtocolRule[] = [
  {
    protocol: "Navi Protocol",
    match: [
      "0xd899cf7d2b5db716bd2cf55599fb0d5ee38a3571a6b7b6e1c21a7f1c170b6944",
      "navi_protocol",
      "naviprotocol",
    ],
    inferType: (t) =>
      /borrow/i.test(t) ? "BORROW" : /deposit|supply/i.test(t) ? "LEND" : "POSITION",
    inferAsset: extractGenericAsset,
  },
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
      // Cetus LP positions often have two coin types in generics
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

// ─── Asset extraction helpers ─────────────────────────────────────────────────

// Known full coin type prefixes → symbol
const COIN_SYMBOLS: Record<string, string> = {
  "0x2::sui::sui":                                                                    "SUI",
  "0x5d4b302506645c3a13cd8c5f0ddc6aba02ad24abf5e0a231dff76c990c531b86::coin::coin": "USDC",
  "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::coin": "USDT",
  "0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d78bf3ec1":                       "ETH",
  "0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::coin": "BTC",
};

// Keyword → symbol (matched against the last path segment of a coin type)
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
  // Keyword match on last segment (e.g. "::haSUI" or "::USDC")
  const parts = lower.split("::");
  const last = parts[parts.length - 1];
  for (const [kw, sym] of COIN_KEYWORDS) {
    if (last.includes(kw)) return sym;
  }
  // Fall back to raw last segment, uppercased (cap at 8 chars)
  const rawLast = coinType.split("::").pop() ?? coinType;
  return rawLast.length <= 8 ? rawLast.toUpperCase() : rawLast.slice(0, 8).toUpperCase();
}

/** Extract first generic type parameter coin symbol from a type string like Foo<0x2::sui::SUI> */
function extractGenericAsset(rawType: string): string {
  const m = rawType.match(/<([^,>]+)/)
  if (!m) return "?"
  return coinTypeToSymbol(m[1].trim())
}

/** Extract all generic type parameter coin symbols */
function extractAllGenerics(rawType: string): string[] {
  const inner = rawType.match(/<(.+)>/)
  if (!inner) return []
  // Split on commas that are not inside angle brackets
  const parts: string[] = []
  let depth = 0, cur = ""
  for (const ch of inner[1]) {
    if (ch === "<") depth++
    else if (ch === ">") depth--
    if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = "" }
    else cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts.map(coinTypeToSymbol)
}

// ─── Matching ─────────────────────────────────────────────────────────────────

function matchProtocol(rawType: string): ProtocolRule | null {
  const lower = rawType.toLowerCase()
  for (const rule of PROTOCOL_RULES) {
    if (rule.match.some((m) => lower.includes(m.toLowerCase()))) return rule
  }
  return null
}

// ─── Fetch with pagination ────────────────────────────────────────────────────

async function fetchAllOwnedObjects(
  client: SuiJsonRpcClient,
  owner: string,
): Promise<unknown[]> {
  const all: unknown[] = []
  let cursor: string | null = null
  let pages = 0

  while (pages < 10) { // safety cap: max 500 objects
    const page = await client.getOwnedObjects({
      owner,
      cursor,
      limit: 50,
      options: { showType: true, showContent: true },
    })

    const p = page as any
    if (Array.isArray(p.data)) all.push(...p.data)
    pages++

    if (!p.hasNextPage || !p.nextCursor) break
    cursor = p.nextCursor as string
  }

  return all
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useProtocolPositions(
  walletAddress: string | null,
  network: string,
): HookResult {
  const [positions, setPositions] = useState<ProtocolPosition[]>([])
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const timerRef                  = useRef<ReturnType<typeof setInterval> | null>(null)

  const rpcUrl = network === "mainnet"
    ? getJsonRpcFullnodeUrl("mainnet")
    : getJsonRpcFullnodeUrl("testnet")

  const fetch = useCallback(async () => {
    if (!walletAddress) {
      setPositions([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const client = new SuiJsonRpcClient({ url: rpcUrl, network: network as "mainnet" | "testnet" })
      const objects = await fetchAllOwnedObjects(client, walletAddress)

      const found: ProtocolPosition[] = []
      for (const obj of objects) {
        // Cast to any — the RPC returns a richer shape than our minimal stub covers
        const data = (obj as any).data
        if (!data) continue
        const rawType: string = data.type ?? ""
        if (!rawType) continue

        const rule = matchProtocol(rawType)
        if (!rule) continue

        const fields: Record<string, unknown> = data.content?.fields ?? {}

        // Extract structured details from content fields
        const details: ProtocolPosition["details"] = {}
        const liq = fields["liquidity"] ?? fields["lp_amount"] ?? fields["lp_balance"]
        if (liq != null) details.liquidity = String(liq)
        const bal = fields["balance"] ?? fields["amount"] ?? fields["value"] ?? fields["coin_amount"]
        if (bal != null) details.balance = String(bal)
        const ctA = fields["coin_type_a"] ?? fields["type_a"]
        if (ctA != null) details.coinTypeA = coinTypeToSymbol(String(ctA))
        const ctB = fields["coin_type_b"] ?? fields["type_b"]
        if (ctB != null) details.coinTypeB = coinTypeToSymbol(String(ctB))

        found.push({
          protocol:  rule.protocol,
          type:      rule.inferType(rawType),
          asset:     rule.inferAsset(rawType),
          objectId:  String(data.objectId ?? ""),
          fields,
          rawType,
          details,
        })
      }

      setPositions(found)
      setError(null)
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setLoading(false)
    }
  }, [walletAddress, rpcUrl, network])

  useEffect(() => {
    fetch()
    if (walletAddress) {
      timerRef.current = setInterval(fetch, 30_000)
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [fetch, walletAddress])

  const protocolCounts: Record<string, number> = {}
  for (const p of positions) {
    protocolCounts[p.protocol] = (protocolCounts[p.protocol] ?? 0) + 1
  }

  return { positions, loading, error, protocolCounts }
}
