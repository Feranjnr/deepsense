"use client"

import { useState, useEffect, useRef } from "react"
import { SuiClientProvider, WalletProvider, ConnectButton as DappConnectButton } from "@mysten/dapp-kit"
import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit"

// ─── DESIGN TOKENS ─────────────────────────────────────────────────────────────
const C = {
  bg: "#03080f", surface: "#060d16", card: "#08111c",
  border: "#0e2035", borderHi: "#1a3d5c",
  accent: "#0af5d4", accentDim: "#07b89c",
  blue: "#0a7fff", blueDim: "#065ab5",
  gold: "#f5c842", danger: "#ff4567",
  warn: "#ff9900", safe: "#00e676",
  text: "#d0e8f0", muted: "#3a5a70", mutedHi: "#5a7a90",
}
const MONO = "'IBM Plex Mono','Courier New',monospace"
const SANS = "'IBM Plex Sans',system-ui,sans-serif"

// ─── FORMAT HELPERS ────────────────────────────────────────────────────────────
const fmt = {
  usd: (n: number) => n >= 1e6 ? `$${(n/1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n/1e3).toFixed(1)}K` : `$${n.toFixed(2)}`,
  pct: (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`,
  num: (n: number) => n.toLocaleString(),
  addr: (a?: string) => a ? `${a.slice(0,6)}…${a.slice(-4)}` : "—",
  sui: (n: number | bigint) => {
    const big = typeof n === "bigint" ? n : BigInt(n)
    return (Number(big) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 })
  },
}
function healthColor(h: number) { return h >= 80 ? C.safe : h >= 50 ? C.warn : C.danger }
function sevColor(s: string)     { return s === "HIGH" ? C.danger : s === "MEDIUM" ? C.warn : C.accent }

// ─── NETWORK TAGS ──────────────────────────────────────────────────────────────
const NET = {
  testnet: { label: "TESTNET", color: C.warn,   rpc: "https://fullnode.testnet.sui.io" },
  mainnet: { label: "MAINNET", color: C.safe,   rpc: "https://fullnode.mainnet.sui.io" },
}

// ─── COIN METADATA LOOKUP TABLE ───────────────────────────────────────────────
// Maps Sui runtime coin types (MVR type format) to human-readable symbol.
// Keys use short 0x prefix, values use full canonical form for RPC calls.
const COIN_DEFS: Record<string, { symbol: string; decimals: number; short: string }> = {
  "0x2::sui::SUI":  { symbol: "SUI",  decimals: 9,  short: "0x2::sui::SUI" },
  "0x5d4b302506645c3a13cd8c5f0ddc6aba02ad24abf5e0a231dff76c990c531b86::coin::COIN": { symbol: "USDC", decimals: 6, short: "0x5d4b3025..." },
}

/** Look up coin metadata symbol, falling back to coinType short-id */
function coinSymbol(coinType: string): string {
  return COIN_DEFS[coinType]?.symbol ?? coinType.split("::").pop() ?? "UNKNOWN"
}

/** Resolve full canonical coin type (MVR names supported) */
function canonicalCoinType(coinType: string): string {
  // coinType already comes back as canonical from RPC; return as-is if matched
  return COIN_DEFS[coinType] ? coinType : coinType
}

// ─── MOCK DATA (pre-wallet-connect fallback; replaced by live data when connected) ─
const MOCK_POOLS = [
  { id: "pool_sui_usdc",  base: "SUI",  quote: "USDC", price: 2.47,  change: -3.2,  volume: 4_820_000,  spread: 0.02, liquidity: 12_400_000 }
,
  { id: "pool_eth_usdc",  base: "ETH",  quote: "USDC", price: 3821,   change: +1.8,  volume: 9_100_000,  spread: 0.04, liquidity: 28_700_000 },
  { id: "pool_btc_usdc",  base: "BTC",  quote: "USDC", price: 67400,  change: +0.6,  volume: 6_300_000,  spread: 0.03, liquidity: 41_200_000 },
  { id: "pool_sui_eth",   base: "SUI",  quote: "ETH",  price: 0.00065,change: -1.1, volume: 1_200_000,  spread: 0.05, liquidity: 5_600_000 },

  { id: "pool_usdt_usdc", base: "USDT", quote: "USDC", price: 0.9998, change: 0.0,   volume: 22_000_000, spread: 0.001,liquidity: 80_000_000 },
]

// ─── LIVE PRICE HOOK ───────────────────────────────────────────────────────────
// Fetches SUI, ETH, BTC, USDT, USDC from CoinGecko every 30 s.
// Falls back silently to MOCK_POOLS on any network error.

function useCoinGeckoPrices(refetchMs = 30_000): { pools: any[]; loading: boolean; prices: Record<string, { usd: number; chg: number }> | null } {
  const [prices, setPrices] = useState<Record<string, { usd: number; chg: number }> | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const fetchOnce = async () => {
      try {
        const ids = "sui,ethereum,bitcoin,tether,usd-coin"
        const resp = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
          { signal: undefined }
        )
        if (!resp.ok) throw new Error("coingecko " + resp.status)
        const data = (await resp.json()) as any // CoinGeckoResponse
        if (cancelled) return
        const map: Record<string, { usd: number; chg: number }> = {}
        for (const [k, v] of Object.entries(data)) map[k] = { usd: (v as any).usd, chg: (v as any).usd_24h_change }
        setPrices(map)
        setLoading(false)
      } catch {
        if (!cancelled) setLoading(false)
      }
    }
    fetchOnce()
    const id = setInterval(fetchOnce, refetchMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [refetchMs])

  if (loading || !prices) return { pools: MOCK_POOLS, loading, prices: null }

  const derived: any[] = []
  if (prices.sui && prices["usd-coin"]) {
    derived.push({
      id: "pool_sui_usdc", base: "SUI", quote: "USDC",
      price: prices.sui.usd, change: prices.sui.chg,
      volume: MOCK_POOLS[0].volume, spread: 0.02, liquidity: MOCK_POOLS[0].liquidity,
    })
  }
  if (prices.sui && prices.ethereum) {
    derived.push({
      id: "pool_sui_eth", base: "SUI", quote: "ETH",
      price: prices.sui.usd / prices.ethereum.usd, change: prices.sui.chg - prices.ethereum.chg,
      volume: MOCK_POOLS[3].volume, spread: 0.05, liquidity: MOCK_POOLS[3].liquidity,
    })
  }
  if (prices.ethereum && prices["usd-coin"]) {
    derived.push({
      id: "pool_eth_usdc", base: "ETH", quote: "USDC",
      price: prices.ethereum.usd, change: prices.ethereum.chg,
      volume: MOCK_POOLS[1].volume, spread: 0.04, liquidity: MOCK_POOLS[1].liquidity,
    })
  }
  if (prices.bitcoin && prices["usd-coin"]) {
    derived.push({
      id: "pool_btc_usdc", base: "BTC", quote: "USDC",
      price: prices.bitcoin.usd, change: prices.bitcoin.chg,
      volume: MOCK_POOLS[2].volume, spread: 0.03, liquidity: MOCK_POOLS[2].liquidity,
    })
  }
  if (prices.tether && prices["usd-coin"]) {
    derived.push({
      id: "pool_usdt_usdc", base: "USDT", quote: "USDC",
      price: prices.tether.usd / prices["usd-coin"].usd, change: prices.tether.chg - prices["usd-coin"].chg,
      volume: MOCK_POOLS[4].volume, spread: 0.001, liquidity: MOCK_POOLS[4].liquidity,
    })
  }

  return { pools: derived.length === 5 ? derived : MOCK_POOLS, loading, prices }
}

// Mock positions used when no wallet is connected (demo mode)
const MOCK_POSITIONS = [
  { id: "p1", protocol: "Navi Protocol",   type: "LONG",  asset: "SUI",    size: 5000,  collateral: 2200, leverage: 3,   entryPrice: 2.61,  liquidationPrice: 1.94, health: 68, pnl: -700,  pnlPct: -13.2, pool: "pool_sui_usdc"  },
  { id: "p2", protocol: "Scallop Lend",    type: "LEND",  asset: "USDC",   size: 8000,  collateral: 8000, leverage: 1,   entryPrice: 1.00,  liquidationPrice: null,  health: 100,pnl:  320,  pnlPct: +4.0,  pool: "pool_usdt_usdc" },
  { id: "p3", protocol: "Cetus DEX",       type: "LP",    asset: "SUI/USDC",size: 3200, collateral: 3200, leverage: 1,  entryPrice: 2.55,  liquidationPrice: null,  health: 92, pnl:  -160, pnlPct: -4.8,  pool: "pool_sui_usdc"  },
  { id: "p4", protocol: "DeepBook",        type: "SHORT", asset: "ETH",    size: 2000,  collateral:  900, leverage: 2.2, entryPrice: 3750,  liquidationPrice: 4125,  health: 44, pnl:  142,  pnlPct: +7.1,  pool: "pool_eth_usdc"  },
]

const MOCK_RISK_EVENTS = [
  { time: "14:32:01", event: "Liquidation Warning",    position: "SUI LONG 3x",   severity: "HIGH",   detail: "18% from liquidation" },
  { time: "14:28:44", event: "Funding Rate Spike",     position: "ETH SHORT 2x",  severity: "MEDIUM", detail: "Rate +0.14% / 8h"   },
  { time: "14:21:13", event: "Oracle Deviation",       position: "SUI/USDC LP",   severity: "LOW",    detail: "DeepBook vs Pyth: 0.3%" },
  { time: "14:15:07", event: "Correlated Exposure",    position: "All Positions", severity: "MEDIUM", detail: "78% SUI correlation"  },
  { time: "14:02:55", event: "Volume Anomaly",         position: "pool_sui_usdc", severity: "LOW",    detail: "3.2x avg 1hr volume"  },
]

const MOCK_BIDS = [
  { price: 2.468, size: 12400, total: 30603 },
  { price: 2.465, size:  8900, total: 18203 },
  { price: 2.462, size: 15600, total:  9303 },
  { price: 2.459, size:  5200, total: 12775 },
  { price: 2.456, size:  7575, total:  7575 },
]
const MOCK_ASKS = [
  { price: 2.470, size:  9800, total:  9800 },
  { price: 2.473, size:  6200, total: 16000 },
  { price: 2.476, size: 11400, total: 27400 },
  { price: 2.479, size:  8300, total: 35700 },
  { price: 2.482, size:  5100, total: 40800 },
]

// ─── UI PRIMITIVES ─────────────────────────────────────────────────────────────
function Glow({ children, color = C.accent, size = 13, weight = 600, mono = true, style }: any) {
  const merged: any = {
    fontFamily: mono ? MONO : SANS, color, fontSize: size, fontWeight: weight,
    textShadow: `0 0 12px ${color}66`,
  }
  return <span style={{ ...merged, ...style }}>{children}</span>
}
function Tag({ children, color = C.accent }: any) {
  return <span style={{
    fontFamily: MONO, fontSize: 10, color, border: `1px solid ${color}55`,
    padding: "2px 7px", borderRadius: 2, background: color+"11", letterSpacing: 1,
    textShadow: `0 0 6px ${color}44`,
  }}>{children}</span>
}
function Card({ children, style, glow = false, onClick }: any) {
  return <div onClick={onClick} style={{
    background: C.card,
    border: `1px solid ${glow ? C.borderHi : C.border}`,
    borderRadius: 6,
    boxShadow: glow ? `0 0 24px ${C.accent}14, inset 0 1px 0 ${C.borderHi}` : `inset 0 1px 0 ${C.border}`,
    cursor: onClick ? "pointer" : "default",
    ...style,
  }}>{children}</div>
}
function HealthBar({ value, style }: { value: number; style?: any }) {
  const col = healthColor(value)
  return (
    <div style={{ height: 4, background: C.border, borderRadius: 2, overflow: "hidden", ...style }}>
      <div style={{
        height: "100%", width: `${value}%`, background: col,
        boxShadow: `0 0 8px ${col}`, transition: "width 0.6s ease", borderRadius: 2,
      }} />
    </div>
  )
}
function Pill({ label, active, onClick, color = C.accent }: any) {
  return <button onClick={onClick} style={{
    fontFamily: MONO, fontSize: 11, padding: "5px 14px",
    background: active ? color+"22" : "transparent",
    border: `1px solid ${active ? color : C.border}`,
    color: active ? color : C.muted, borderRadius: 3,
    cursor: "pointer", textShadow: active ? `0 0 8px ${color}` : "none",
    transition: "all 0.2s", letterSpacing: 1,
  }}>{label}</button>
}
function NetBadge({ phase }: { phase: string }) {
  const net = NET[phase as keyof typeof NET]
  return <div style={{
    display: "flex", alignItems: "center", gap: 6, padding: "4px 10px",
    border: `1px solid ${net.color}44`, borderRadius: 3, background: net.color+"11",
  }}>
    <span style={{
      width: 6, height: 6, borderRadius: "50%", background: net.color,
      boxShadow: `0 0 8px ${net.color}`, display: "inline-block",
    }} />
    <span style={{ fontFamily: MONO, fontSize: 10, color: net.color, letterSpacing: 2 }}>{net.label}</span>
  </div>
}
function SectionHeader({ title, sub, action }: any) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
      <div>
        <Glow size={11} style={{ letterSpacing: 3, display: "block", marginBottom: 3 }}>{title}</Glow>
        {sub && <span style={{ fontFamily: SANS, fontSize: 12, color: C.mutedHi }}>{sub}</span>}
      </div>
      {action}
    </div>
  )
}

// ─── TICKER ────────────────────────────────────────────────────────────────────
function LiveTicker({ pools }: { pools: any[] }) {
  const [offset, setOffset] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setOffset(o => o - 1), 30)
    return () => clearInterval(t)
  }, [])
  const items = [...pools, ...pools]
  return (
    <div style={{
      overflow: "hidden", background: C.surface, borderBottom: `1px solid ${C.border}`,
      padding: "6px 0", position: "relative",
    }}>
      <div style={{
        display: "flex", gap: 48, transform: `translateX(${offset % 600}px)`,
        whiteSpace: "nowrap", transition: "none",
      }}>
        {items.map((p: any, i: number) => (
          <span key={i} style={{ fontFamily: MONO, fontSize: 11, display: "inline-flex", gap: 8 }}>
            <span style={{ color: C.mutedHi }}>{p.base}/{p.quote}</span>
            <span style={{ color: C.text }}>{fmt.usd(p.price)}</span>
            <span style={{ color: p.change >= 0 ? C.safe : C.danger }}>{fmt.pct(p.change)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── PORTFOLIO OVERVIEW ────────────────────────────────────────────────────────
function PortfolioOverview({ positions, network, isLive }: any) {
  const totalValue = positions.reduce((s: number, p: any) => s + p.size, 0)
  const totalPnl   = positions.reduce((s: number, p: any) => s + p.pnl,   0)
  const avgHealth  = Math.round(positions.reduce((s: number, p: any) => s + p.health, 0) / positions.length)
  const atRisk     = positions.filter((p: any) => p.health < 60).length
  const net = NET[network as keyof typeof NET]
  const stats = [
    { label: isLive ? "PORTFOLIO VALUE" : "PORTFOLIO VALUE (Demo)", value: fmt.usd(totalValue), color: C.text,   sub: `${positions.length} positions` },
    { label: "TOTAL PNL",        value: fmt.usd(Math.abs(totalPnl)), color: totalPnl >= 0 ? C.safe : C.danger, sub: totalPnl >= 0 ? "▲ Profitable" : "▼ In loss" },
    { label: "AVG HEALTH",       value: `${avgHealth}%`,               color: healthColor(avgHealth),        sub: "Across all positions" },
    { label: "AT RISK",          value: `${atRisk} pos`,               color: atRisk > 0 ? C.danger : C.safe, sub: "Health < 60%" },
  ]
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 16 }}>
      {stats.map((s: any) => (
        <Card key={s.label} style={{ padding: "16px 18px" }}>
          <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 3, marginBottom: 8 }}>{s.label}</div>
          <Glow color={s.color} size={24} weight={700}>{s.value}</Glow>
          <div style={{ fontFamily: SANS, fontSize: 11, color: C.mutedHi, marginTop: 5 }}>{s.sub}</div>
        </Card>
      ))}
    </div>
  )
}

// ─── POSITION TABLE ────────────────────────────────────────────────────────────
function PositionTable({ positions, onSelect, selected, isLive }: any) {
  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
        <SectionHeader title="OPEN POSITIONS" sub={
          isLive
            ? "Live on-chain data · Sui Mainnet"
            : "Demo data · Connect wallet for live positions"
        } />
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${C.border}` }}>
              {["PROTOCOL","TYPE","ASSET","SIZE","LEVERAGE","HEALTH","PNL",""].map(h => (
                <th key={h} style={{
                  fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 2,
                  padding: "8px 14px", textAlign: "left", fontWeight: 400,
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {positions.map((p: any) => {
              const pool = MOCK_POOLS.find((d: any) => d.id === p.pool) || MOCK_POOLS[0]
              const liqPrice = p.liquidationPrice
                ? `$${p.liquidationPrice.toLocaleString()}`
                : `~${fmt.usd(pool.price * (p.type === "LONG" ? 0.85 : 1.15))}`
              return (
                <tr key={p.id} onClick={() => onSelect(p)}
                  style={{
                    borderBottom: `1px solid ${C.border}`, cursor: "pointer",
                    background: selected?.id === p.id ? C.accent+"08" : "transparent",
                    borderLeft: selected?.id === p.id ? `2px solid ${C.accent}` : "2px solid transparent",
                    transition: "background 0.15s",
                  }}>
                  <td style={{ padding: "12px 14px" }}><span style={{ fontFamily: SANS, fontSize: 12, color: C.text }}>{p.protocol}</span></td>
                  <td style={{ padding: "12px 14px" }}>
                    <Tag color={p.type==="SHORT"?C.danger : p.type==="LONG"?C.safe : p.type==="LP"?C.gold : C.blue}>{p.type}</Tag>
                  </td>
                  <td style={{ padding: "12px 14px" }}><span style={{ fontFamily: MONO, fontSize: 12, color: C.text }}>{p.asset}</span></td>
                  <td style={{ padding: "12px 14px" }}><span style={{ fontFamily: MONO, fontSize: 12, color: C.text }}>{fmt.usd(p.size)}</span></td>
                  <td style={{ padding: "12px 14px" }}>
                    <span style={{ fontFamily: MONO, fontSize: 12, color: p.leverage > 2 ? C.warn : C.text }}>{p.leverage}x</span>
                  </td>
                  <td style={{ padding: "12px 14px", minWidth: 80 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <HealthBar value={p.health} style={{ flex: 1 }} />
                      <span style={{ fontFamily: MONO, fontSize: 11, color: healthColor(p.health), minWidth: 30 }}>{p.health}%</span>
                    </div>
                  </td>
                  <td style={{ padding: "12px 14px" }}>
                    {p.type === "SPOT"
                      ? <span style={{ fontFamily: MONO, fontSize: 12, color: C.muted }}>HODL</span>
                      : <span style={{ fontFamily: MONO, fontSize: 12, color: p.pnl >= 0 ? C.safe : C.danger }}>
                          {fmt.usd(Math.abs(p.pnl))} <span style={{ fontSize: 10 }}>({fmt.pct(p.pnlPct)})</span>
                        </span>
                    }
                  </td>
                  <td style={{ padding: "12px 14px" }}>
                    <button style={{
                      fontFamily: MONO, fontSize: 10, padding: "4px 10px",
                      background: C.accent+"11", border: `1px solid ${C.accent}44`,
                      color: C.accent, borderRadius: 2, cursor: "pointer", letterSpacing: 1,
                    }}>ANALYZE →</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// ─── DEEPBOOK ORDERBOOK ─────────────────────────────────────────────────────────
function DeepBookPanel({ pools, selectedPool }: any) {
  const pool = selectedPool || MOCK_POOLS[0]
  const BIDS  = pool.bids  || MOCK_BIDS
  const ASKS  = pool.asks  || MOCK_ASKS
  const maxBid = Math.max(...BIDS.map((b: any) => b.total))
  const maxAsk = Math.max(...ASKS.map((a: any) => a.total))
  const spread  = pool.asks?.[0] && pool.bids?.[0]
    ? (pool.asks[0].price - pool.bids[0].price).toFixed(4)
    : "0.0400"
  const spreadPct = pool.asks?.[0] && pool.bids?.[0] && pool.asks[0].price > 0
    ? ((pool.asks[0].price - pool.bids[0].price) / pool.asks[0].price * 100).toFixed(3)
    : "0.160"
  return (
    <Card>
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
        <SectionHeader title="DEEPBOOK ORDERBOOK" sub={`${pool.base}/${pool.quote} · CLOB · Simulated orderbook`} />
        <div style={{ display: "flex", gap: 16 }}>
          {[
            ["24H VOL", pool.volume ? fmt.usd(pool.volume) : "—"],
            ["LIQUIDITY", pool.liquidity ? fmt.usd(pool.liquidity) : "—"],
            ["SPREAD", `${pool.spread ?? spread}% (${spreadPct}%)`],
          ].map(([k, v]: any) => (
            <div key={k}>
              <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 2 }}>{k}</div>
              <div style={{ fontFamily: MONO, fontSize: 12, color: C.text }}>{v}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ padding: 16 }}>
        {["PRICE","SIZE","TOTAL"].map(h => (
          <div key={h} style={{
            display: "grid", gridTemplateColumns: "1fr 1fr 1fr", marginBottom: 2,
          }}>
            {["PRICE","SIZE","TOTAL"].map((v, j) => (
              <div key={j} style={{
                fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 2,
                textAlign: "right", paddingRight: 8,
              }}>{v}</div>
            ))}
          </div>
        ))}
        {ASKS.slice().reverse().map((a: any, i: number) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", position: "relative", marginBottom: 2 }}>
            <div style={{
              position: "absolute", right: 0, top: 0, bottom: 0,
              width: `${(a.total / maxAsk) * 100}%`, background: C.danger+"12", borderRadius: 2,
            }} />
            {[a.price.toFixed(3), fmt.num(a.size), fmt.num(a.total)].map((v: string | number, j: number) => (
              <div key={j} style={{
                fontFamily: MONO, fontSize: 11, color: j === 0 ? C.danger : C.text,
                textAlign: "right", padding: "2px 8px", position: "relative", zIndex: 1,
              }}>{v}</div>
            ))}
          </div>
        ))}
        <div style={{
          borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`,
          padding: "6px 8px", margin: "4px 0", display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <Glow size={16} color={C.accent} weight={700}>{fmt.usd(pool.price ?? 2.47)}</Glow>
          <Tag color={pool.change >= 0 ? C.safe : C.danger}>{(pool.change ?? -0.3) >= 0 ? "+" : ""}{pool.change ?? -0.3}%</Tag>
        </div>
        {BIDS.map((b: any, i: number) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", position: "relative", marginBottom: 2 }}>
            <div style={{
              position: "absolute", right: 0, top: 0, bottom: 0,
              width: `${(b.total / maxBid) * 100}%`, background: C.safe+"12", borderRadius: 2,
            }} />
            {[b.price.toFixed(3), fmt.num(b.size), fmt.num(b.total)].map((v: string | number, j: number) => (
              <div key={j} style={{
                fontFamily: MONO, fontSize: 11, color: j === 0 ? C.safe : C.text,
                textAlign: "right", padding: "2px 8px", position: "relative", zIndex: 1,
              }}>{v}</div>
            ))}
          </div>
        ))}
      </div>
    </Card>
  )
}

// ─── RISK FEED ─────────────────────────────────────────────────────────────────
function RiskFeed({ events }: { events: any[] }) {
  return (
    <Card>
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
        <SectionHeader title="RISK EVENT FEED" sub={"AI-detected anomalies · Real-time"} />
      </div>
      {events.map((e: any, i: number) => (
        <div key={i} style={{
          padding: "12px 16px", borderBottom: i < events.length-1 ? `1px solid ${C.border}` : "none",
          display: "flex", gap: 12, alignItems: "flex-start",
        }}>
          <div style={{
            width: 3, alignSelf: "stretch", background: sevColor(e.severity),
            borderRadius: 2, flexShrink: 0, boxShadow: `0 0 6px ${sevColor(e.severity)}`,
          }} />
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontFamily: SANS, fontSize: 12, color: C.text, fontWeight: 600 }}>{e.event}</span>
              <Tag color={sevColor(e.severity)}>{e.severity}</Tag>
            </div>
            <div style={{ fontFamily: MONO, fontSize: 11, color: C.mutedHi, marginBottom: 3 }}>{e.position}</div>
            <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted }}>{e.detail}</div>
          </div>
          <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted, flexShrink: 0 }}>{e.time}</span>
        </div>
      ))}
    </Card>
  )
}

// ─── SCENARIO SIMULATOR ─────────────────────────────────────────────────────────
function ScenarioSimulator({ positions }: any) {
  const [drop, setDrop] = useState(20)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  async function simulate() {
    setLoading(true)
    setResult(null)
    try {
      const  groqKey =
        typeof window !== "undefined" && (window as any).__GROQ_KEY__
          ? (window as any).__GROQ_KEY__
          : ""
      if (! groqKey) { setResult("Set GROQ_API_KEY in the demo panel above."); setLoading(false); return }

      const prompt = `You are DeepSense, an AI risk advisor for Sui DeFi and DeepBook margin traders.

A trader has these open positions:
${positions.map((p: any) =>
  `- ${p.type} ${p.asset} on ${p.protocol}: Size $${p.size}, Leverage ${p.leverage}x, Health ${p.health}%, Liquidation at $${p.liquidationPrice ?? "N/A"}, Current PNL: $${p.pnl}`
).join("\n")}

Scenario: The market drops ${drop}% across all assets in the next hour.

Analyze:
1. LIQUIDATION CASCADE — which positions get liquidated first and in what order, with exact dollar losses
2. SURVIVING POSITIONS — what remains and its new health scores
3. TOTAL PORTFOLIO IMPACT — final portfolio value and total loss
4. DEEPBOOK IMPACT — how this affects their DeepBook orderbook exposure and liquidity
5. IMMEDIATE ACTIONS — 3 specific things they should do RIGHT NOW before this happens

Be precise, use numbers, be direct. Format with clear headers.`

      const res = await fetch("/api/advisor", {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt }],
          apiKey: groqKey,
        }),
      })
      const data = await res.json()
      setResult(data.reply || "Simulation failed.")
    } catch { setResult("Network error. Check connection.") }
    setLoading(false)
  }

  return (
    <Card>
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
        <SectionHeader title="SCENARIO SIMULATOR" sub="AI stress-test your portfolio" />
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontFamily: SANS, fontSize: 12, color: C.text }}>Market Crash Scenario</span>
            <Glow color={C.danger} size={16} weight={700}>-{drop}%</Glow>
          </div>
          <input
            type="range" min={5} max={80} value={drop}
            onChange={e => setDrop(+e.target.value)}
            style={{ width: "100%", accentColor: C.danger, height: 4 }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
            {[5, 20, 40, 60, 80].map(v => (
              <span key={v} style={{ fontFamily: MONO, fontSize: 9, color: C.muted }}>{v}%</span>
            ))}
          </div>
        </div>

        {/* Quick-status cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 14 }}>
          {positions.filter((p: any) => p.liquidationPrice).map((p: any) => {
            const pools = MOCK_POOLS
            const pool   = pools.find((d: any) => d.id === p.pool) || pools[0]
            const crashPrice = pool.price * (1 - drop / 100)
            const liq = p.liquidationPrice as number
            const willLiq = p.type === "LONG" ? crashPrice < liq : crashPrice > liq
            return (
              <div key={p.id} style={{
                padding: "10px 12px",
                background: willLiq ? C.danger+"11" : C.safe+"08",
                border: `1px solid ${willLiq ? C.danger+"44" : C.border}`,
                borderRadius: 4,
              }}>
                <div style={{ fontFamily: MONO, fontSize: 10, color: C.mutedHi, marginBottom: 4 }}>{p.asset}</div>
                <div style={{ fontFamily: SANS, fontSize: 11, color: willLiq ? C.danger : C.safe, fontWeight: 600 }}>
                  {willLiq ? "⚠ LIQUIDATED" : "✓ SURVIVES"}
                </div>
                  <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted, marginTop: 3 }}>
                    Crash: ~{fmt.usd(Number(crashPrice.toFixed(4)))} / Liq: {Number(liq).toLocaleString()}
                  </div>
              </div>
            )
          })}
        </div>

        <button onClick={simulate} disabled={loading} style={{
          width: "100%", padding: "11px",
          background: loading ? C.border : `linear-gradient(135deg,${C.accent}22,${C.blue}22)`,
          border: `1px solid ${loading ? C.muted : C.accent}`,
          color: loading ? C.muted : C.accent,
          fontFamily: MONO, fontSize: 12, fontWeight: 700,
          letterSpacing: 2, borderRadius: 4,
          marginBottom: result ? 14 : 0,
          textShadow: loading ? "none" : `0 0 8px ${C.accent}`,
        }}>
          {loading ? "[ RUNNING SIMULATION… ]" : "[ RUN AI STRESS TEST ]"}
        </button>

        {result && (
          <div style={{
            background: C.bg, border: `1px solid ${C.borderHi}`, borderRadius: 4,
            padding: 14, fontFamily: SANS, fontSize: 12, color: C.text, lineHeight: 1.8,
            whiteSpace: "pre-wrap", maxHeight: 320, overflowY: "auto",
          }}>{result}</div>
        )}
      </div>
    </Card>
  )
}

// ─── AI ADVISOR CHAT ────────────────────────────────────────────────────────────
function AIAdvisor({ positions, pools, groqKey }: any) {
  const [messages, setMessages] = useState<{role:"assistant"|"user";text:string}[]>([
    { role: "assistant", text: "Hello. I'm DeepSense — your AI risk advisor for Sui DeFi. I have full visibility into your positions across Navi, Scallop, Cetus, and DeepBook. Ask me anything about your portfolio, risk exposure, or market conditions." }
  ])
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }) }, [messages])

  const SUGGESTIONS = [
    "What's my biggest risk right now?",
    "Should I close my SUI long?",
    "How do I reduce liquidation risk?",
    "Explain my DeepBook exposure",
    "What if ETH pumps 20%?",
  ]

  async function send(text?: string) {
    const q = text || input.trim()
    if (!q) return
    setInput("")
    setMessages(m => [...m, { role: "user", text: q }])
    setLoading(true)

    const context = `You are DeepSense, an elite AI DeFi risk advisor for the Sui blockchain and DeepBook CLOB.

Current portfolio:
${positions.map((p: any) =>
  `- ${p.type} ${p.asset} on ${p.protocol}: $${p.size} size, ${p.leverage}x leverage, Health ${p.health}%, PnL $${p.pnl} (${p.pnlPct}%), Liquidation: $${p.liquidationPrice ?? "none"}`
).join("\n")}

DeepBook pools active:
${pools.map((p: any) =>
  `- ${p.base}/${p.quote}: $${fmt.usd(p.price)} (${fmt.pct(p.change)}), Vol ${fmt.usd(p.volume)}, Spread ${p.spread}%`
).join("\n")}

Be conversational but precise. Use specific numbers from the portfolio. Keep responses under 200 words. Give actionable advice. You understand Sui's object model, Move contracts, and DeepBook's CLOB mechanics.`

    try {
      const res = await fetch("/api/advisor", {
        method: "POST",
        body: JSON.stringify({
          system: context,
          messages: [...messages, { role: "user", content: q }],
          apiKey: groqKey,
        }),
      })
      const data = await res.json()
      const reply: string = data.reply || "Unable to respond."
      setMessages(m => [...m, { role: "assistant", text: reply }])
    } catch {
      setMessages(m => [...m, { role: "assistant", text: "Connection error. Please retry." }])
    }
    setLoading(false)
  }

  return (
    <Card style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
        <SectionHeader title="AI RISK ADVISOR" sub={"Powered by Llama 3.3 · Context-aware · Portfolio-specific"} />
      </div>
      <div style={{
        flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column",
        gap: 12, minHeight: 300, maxHeight: 400,
      }}>
        {messages.map((m: any, i: number) => (
          <div key={i} style={{
            display: "flex", flexDirection: m.role === "user" ? "row-reverse" : "row", gap: 10,
          }}>
            <div style={{
              width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
              background: m.role === "user" ? C.blue+"33" : C.accent+"22",
              border: `1px solid ${m.role === "user" ? C.blue+"55" : C.accent+"44"}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: MONO, fontSize: 9, color: m.role === "user" ? C.blue : C.accent,
            }}>{m.role === "user" ? "YOU" : "AI"}</div>
            <div style={{
              maxWidth: "82%", padding: "10px 13px", borderRadius: 6,
              background: m.role === "user" ? C.blue+"14" : C.card,
              border: `1px solid ${m.role === "user" ? C.blue+"33" : C.border}`,
              fontFamily: SANS, fontSize: 12, color: C.text, lineHeight: 1.7,
              whiteSpace: "pre-wrap",
            }}>{m.text}</div>
          </div>
        ))}
        {loading && (
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{
              width: 28, height: 28, borderRadius: "50%", background: C.accent+"22",
              border: `1px solid ${C.accent}44`, display: "flex", alignItems: "center",
              justifyContent: "center", fontFamily: MONO, fontSize: 9, color: C.accent,
            }}>AI</div>
            <div style={{
              padding: "10px 13px", borderRadius: 6, background: C.card,
              border: `1px solid ${C.border}`, fontFamily: MONO, fontSize: 11, color: C.accent,
              animation: "pulse 1.2s infinite",
            }}>Analyzing positions…</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div style={{ padding: "10px 14px", borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {SUGGESTIONS.map(s => (
            <button key={s} onClick={() => send(s)} style={{
              fontFamily: SANS, fontSize: 11, padding: "4px 10px",
              background: C.surface, border: `1px solid ${C.border}`,
              color: C.mutedHi, borderRadius: 12, cursor: "pointer",
            }}>{s}</button>
          ))}
        </div>
      </div>
      <div style={{ padding: 14, display: "flex", gap: 10 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && send()}
          placeholder="Ask about your positions, risk, strategy…"
          style={{
            flex: 1, background: C.bg, border: `1px solid ${C.borderHi}`,
            color: C.text, fontFamily: SANS, fontSize: 13, padding: "10px 14px",
            borderRadius: 4, outline: "none",
          }}
        />
        <button onClick={() => send()} disabled={loading || !input.trim()} style={{
          padding: "10px 20px", background: C.accent+"22", border: `1px solid ${C.accent}`,
          color: C.accent, fontFamily: MONO, fontSize: 11, fontWeight: 700,
          letterSpacing: 1, borderRadius: 4, cursor: "pointer",
        }}>SEND</button>
      </div>
    </Card>
  )
}

// ─── TRADING PANEL ─────────────────────────────────────────────────────────────
function TradingPanel({ pool, network }: any) {
  const [side, setSide]     = useState("BUY")
  const [type, setType]     = useState("LIMIT")
  const [price, setPrice]   = useState(pool.price.toString())
  const [size, setSize]     = useState("")
  const [lev, setLev]       = useState(1)
  const [submitted, setSubmitted] = useState(false)
  const total   = parseFloat(size || "0") * parseFloat(price || "0")
  const liqPrice = side === "BUY"
    ? (parseFloat(price || "0") * (1 - 1 / lev)).toFixed(4)
    : (parseFloat(price || "0") * (1 + 1 / lev)).toFixed(4)

  function submit() {
    setSubmitted(true)
    setTimeout(() => setSubmitted(false), 3000)
  }

  return (
    <Card>
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
        <SectionHeader title="DEEPBOOK TRADING" sub={`${pool.base}/${pool.quote} · ${network.toUpperCase()} ${pool.live ? "· Live" : "· Demo"}`} />
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          {["BUY","SELL"].map(s => (
            <button key={s} onClick={() => setSide(s)} style={{
              flex: 1, padding: "9px",
              background: side === s ? (s==="BUY"?C.safe+"22":C.danger+"22") : "transparent",
              border: `1px solid ${side===s ? (s==="BUY"?C.safe:C.danger) : C.border}`,
              color: side===s ? (s==="BUY"?C.safe:C.danger) : C.muted,
              fontFamily: MONO, fontSize: 12, fontWeight: 700, cursor: "pointer",
              borderRadius: 3, letterSpacing: 2,
            }}>{s}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          {["LIMIT","MARKET"].map(t => (
            <Pill key={t} label={t} active={type===t} onClick={() => setType(t)} color={C.blue} />
          ))}
        </div>
        {[[pool.quote, price, setPrice, pool.quote],[pool.base, size, setSize, pool.base]].map(([label, val, setter, unit]: any) => (
          <div key={label} style={{ marginBottom: 12 }}>
            <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted, letterSpacing: 2, marginBottom: 6 }}>{label.toUpperCase()}</div>
            <div style={{ display: "flex", alignItems: "center", background: C.bg, border: `1px solid ${C.borderHi}`, borderRadius: 4, overflow: "hidden" }}>
              <input value={val} onChange={e => setter(e.target.value)} placeholder="0.00"
                style={{ flex: 1, background: "none", border: "none", color: C.text,
                  fontFamily: MONO, fontSize: 14, padding: "10px 12px", outline: "none" }} />
              <span style={{ fontFamily: MONO, fontSize: 11, color: C.muted, padding: "0 12px" }}>{unit}</span>
            </div>
          </div>
        ))}
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted, letterSpacing: 2 }}>LEVERAGE</span>
            <Glow color={lev > 3 ? C.danger : C.text} size={12} weight={700}>{lev}x</Glow>
          </div>
          <input type="range" min={1} max={10} value={lev} onChange={e => setLev(+e.target.value)}
            style={{ width: "100%", accentColor: lev > 3 ? C.danger : C.blue }} />
        </div>
        <div style={{
          background: C.bg, border: `1px solid ${C.border}`, borderRadius: 4,
          padding: "10px 12px", marginBottom: 14,
        }}>
          {[
            ["Total Value", total > 0 ? fmt.usd(total) : "—"],
            ["Liq. Price", size && price ? `$${liqPrice}` : "—"],
            ["Est. Fee (0.1%)", total > 0 ? fmt.usd(total*0.001) : "—"],
            ["Network", network === "testnet" ? "Sui Testnet" : "Sui Mainnet"],
          ].map(([k, v]: any) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
              <span style={{ fontFamily: SANS, fontSize: 11, color: C.muted }}>{k}</span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: C.text }}>{v}</span>
            </div>
          ))}
        </div>
        {submitted ? (
          <div style={{
            padding: "11px", background: C.safe+"11", border: `1px solid ${C.safe}44`,
            borderRadius: 4, fontFamily: MONO, fontSize: 12, color: C.safe, textAlign: "center", letterSpacing: 1,
          }}>✓ ORDER SUBMITTED TO DEEPBOOK</div>
        ) : (
          <button onClick={submit} style={{
            width: "100%", padding: "12px",
            background: side==="BUY" ? C.safe+"22" : C.danger+"22",
            border: `1px solid ${side==="BUY"?C.safe:C.danger}`,
            color: side==="BUY"?C.safe:C.danger,
            fontFamily: MONO, fontSize: 13, fontWeight: 700, letterSpacing: 2,
            borderRadius: 4,
            textShadow: `0 0 8px ${side==="BUY"?C.safe:C.danger}`,
          }}>{side} {pool.base} · {lev}x</button>
        )}
        <div style={{
          marginTop: 10, padding: "8px 10px", background: C.warn+"0a",
          border: `1px solid ${C.warn}22`, borderRadius: 3,
        }}>
          <span style={{ fontFamily: SANS, fontSize: 11, color: C.warn }}>
            {network === "mainnet"
              ? "⚠ Mainnet mode — real funds. Trade carefully."
              : "⚠ Testnet mode — no real funds at risk. Switch to Mainnet when ready."}
          </span>
        </div>
      </div>
    </Card>
  )
}

// ─── WALLET BAR ─────────────────────────────────────────────────────────────────
function WalletBar({ network, setNetwork }: any) {
  return (
    <div style={{
      borderBottom: `1px solid ${C.border}`,
      display: "flex", alignItems: "center", gap: 12,
      background: C.surface,
      padding: "10px 24px",
    }}>
      <div style={{ display: "flex", gap: 6 }}>
        {Object.keys(NET).map(n => (
          <button key={n} onClick={() => setNetwork(n)} style={{
            fontFamily: MONO, fontSize: 10, padding: "4px 10px", letterSpacing: 2,
            background: network === n ? NET[n as keyof typeof NET].color+"22" : "transparent",
            border: `1px solid ${network === n ? NET[n as keyof typeof NET].color : C.border}`,
            color: network === n ? NET[n as keyof typeof NET].color : C.muted,
            borderRadius: 3, cursor: "pointer",
          }}>{NET[n as keyof typeof NET].label}</button>
        ))}
      </div>
      <div style={{ flex: 1 }} />
      <DappConnectButton
        connectText="CONNECT WALLET"
        style={{
          fontFamily: MONO, fontSize: 11, padding: "7px 20px",
          background: C.accent+"22", border: `1px solid ${C.accent}`,
          color: C.accent, borderRadius: 3, cursor: "pointer",
          fontWeight: 700, letterSpacing: 1,
        } as any}
      />
    </div>
  )
}

// ─── LIVE POSITIONS HELPER ─────────────────────────────────────────────────────
// Convert Sui RPC coin balances into the Position shape the UI expects
type RpcPosition = {
  id: string
  protocol: string
  type: string
  asset: string
  size: number
  collateral: number
  leverage: number
  entryPrice: number | null
  liquidationPrice: number | null
  health: number
  pnl: number
  pnlPct: number
  pool: string
}

const SYMBOL_TO_CG: Record<string, string> = {
  SUI: "sui", ETH: "ethereum", BTC: "bitcoin", USDT: "tether", USDC: "usd-coin",
}

function coinToPosition(
  coinType: string,
  rawAmt: number,
  decimals: number,
  symbol: string,
  index: number,
  prices: Record<string, { usd: number; chg: number }> | null,
): RpcPosition {
  const amount = rawAmt / Math.pow(10, decimals)
  const cgId = SYMBOL_TO_CG[symbol]
  const refPrice = (cgId && prices?.[cgId]?.usd) ? prices[cgId].usd : 1

  return {
    id:         `onchain-${symbol}-${index}`,
    protocol:   "Sui On-Chain",
    type:       "SPOT",
    asset:      symbol,
    size:       Math.round(amount * refPrice),
    collateral: Math.round(amount * refPrice * 0.5),
    leverage:   1,
    entryPrice: refPrice,
    liquidationPrice: null,
    health:     100,
    pnl:        0,
    pnlPct:     0,
    pool:       `pool_${symbol.toLowerCase()}_usdc`,
  }
}

function isValidCoinType(ct: string): boolean {
  return ct.includes("::")
}

// ─── DYNAMIC RISK EVENTS ──────────────────────────────────────────────────────
function generateRiskEvents(positions: any[], isLive: boolean): any[] {
  if (!isLive) return MOCK_RISK_EVENTS
  const now = new Date()
  const timeStr = now.toTimeString().slice(0, 8)
  const totalValue = positions.reduce((s: number, p: any) => s + p.size, 0)
  const events: any[] = []

  for (const p of positions) {
    if (p.health < 60) {
      events.push({ time: timeStr, event: "Liquidation Warning", position: `${p.asset} ${p.type}`, severity: "HIGH", detail: `Health at ${p.health}% — approaching liquidation` })
    }
  }

  if (totalValue > 0) {
    const byAsset: Record<string, number> = {}
    for (const p of positions) byAsset[p.asset] = (byAsset[p.asset] ?? 0) + p.size
    for (const [asset, val] of Object.entries(byAsset)) {
      if (val / totalValue > 0.7) {
        events.push({ time: timeStr, event: "Correlated Exposure", position: "All Positions", severity: "MEDIUM", detail: `${Math.round(val / totalValue * 100)}% portfolio in ${asset}` })
      }
    }
    for (const p of positions) {
      if (p.size / totalValue > 0.5) {
        events.push({ time: timeStr, event: "Concentration Risk", position: `${p.asset} ${p.type}`, severity: "MEDIUM", detail: `${Math.round(p.size / totalValue * 100)}% of portfolio in one position` })
      }
    }
  }

  events.push({ time: timeStr, event: "Live Prices", position: "Market Data", severity: "LOW", detail: "CoinGecko feed active · 30s refresh" })
  return events
}

// ─── ROOT APP ──────────────────────────────────────────────────────────────────
export default function DeepSenseClientPage() {
  const [tab, setTab]               = useState("dashboard")
  const [network, setNetwork]       = useState("mainnet")
  // ── live wallet state ──
  const currentAccount       = useCurrentAccount()
  const suiClient            = useSuiClient()
  const walletAddr           = currentAccount?.address ?? null
  const isWalletConnected    = !!walletAddr
  // ── raw balances (re-fetched on wallet/network change) ──
  const [rawBalances, setRawBalances] = useState<Array<{coinType: string; rawAmt: number; symbol: string; decimals: number}>>([])
  const [isLoadingBalances, setIsLoadingBalances] = useState(false)

  // Fetch raw coin balances when wallet or network changes
  useEffect(() => {
    if (!walletAddr || !suiClient) { setRawBalances([]); return }
    setIsLoadingBalances(true)
    let cancelled = false
    ;(async () => {
      try {
        const balances = await suiClient.getAllBalances({ owner: walletAddr })
        if (cancelled) return
        const fetched: Array<{coinType: string; rawAmt: number; symbol: string; decimals: number}> = []
        for (let i = 0; i < balances.length; i++) {
          const entry = balances[i]
          const coinType = typeof entry.coinType === "string" ? entry.coinType : ""
          if (!isValidCoinType(coinType)) continue
          const rawAmt = Number(BigInt(entry.totalBalance))
          const symbol = coinSymbol(coinType)
          const decimals = COIN_DEFS[coinType]?.decimals ?? 9
          fetched.push({ coinType, rawAmt, symbol, decimals })
        }
        if (!cancelled) setRawBalances(fetched)
      } catch {
        console.warn("getAllBalances failed — staying on mock data for this session")
      } finally {
        if (!cancelled) setIsLoadingBalances(false)
      }
    })()
    return () => { cancelled = true }
  }, [walletAddr, suiClient, network])

  // ── computed props passed to child components ──
  const { pools, prices }  = useCoinGeckoPrices()
  // Derive positions from raw balances + live prices — re-prices automatically on each CoinGecko refresh
  const livePositions: RpcPosition[] = rawBalances
    .map((b, i) => coinToPosition(b.coinType, b.rawAmt, b.decimals, b.symbol, i, prices))
    .sort((a, b) => b.size - a.size)
  const isPositionsLive    = isWalletConnected && livePositions.length > 0
  const positions          = isPositionsLive ? livePositions : MOCK_POSITIONS
  const riskEvents         = generateRiskEvents(positions, isPositionsLive)

  const [selectedPos, setSelectedPos] = useState<any>(null)
  const [selectedPool, setSelectedPool] = useState(MOCK_POOLS[0])
  const [ groqKey, setApiKeyInput]     = useState("")
  const [showKey, setShowKey]        = useState(false)

  // Load persisted key on mount; keep window global in sync
  useEffect(() => {
    const saved = sessionStorage.getItem("ds_groq_key") || ""
    if (saved && !groqKey) setApiKeyInput(saved)
    ;(window as any).__GROQ_KEY__ = groqKey || saved
  }, [groqKey])

  const net = NET[network as keyof typeof NET]

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&family=IBM+Plex+Sans:wght@400;600;700&display=swap');
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: ${C.bg}; }
        ::-webkit-scrollbar-thumb { background: ${C.borderHi}; border-radius: 2px; }
        input[type=range] { appearance: none; height: 3px; border-radius: 2px; background: ${C.border}; outline: none; }
        input[type=range]::-webkit-slider-thumb { appearance: none; width: 14px; height: 14px; border-radius: 50%; cursor: pointer; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        button:hover { opacity: 0.85; }
      `}</style>

      {/* Header */}
      <div style={{
        borderBottom: `1px solid ${C.border}`, padding: "0 24px",
        background: C.surface, display: "flex", alignItems: "center", gap: 0,
      }}>
        <div style={{
          padding: "14px 0", marginRight: 32, borderRight: `1px solid ${C.border}`,
          paddingRight: 24,
        }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
            <Glow size={18} weight={800} style={{ letterSpacing: 4 }}>DEEP</Glow>
            <Glow size={18} weight={800} color={C.gold} style={{ letterSpacing: 4 }}>SENSE</Glow>
          </div>
          <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 3, marginTop: 2 }}>
            AI · SUI · DEEPBOOK
          </div>
        </div>
        <div style={{ display: "flex", gap: 0, flex: 1 }}>
          {[
            { id: "dashboard",    label: "DASHBOARD"   },
            { id: "positions",   label: "POSITIONS"   },
            { id: "deepbook",    label: "DEEPBOOK"    },
            { id: "advisor",     label: "AI ADVISOR"  },
            { id: "simulator",   label: "SIMULATOR"   },
            { id: "architecture",label: "ARCHITECTURE"},
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              fontFamily: MONO, fontSize: 11, padding: "20px 18px",
              background: "none", border: "none",
              borderBottom: tab === t.id ? `2px solid ${C.accent}` : "2px solid transparent",
              color: tab === t.id ? C.accent : C.muted, cursor: "pointer",
              letterSpacing: 2, transition: "all 0.2s",
              textShadow: tab === t.id ? `0 0 8px ${C.accent}` : "none",
            }}>{t.label}</button>
          ))}
        </div>
        <NetBadge phase={network} />
      </div>

      {/* Wallet Bar */}
      <WalletBar network={network} setNetwork={setNetwork} />

      {/* Ticker */}
      <LiveTicker pools={pools} />

      {/* ─── API KEY BAR ──────────────────────────────────────────────────────── */}
      <div style={{
        padding: "8px 24px", background: C.surface, borderBottom: `1px solid ${C.border}`,
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
      }}>
        <span style={{ fontFamily: MONO, fontSize: 9, color: C.gold, letterSpacing: 2 }}>◈ GROQ API KEY</span>
        <span style={{ fontFamily: SANS, fontSize: 11, color: C.muted }}>
          Required for AI Advisor &amp; Scenario Simulator. Key is stored in sessionStorage only, never sent to any server.
        </span>
        <div style={{ flex: 1 }} />
        {!showKey ? (
          <button onClick={() => setShowKey(true)} style={{
            fontFamily: MONO, fontSize: 9, padding: "3px 9px",
            background: C.gold+"22", border: `1px solid ${C.gold}44`, color: C.gold,
            borderRadius: 2, cursor: "pointer", letterSpacing: 1,
          }}>SET KEY</button>
        ) : (
          <input
            type="password" value={ groqKey} onChange={e => setApiKeyInput(e.target.value)}
            onBlur={() => { sessionStorage.setItem("ds_groq_key", groqKey); (window as any).__GROQ_KEY__ = groqKey; setShowKey(false) }}
            placeholder="gsk_…"
            autoFocus
            style={{
              width: 280, background: C.bg, border: `1px solid ${C.borderHi}`,
              color: C.text, fontFamily: MONO, fontSize: 11, padding: "5px 10px",
              borderRadius: 3, outline: "none",
            }}
          />
        )}
      </div>

      {/* ─── MAIN CONTENT ─────────────────────────────────────────────────────── */}
      <div style={{ padding: "20px 24px" }} key={tab}>

        {/* DASHBOARD TAB */}
        {tab === "dashboard" && (
          <>
            <PortfolioOverview positions={positions} network={network} isLive={isPositionsLive} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <PositionTable positions={positions} onSelect={setSelectedPos} selected={selectedPos} isLive={isPositionsLive} />
                <RiskFeed events={riskEvents} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <DeepBookPanel pools={pools} selectedPool={selectedPool} />
                {!isWalletConnected && (
                  <Card style={{ padding: 20, textAlign: "center", border: `1px solid ${C.accent}33` }}>
                    <Glow size={13} style={{ display: "block", marginBottom: 8 }}>CONNECT YOUR WALLET</Glow>
                    <div style={{ fontFamily: SANS, fontSize: 12, color: C.mutedHi, marginBottom: 14 }}>
                      Connect a Sui wallet to load your real positions and get personalized risk analysis.
                    </div>
                    <DappConnectButton
                      connectText="CONNECT WALLET"
                      style={{
                        fontFamily: MONO, fontSize: 11, padding: "9px 24px",
                        background: C.accent+"22", border: `1px solid ${C.accent}`,
                        color: C.accent, borderRadius: 3, cursor: "pointer", letterSpacing: 1,
                      } as any}
                    />
                  </Card>
                )}
                {isWalletConnected && livePositions.length === 0 && !isLoadingBalances && (
                  <Card style={{ padding: 20, textAlign: "center", border: `1px solid ${C.safe}33` }}>
                    <Glow size={13} color={C.safe} style={{ display: "block", marginBottom: 8 }}>WALLET CONNECTED · MAINNET ✓</Glow>
                    <div style={{ fontFamily: SANS, fontSize: 12, color: C.text, marginBottom: 4 }}>
                      Address: <span style={{ fontFamily: MONO, color: C.accent }}>{fmt.addr(walletAddr)}</span>
                    </div>
                    <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted }}>
                      {livePositions.length === 0 && "No SUI coin balances found on this address."}
                    </div>
                  </Card>
                )}
                {isLoadingBalances && (
                  <Card style={{ padding: 20, textAlign: "center", border: `1px solid ${C.borderHi}` }}>
                    <div style={{ fontFamily: MONO, fontSize: 13, color: C.accent, animation: "pulse 1.2s infinite" }}>
                      FETCHING ON-CHAIN BALANCES…
                    </div>
                  </Card>
                )}
              </div>
            </div>
          </>
        )}

        {/* POSITIONS TAB */}
        {tab === "positions" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 400px", gap: 14 }}>
            <div>
              <PortfolioOverview positions={positions} network={network} isLive={isPositionsLive} />
              <PositionTable positions={positions} onSelect={setSelectedPos} selected={selectedPos} isLive={isPositionsLive} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <AIAdvisor positions={positions} pools={pools}  groqKey={groqKey} />
              <RiskFeed events={riskEvents} />
              <Card style={{ padding: 16 }}>
                <SectionHeader title="POSITION HEALTH" />
                {positions.map(p => (
                  <div key={p.id} style={{ marginBottom: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontFamily: SANS, fontSize: 12, color: C.text }}>{p.asset}</span>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <Tag color={p.type === "SHORT" ? C.danger : p.type === "LONG" ? C.safe : p.type === "LP" ? C.gold : C.blue}>{p.type}</Tag>
                        <Glow color={healthColor(p.health)} size={12}>{p.health}%</Glow>
                      </div>
                    </div>
                    <HealthBar value={p.health} />
                  </div>
                ))}
              </Card>
            </div>
          </div>
        )}

        {/* DEEPBOOK TAB */}
        {tab === "deepbook" && (
          <div>
            <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
              {pools.map(p => (
                <Pill key={p.id} label={`${p.base}/${p.quote}`}
                  active={selectedPool.id === p.id}
                  onClick={() => setSelectedPool(p)} color={C.gold} />
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <DeepBookPanel pools={pools} selectedPool={selectedPool} />
                <Card style={{ padding: 16 }}>
                  <SectionHeader title="POOL STATISTICS" sub={`${selectedPool.base}/${selectedPool.quote} · DeepBook CLOB`} />
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
                    {[
                      ["24H VOLUME",   fmt.usd(selectedPool.volume)],
                      ["LIQUIDITY",    fmt.usd(selectedPool.liquidity)],
                      ["BID/ASK SPREAD", `${selectedPool.spread}%`],
                      ["MID PRICE",    `$${fmt.usd(selectedPool.price)}`],
                      ["24H CHANGE",   fmt.pct(selectedPool.change)],
                      ["DEPTH RATIO",  "1.24x"],
                    ].map(([k, v]: any) => (
                      <div key={k} style={{ padding: "12px 14px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 4 }}>
                        <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 2, marginBottom: 6 }}>{k}</div>
                        <Glow size={14} color={String(v).startsWith("-") ? C.danger : String(v).startsWith("+") ? C.safe : C.text}>{v as string}</Glow>
                      </div>
                    ))}
                  </div>
                </Card>
              </div>
              <TradingPanel pool={selectedPool} network={network} />
            </div>
          </div>
        )}

        {/* AI ADVISOR TAB */}
        {tab === "advisor" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 14 }}>
            <AIAdvisor positions={positions} pools={pools}  groqKey={groqKey} />
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <RiskFeed events={riskEvents} />
              <Card style={{ padding: 16 }}>
                <SectionHeader title="POSITION HEALTH" />
                {positions.map(p => (
                  <div key={p.id} style={{ marginBottom: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontFamily: SANS, fontSize: 12, color: C.text }}>{p.asset}</span>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <Tag color={p.type === "SHORT" ? C.danger : p.type === "LONG" ? C.safe : p.type === "LP" ? C.gold : C.blue}>{p.type}</Tag>
                        <Glow color={healthColor(p.health)} size={12}>{p.health}%</Glow>
                      </div>
                    </div>
                    <HealthBar value={p.health} />
                  </div>
                ))}
              </Card>
            </div>
          </div>
        )}

        {/* SIMULATOR TAB */}
        {tab === "simulator" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <ScenarioSimulator positions={positions} />
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <PortfolioOverview positions={positions} network={network} isLive={isPositionsLive} />
              <Card style={{ padding: 16 }}>
                <SectionHeader title="POSITION HEALTH" />
                {positions.map(p => (
                  <div key={p.id} style={{ marginBottom: 14 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontFamily: SANS, fontSize: 12, color: C.text }}>{p.asset}</span>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <Tag color={p.type === "SHORT" ? C.danger : p.type === "LONG" ? C.safe : p.type === "LP" ? C.gold : C.blue}>{p.type}</Tag>
                        <Glow color={healthColor(p.health)} size={12}>{p.health}%</Glow>
                      </div>
                    </div>
                    <HealthBar value={p.health} />
                  </div>
                ))}
              </Card>
            </div>
          </div>
        )}

        {/* ARCHITECTURE TAB */}
        {tab === "architecture" && (
          <Card>
            <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
              <SectionHeader title="TECH ARCHITECTURE" sub="Sui + DeepBook integration stack" />
            </div>
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                { label: "FRONTEND LAYER",            color: C.accent,   items: ["React 19 + Next.js 16", `Sui Wallet Kit v1.0.5`, `@tanstack/react-query for data`, "AI Chat Interface", isWalletConnected ? `● Live wallet: ${fmt.addr(walletAddr)}` : "○ Viewing mock data"] },
                { label: "SUI INTEGRATION LAYER",    color: C.blue,     items: [`${network.toUpperCase()} · Sui JSON-RPC`, "Move smart contracts", "Pyth Network oracle", "Sui object model"] },
                { label: "DEEPBOOK LAYER",           color: C.gold,     items: ["CLOB orderbook queries", "Limit/Market orders", "Pool liquidity monitoring", "Trade fee (0.1%)"] },
                { label: "AI INTELLIGENCE LAYER",    color: C.accentDim, items: ["Llama 3.3 70B via Groq", "Portfolio stress testing", "Natural language advisor", "Anomaly detection signals"] },
                { label: "DEPLOYMENT",               color: C.safe,     items: ["Vercel (this demo)", isWalletConnected ? "○ Testnet with live RPC" : "○ Testnet demo · No wallet", "DAO governance (Phase 4)"] },
              ].map(({ label, color, items }: any) => (
                <div key={label} style={{
                  border: `1px solid ${color}33`, borderRadius: 4,
                  borderLeft: `3px solid ${color}`, padding: "12px 14px",
                  background: color+"07",
                }}>
                  <div style={{ fontFamily: MONO, fontSize: 9, color, letterSpacing: 3, marginBottom: 8 }}>{label}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
                    {items.map((item: string) => (
                      <div key={item} style={{
                        fontFamily: SANS, fontSize: 11, color: C.mutedHi,
                        display: "flex", alignItems: "center", gap: 6,
                      }}>
                        <span style={{ color, fontSize: 8 }}>◆</span> {item}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>

      {/* Footer */}
      <footer style={{
        padding: "14px 24px", marginTop: 32,
        borderTop: `1px solid ${C.border}`, background: C.surface,
        display: "flex", justifyContent: "space-between", alignItems: "center",
        fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 1,
      }}>
        <span>© 2026 DeepSense — Hackathon Demo · Sui {network.toUpperCase()}</span>
        <span>Built with React 19 · Next.js 16 · @mysten/dapp-kit · Groq API</span>
      </footer>
    </div>
  )
}
