"use client"

import { useState, useEffect, useRef } from "react"
import { SuiClientProvider, WalletProvider, ConnectButton as DappConnectButton } from "@mysten/dapp-kit"
import { useCurrentAccount, useSuiClient, useSignAndExecuteTransaction } from "@mysten/dapp-kit"
import { Transaction } from "@mysten/sui/transactions"
import { useRiskGuardian } from "@/app/hooks/useRiskGuardian"
import { useRiskEngine } from "@/app/hooks/useRiskEngine"
import { usePythPrices } from "@/app/hooks/usePythPrices"
import { useProtocolPositions, type ProtocolPosition } from "@/app/hooks/useProtocolPositions"
import { RISK_GUARDIAN } from "@/app/config/contracts"

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

// ─── POOL TEMPLATES ────────────────────────────────────────────────────────────
// Prices come from CoinGecko/Pyth. Volume & liquidity require DeepBook API — not available yet.
const POOL_TEMPLATES: { id: string; base: string; quote: string; spread: number }[] = [
  { id: "pool_sui_usdc",  base: "SUI",  quote: "USDC", spread: 0.02  },
  { id: "pool_sui_eth",   base: "SUI",  quote: "ETH",  spread: 0.05  },
  { id: "pool_eth_usdc",  base: "ETH",  quote: "USDC", spread: 0.04  },
  { id: "pool_btc_usdc",  base: "BTC",  quote: "USDC", spread: 0.03  },
  { id: "pool_usdt_usdc", base: "USDT", quote: "USDC", spread: 0.001 },
]

// ─── LIVE PRICE HOOK ───────────────────────────────────────────────────────────
// Fetches SUI, ETH, BTC, USDT, USDC from CoinGecko every 30 s.

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
        const data = (await resp.json()) as any
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

  if (loading || !prices) return { pools: [], loading, prices: null }

  const derived: any[] = []
  if (prices.sui && prices["usd-coin"]) {
    derived.push({ id: "pool_sui_usdc", base: "SUI", quote: "USDC", price: prices.sui.usd, change: prices.sui.chg, spread: 0.02 })
  }
  if (prices.sui && prices.ethereum) {
    derived.push({ id: "pool_sui_eth", base: "SUI", quote: "ETH", price: prices.sui.usd / prices.ethereum.usd, change: prices.sui.chg - prices.ethereum.chg, spread: 0.05 })
  }
  if (prices.ethereum && prices["usd-coin"]) {
    derived.push({ id: "pool_eth_usdc", base: "ETH", quote: "USDC", price: prices.ethereum.usd, change: prices.ethereum.chg, spread: 0.04 })
  }
  if (prices.bitcoin && prices["usd-coin"]) {
    derived.push({ id: "pool_btc_usdc", base: "BTC", quote: "USDC", price: prices.bitcoin.usd, change: prices.bitcoin.chg, spread: 0.03 })
  }
  if (prices.tether && prices["usd-coin"]) {
    derived.push({ id: "pool_usdt_usdc", base: "USDT", quote: "USDC", price: prices.tether.usd / prices["usd-coin"].usd, change: prices.tether.chg - prices["usd-coin"].chg, spread: 0.001 })
  }

  return { pools: derived, loading, prices }
}

// Deterministic simulated orderbook — generated from mid-price for visualization only.
// Clearly labeled "Simulated" in the UI. Live DeepBook integration coming soon.
function simulatedBook(mid: number, levels = 5) {
  const step = mid * 0.0015
  const sizes = [12400, 8900, 15600, 5200, 7575]
  let bidRunning = 0, askRunning = 0
  const bids = Array.from({ length: levels }, (_, i) => {
    const size = sizes[i]
    bidRunning += size
    return { price: mid - (i + 1) * step, size, total: bidRunning }
  }).reverse()
  const asks = Array.from({ length: levels }, (_, i) => {
    const size = sizes[4 - i]
    askRunning += size
    return { price: mid + (i + 1) * step, size, total: askRunning }
  })
  return { bids, asks }
}

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
function PortfolioOverview({ positions, walletConnected }: any) {
  const hasPositions = walletConnected && positions.length > 0
  const totalValue = hasPositions ? positions.reduce((s: number, p: any) => s + p.size, 0) : 0
  const totalPnl   = hasPositions ? positions.reduce((s: number, p: any) => s + p.pnl,   0) : 0
  const avgHealth  = hasPositions ? Math.round(positions.reduce((s: number, p: any) => s + p.health, 0) / positions.length) : 0
  const atRisk     = hasPositions ? positions.filter((p: any) => p.health < 60).length : 0
  const stats = [
    {
      label: "PORTFOLIO VALUE",
      value: hasPositions ? fmt.usd(totalValue) : "$0.00",
      color: C.text,
      sub: hasPositions ? `${positions.length} positions` : "Connect wallet to load",
    },
    {
      label: "TOTAL PNL",
      value: hasPositions ? fmt.usd(Math.abs(totalPnl)) : "$0.00",
      color: hasPositions ? (totalPnl >= 0 ? C.safe : C.danger) : C.muted,
      sub: hasPositions ? (totalPnl >= 0 ? "▲ Profitable" : "▼ In loss") : "—",
    },
    {
      label: "AVG HEALTH",
      value: hasPositions ? `${avgHealth}%` : "—",
      color: hasPositions ? healthColor(avgHealth) : C.muted,
      sub: hasPositions ? "Across all positions" : "—",
    },
    {
      label: "AT RISK",
      value: hasPositions ? `${atRisk} pos` : "0 pos",
      color: hasPositions && atRisk > 0 ? C.danger : C.muted,
      sub: "Health < 60%",
    },
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
function PositionTable({ positions, onSelect, selected, walletConnected }: any) {
  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
        <SectionHeader title="OPEN POSITIONS" sub={
          walletConnected
            ? "Live on-chain data · Sui Mainnet"
            : "Connect wallet to view positions"
        } />
      </div>
      {!walletConnected ? (
        <div style={{ padding: 32, textAlign: "center" }}>
          <div style={{ fontFamily: MONO, fontSize: 13, color: C.muted, marginBottom: 8 }}>No wallet connected</div>
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.muted }}>Connect a Sui wallet to load your on-chain positions.</div>
        </div>
      ) : positions.length === 0 ? (
        <div style={{ padding: 32, textAlign: "center" }}>
          <div style={{ fontFamily: MONO, fontSize: 13, color: C.muted, marginBottom: 8 }}>No positions found</div>
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.muted }}>No coin balances detected on this address.</div>
        </div>
      ) : (
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
              {positions.map((p: any) => (
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
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ─── DEEPBOOK ORDERBOOK ─────────────────────────────────────────────────────────
function DeepBookPanel({ selectedPool }: any) {
  if (!selectedPool) {
    return (
      <Card>
        <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
          <SectionHeader title="DEEPBOOK ORDERBOOK" sub="Waiting for price data…" />
        </div>
        <div style={{ padding: 32, textAlign: "center", fontFamily: MONO, fontSize: 12, color: C.muted, animation: "pulse 1.2s infinite" }}>
          Loading live prices…
        </div>
      </Card>
    )
  }
  const { bids: BIDS, asks: ASKS } = simulatedBook(selectedPool.price)
  const maxBid = Math.max(...BIDS.map((b: any) => b.total))
  const maxAsk = Math.max(...ASKS.map((a: any) => a.total))
  const priceDecimals = selectedPool.price < 0.01 ? 6 : selectedPool.price < 1 ? 4 : selectedPool.price < 100 ? 3 : 2
  return (
    <Card>
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
        <SectionHeader
          title="DEEPBOOK ORDERBOOK"
          sub={`${selectedPool.base}/${selectedPool.quote} · CLOB · Simulated orderbook visualization`}
        />
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <div>
            <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 2 }}>SPREAD</div>
            <div style={{ fontFamily: MONO, fontSize: 12, color: C.text }}>{selectedPool.spread}%</div>
          </div>
          <div style={{
            fontFamily: SANS, fontSize: 10, color: C.muted, padding: "3px 8px",
            border: `1px solid ${C.border}`, borderRadius: 2, background: C.bg,
          }}>Live DeepBook API integration coming soon</div>
        </div>
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", marginBottom: 2 }}>
          {["PRICE","SIZE","TOTAL"].map((v, j) => (
            <div key={j} style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 2, textAlign: "right", paddingRight: 8 }}>{v}</div>
          ))}
        </div>
        {ASKS.slice().reverse().map((a: any, i: number) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", position: "relative", marginBottom: 2 }}>
            <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: `${(a.total / maxAsk) * 100}%`, background: C.danger+"12", borderRadius: 2 }} />
            {[a.price.toFixed(priceDecimals), fmt.num(a.size), fmt.num(a.total)].map((v: string | number, j: number) => (
              <div key={j} style={{ fontFamily: MONO, fontSize: 11, color: j === 0 ? C.danger : C.text, textAlign: "right", padding: "2px 8px", position: "relative", zIndex: 1 }}>{v}</div>
            ))}
          </div>
        ))}
        <div style={{
          borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`,
          padding: "6px 8px", margin: "4px 0", display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <Glow size={16} color={C.accent} weight={700}>{fmt.usd(selectedPool.price)}</Glow>
          <Tag color={selectedPool.change >= 0 ? C.safe : C.danger}>{selectedPool.change >= 0 ? "+" : ""}{selectedPool.change.toFixed(2)}%</Tag>
        </div>
        {BIDS.map((b: any, i: number) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", position: "relative", marginBottom: 2 }}>
            <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: `${(b.total / maxBid) * 100}%`, background: C.safe+"12", borderRadius: 2 }} />
            {[b.price.toFixed(priceDecimals), fmt.num(b.size), fmt.num(b.total)].map((v: string | number, j: number) => (
              <div key={j} style={{ fontFamily: MONO, fontSize: 11, color: j === 0 ? C.safe : C.text, textAlign: "right", padding: "2px 8px", position: "relative", zIndex: 1 }}>{v}</div>
            ))}
          </div>
        ))}
      </div>
    </Card>
  )
}

// ─── RISK FEED ─────────────────────────────────────────────────────────────────
function RiskFeed({ events, walletConnected }: { events: any[]; walletConnected: boolean }) {
  return (
    <Card>
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
        <SectionHeader title="RISK EVENT FEED" sub="AI-detected anomalies · Real-time" />
      </div>
      {!walletConnected ? (
        <div style={{ padding: "24px 16px", textAlign: "center" }}>
          <div style={{ fontFamily: MONO, fontSize: 12, color: C.muted, marginBottom: 4 }}>Connect wallet to activate risk monitoring</div>
          <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted }}>Position-level alerts appear here once your portfolio is loaded.</div>
        </div>
      ) : events.length === 0 ? (
        <div style={{ padding: "24px 16px", textAlign: "center" }}>
          <div style={{ fontFamily: MONO, fontSize: 12, color: C.safe }}>✓ No active risk alerts — portfolio healthy</div>
        </div>
      ) : (
        events.map((e: any, i: number) => (
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
        ))
      )}
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
      const groqKey =
        typeof window !== "undefined" && (window as any).__GROQ_KEY__
          ? (window as any).__GROQ_KEY__
          : ""

      const prompt = positions.length > 0
        ? `You are DeepSense, an AI risk advisor for Sui DeFi and DeepBook margin traders.

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
        : `You are DeepSense, an AI risk advisor for Sui DeFi. No portfolio is loaded (wallet not connected).

Scenario: The market drops ${drop}% across all assets in the next hour.

Analyze the general impact on Sui DeFi:
1. PROTOCOL RISK — which Sui lending protocols (Navi, Scallop) face the highest liquidation cascades
2. DEEPBOOK IMPACT — how a ${drop}% crash affects CLOB liquidity and spreads on DeepBook
3. STABLECOIN RISK — de-peg scenarios for USDT/USDC on Sui
4. RECOVERY STRATEGY — what positions a Sui DeFi trader should consider after a ${drop}% drop
5. RISK MANAGEMENT — 3 protective strategies for Sui DeFi participants

Be precise and educational. Format with clear headers.`

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

        {/* Quick-status cards — only for positions with a liquidation price */}
        {positions.filter((p: any) => p.liquidationPrice && p.entryPrice).length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, marginBottom: 14 }}>
            {positions.filter((p: any) => p.liquidationPrice && p.entryPrice).map((p: any) => {
              const crashPrice = (p.entryPrice as number) * (1 - drop / 100)
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
        )}

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
  const hasPositions = positions.length > 0
  const [messages, setMessages] = useState<{role:"assistant"|"user";text:string}[]>([
    { role: "assistant", text: hasPositions
        ? "Hello. I'm DeepSense — your AI risk advisor for Sui DeFi. I have visibility into your on-chain positions. Ask me anything about your portfolio, risk exposure, or market conditions."
        : "Hello. I'm DeepSense — your AI risk advisor for Sui DeFi. No wallet is connected yet, so I'll provide general DeFi and Sui risk advice. Connect your wallet for personalized portfolio analysis."
    }
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

    const hasPositions = positions.length > 0
    const context = `You are DeepSense, an elite AI DeFi risk advisor for the Sui blockchain and DeepBook CLOB.

${hasPositions
  ? `Current portfolio:\n${positions.map((p: any) =>
      `- ${p.type} ${p.asset} on ${p.protocol}: $${p.size} size, ${p.leverage}x leverage, Health ${p.health}%, PnL $${p.pnl} (${p.pnlPct}%), Liquidation: $${p.liquidationPrice ?? "none"}`
    ).join("\n")}`
  : "No wallet connected — user has not loaded a portfolio. Provide general Sui DeFi risk advice."
}

${pools.length > 0
  ? `DeepBook pools (live prices, simulated depth):\n${pools.map((p: any) =>
      `- ${p.base}/${p.quote}: ${fmt.usd(p.price)} (${fmt.pct(p.change)}), Spread ${p.spread}%`
    ).join("\n")}`
  : "Market price data loading."
}

Be conversational but precise. ${hasPositions ? "Use specific numbers from the portfolio." : "Answer general DeFi and Sui questions."} Keep responses under 200 words. Give actionable advice. You understand Sui's object model, Move contracts, and DeepBook's CLOB mechanics.`

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
      const reply: string = res.status === 401
        ? "API key not configured. Set GROQ_API_KEY in .env.local or provide a key via the session store."
        : (data.reply || "Unable to respond.")
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
        <SectionHeader title="DEEPBOOK TRADING" sub={`${pool.base}/${pool.quote} · ${network.toUpperCase()} · Simulated execution`} />
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
function generateRiskEvents(positions: any[]): any[] {
  if (positions.length === 0) return []
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

  events.push({ time: timeStr, event: "Live Prices", position: "Market Data", severity: "LOW", detail: "CoinGecko + Pyth feed active · 10–30s refresh" })
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
        console.log("[DeepSense] Raw balances from RPC:", JSON.stringify(balances, null, 2))
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
        console.log("[DeepSense] Processed positions:", fetched.length, fetched)
        if (!cancelled) setRawBalances(fetched)
      } catch (err) {
        console.log("[DeepSense] getAllBalances error:", err)
        console.warn("getAllBalances failed — staying on mock data for this session")
      } finally {
        if (!cancelled) setIsLoadingBalances(false)
      }
    })()
    return () => { cancelled = true }
  }, [walletAddr, suiClient, network])

  // ── computed props passed to child components ──
  const { pools, prices }  = useCoinGeckoPrices()
  const { pythPrices, loading: pythLoading } = usePythPrices()
  // Derive coin-balance positions from raw balances + live prices
  const positions: RpcPosition[] = rawBalances
    .map((b, i) => coinToPosition(b.coinType, b.rawAmt, b.decimals, b.symbol, i, prices))
    .sort((a, b) => b.size - a.size)

  // Protocol position aggregator — scans all owned objects for DeFi protocol objects
  const {
    positions: protocolPositions,
    loading: protocolLoading,
    error: protocolError,
    protocolCounts,
  } = useProtocolPositions(walletAddr, network)

  console.log("[DeepSense] Wallet status:", { isWalletConnected, walletAddr, livePositionsCount: positions.length, isLoadingBalances })
  const riskEvents = generateRiskEvents(positions)

  const [selectedPos, setSelectedPos] = useState<any>(null)
  const [selectedPool, setSelectedPool] = useState<any>(null)
  const [groqKey] = useState("")

  // ── Risk Guardian on-chain state ──
  const { policyState, events: guardianEvents, loading: guardianLoading, error: guardianError, refetch: refetchGuardian } = useRiskGuardian()
  const { riskAssessment, actionLog } = useRiskEngine({
    prices: prices ?? {},
    pythPrices,
    policyState,
    enabled: true,
    walletConnected: isWalletConnected,
  })
  const { mutate: signAndExecute } = useSignAndExecuteTransaction()
  const [txStatus, setTxStatus] = useState<string>("")

  function setTxMsg(msg: string) {
    setTxStatus(msg)
    setTimeout(() => setTxStatus(""), 5000)
  }

  function buildAdminTx(fn: string, includesClock: boolean): Transaction {
    const tx = new Transaction()
    const args = [tx.object(RISK_GUARDIAN.POLICY_ID), tx.object(RISK_GUARDIAN.ADMIN_CAP_ID)]
    if (includesClock) args.push(tx.object(RISK_GUARDIAN.CLOCK))
    tx.moveCall({ target: `${RISK_GUARDIAN.PACKAGE_ID}::${RISK_GUARDIAN.MODULE}::${fn}`, arguments: args })
    return tx
  }

  function handleAdminResume() {
    try {
      signAndExecute(
        { transaction: buildAdminTx("admin_resume", true) },
        {
          onSuccess: () => { setTxMsg("✓ Protocol resumed successfully"); setTimeout(refetchGuardian, 2000) },
          onError:   (e: any) => setTxMsg(`✗ ${e?.message ?? "Transaction failed"}`),
        },
      )
    } catch (e: any) { setTxMsg(`✗ ${e?.message ?? "Transaction failed"}`) }
  }

  function handleRevokeAgent() {
    try {
      signAndExecute(
        { transaction: buildAdminTx("revoke_agent", true) },
        {
          onSuccess: () => { setTxMsg("✓ Agent revoked successfully"); setTimeout(refetchGuardian, 2000) },
          onError:   (e: any) => setTxMsg(`✗ ${e?.message ?? "Transaction failed"}`),
        },
      )
    } catch (e: any) { setTxMsg(`✗ ${e?.message ?? "Transaction failed"}`) }
  }

  function handleResetBudget() {
    try {
      signAndExecute(
        { transaction: buildAdminTx("reset_agent_budget", false) },
        {
          onSuccess: () => { setTxMsg("✓ Budget reset successfully"); setTimeout(refetchGuardian, 2000) },
          onError:   (e: any) => setTxMsg(`✗ ${e?.message ?? "Transaction failed"}`),
        },
      )
    } catch (e: any) { setTxMsg(`✗ ${e?.message ?? "Transaction failed"}`) }
  }

  const [showParamsForm, setShowParamsForm] = useState(false)
  const [paramLeverage, setParamLeverage] = useState<string>("")
  const [paramLiqThreshold, setParamLiqThreshold] = useState<string>("")

  function handleAdjustParams() {
    const lev = parseInt(paramLeverage, 10)
    const liq = parseInt(paramLiqThreshold, 10)
    if (isNaN(lev) || isNaN(liq) || lev <= 0 || liq <= 0) {
      setTxMsg("✗ Enter valid positive integers for both fields")
      return
    }
    try {
      const tx = new Transaction()
      tx.moveCall({
        target: `${RISK_GUARDIAN.PACKAGE_ID}::${RISK_GUARDIAN.MODULE}::admin_adjust_parameters`,
        arguments: [
          tx.object(RISK_GUARDIAN.POLICY_ID),
          tx.pure.u64(lev),
          tx.pure.u64(liq),
          tx.object(RISK_GUARDIAN.ADMIN_CAP_ID),
          tx.object(RISK_GUARDIAN.CLOCK),
        ],
      })
      signAndExecute(
        { transaction: tx },
        {
          onSuccess: () => {
            setTxMsg(`✓ Parameters updated: leverage=${lev} liq_threshold=${liq}`)
            setShowParamsForm(false)
            setTimeout(refetchGuardian, 2000)
          },
          onError: (e: any) => setTxMsg(`✗ ${e?.message ?? "Transaction failed"}`),
        },
      )
    } catch (e: any) { setTxMsg(`✗ ${e?.message ?? "Transaction failed"}`) }
  }

  // Sync selectedPool when pools first become available
  useEffect(() => {
    if (pools.length > 0 && !selectedPool) setSelectedPool(pools[0])
  }, [pools, selectedPool])

  // Sync Groq key from sessionStorage into window global for legacy component refs
  useEffect(() => {
    const saved = sessionStorage.getItem("ds_groq_key") || ""
    ;(window as any).__GROQ_KEY__ = saved
  }, [])

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
            { id: "guardian",     label: "GUARDIAN"    },
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

      {/* API key bar hidden — key read from GROQ_API_KEY env var server-side */}

      {/* ─── MAIN CONTENT ─────────────────────────────────────────────────────── */}
      <div style={{ padding: "20px 24px" }} key={tab}>

        {/* DASHBOARD TAB */}
        {tab === "dashboard" && (
          <>
            {!isWalletConnected ? (
              /* ── Hero card when no wallet ── */
              <Card style={{
                padding: "48px 40px", marginBottom: 24, textAlign: "center",
                border: `1px solid ${C.accent}33`, background: C.accent+"04",
              }}>
                <div style={{ marginBottom: 16 }}>
                  <Glow size={28} weight={800} style={{ letterSpacing: 6, display: "block", marginBottom: 6 }}>DEEPSENSE</Glow>
                  <div style={{ fontFamily: SANS, fontSize: 15, color: C.mutedHi, maxWidth: 540, margin: "0 auto" }}>
                    AI-powered risk monitoring for Sui DeFi · Real-time oracle feeds · On-chain guardian contract
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16, maxWidth: 600, margin: "28px auto 32px" }}>
                  {[
                    { icon: "◈", title: "Live Oracle Prices", sub: "Pyth Network + CoinGecko" },
                    { icon: "⬡", title: "AI Risk Engine", sub: "Automated scoring & alerts" },
                    { icon: "⛓", title: "On-Chain Guardian", sub: "RiskGuardian Move contract" },
                  ].map(f => (
                    <div key={f.title} style={{ padding: "16px 12px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6 }}>
                      <div style={{ fontFamily: MONO, fontSize: 18, color: C.accent, marginBottom: 6 }}>{f.icon}</div>
                      <div style={{ fontFamily: MONO, fontSize: 10, color: C.text, letterSpacing: 2, marginBottom: 4 }}>{f.title}</div>
                      <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted }}>{f.sub}</div>
                    </div>
                  ))}
                </div>
                <DappConnectButton
                  connectText="CONNECT WALLET TO GET STARTED"
                  style={{
                    fontFamily: MONO, fontSize: 12, padding: "12px 32px",
                    background: C.accent+"22", border: `1px solid ${C.accent}`,
                    color: C.accent, borderRadius: 4, cursor: "pointer",
                    letterSpacing: 2, fontWeight: 700,
                    textShadow: `0 0 12px ${C.accent}88`,
                  } as any}
                />
                <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted, marginTop: 14 }}>
                  Supports Sui Wallet, Suiet, Martian and other dapp-kit compatible wallets
                </div>
              </Card>
            ) : (
              /* ── Portfolio view when wallet connected ── */
              <>
                <PortfolioOverview positions={positions} walletConnected={isWalletConnected} />
                {isLoadingBalances && (
                  <Card style={{ padding: 20, textAlign: "center", border: `1px solid ${C.borderHi}`, marginBottom: 14 }}>
                    <div style={{ fontFamily: MONO, fontSize: 13, color: C.accent, animation: "pulse 1.2s infinite" }}>
                      FETCHING ON-CHAIN BALANCES…
                    </div>
                  </Card>
                )}
                {!isLoadingBalances && positions.length === 0 && (
                  <Card style={{ padding: 20, textAlign: "center", border: `1px solid ${C.safe}33`, marginBottom: 14 }}>
                    <Glow size={13} color={C.safe} style={{ display: "block", marginBottom: 8 }}>WALLET CONNECTED ✓</Glow>
                    <div style={{ fontFamily: SANS, fontSize: 12, color: C.text, marginBottom: 4 }}>
                      Address: <span style={{ fontFamily: MONO, color: C.accent }}>{fmt.addr(walletAddr)}</span>
                    </div>
                    <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted }}>No coin balances found on this address.</div>
                  </Card>
                )}
              </>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <PositionTable positions={positions} onSelect={setSelectedPos} selected={selectedPos} walletConnected={isWalletConnected} />
                <RiskFeed events={riskEvents} walletConnected={isWalletConnected} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <DeepBookPanel selectedPool={selectedPool} />

                {/* PROTOCOL COVERAGE */}
                <Card>
                  <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <Glow size={11} style={{ letterSpacing: 3, display: "block", marginBottom: 3 }}>PROTOCOL COVERAGE</Glow>
                      <span style={{ fontFamily: SANS, fontSize: 12, color: C.mutedHi }}>Scanned {Object.keys(protocolCounts).length > 0 ? Object.keys(protocolCounts).length : "8"} protocols · Mainnet</span>
                    </div>
                    {protocolLoading && (
                      <span style={{ fontFamily: MONO, fontSize: 9, color: C.accent, animation: "pulse 1.2s infinite" }}>SCANNING…</span>
                    )}
                  </div>
                  <div>
                    {([
                      ["Navi Protocol",    C.safe],
                      ["Scallop",          "#8b5cf6"],
                      ["Cetus",            C.blue],
                      ["Aftermath Finance",C.danger],
                      ["Bluefin",          C.accent],
                      ["SuiLend",          C.warn],
                      ["DeepBook",         C.gold],
                      ["Ember",            "#ec4899"],
                    ] as [string, string][]).map(([proto, protoColor], i, arr) => {
                      const count = protocolCounts[proto] ?? 0
                      return (
                        <div key={proto} style={{
                          padding: "10px 16px",
                          borderBottom: i < arr.length - 1 ? `1px solid ${C.border}` : "none",
                          display: "flex", justifyContent: "space-between", alignItems: "center",
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ width: 6, height: 6, borderRadius: "50%", background: count > 0 ? protoColor : C.muted, opacity: count > 0 ? 1 : 0.4 }} />
                            <span style={{ fontFamily: SANS, fontSize: 12, color: count > 0 ? C.text : C.muted }}>{proto}</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            {count > 0 ? (
                              <Tag color={protoColor}>{count} position{count !== 1 ? "s" : ""}</Tag>
                            ) : (
                              <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>
                                {!isWalletConnected ? "—" : protocolLoading ? "…" : "0"}
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                    {protocolError && (
                      <div style={{ padding: "8px 16px", fontFamily: SANS, fontSize: 11, color: C.danger }}>
                        Scan error: {protocolError}
                      </div>
                    )}
                  </div>
                </Card>
              </div>
            </div>
          </>
        )}

        {/* GUARDIAN TAB */}
        {tab === "guardian" && (() => {
          function riskScoreColor(s: number) { return s <= 40 ? C.safe : s <= 70 ? C.warn : C.danger }
          function shortEventType(full: string) { return full.split("::").pop() ?? full }
          function fmtTs(ms: string | null | undefined) {
            if (!ms) return "—"
            return new Date(Number(ms)).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })
          }
          function eventSummary(type: string, json: unknown): string {
            if (!json || typeof json !== "object") return ""
            const j = json as Record<string, unknown>
            const name = shortEventType(type)
            if (name === "RiskScoreUpdated") return `score ${j.old_score} → ${j.new_score}`
            if (name === "ProtocolPaused")   return `risk score at ${j.risk_score}`
            if (name === "ProtocolResumed")  return `resumed by ${String(j.resumed_by ?? "").slice(0,10)}…`
            if (name === "ParametersAdjusted") return `leverage ${j.old_max_leverage}→${j.new_max_leverage} · liq ${j.old_liquidation_threshold}→${j.new_liquidation_threshold}`
            if (name === "AgentRevoked")     return `agent ${String(j.revoked_agent ?? "").slice(0,10)}…`
            if (name === "AgentUpdated")     return `${String(j.old_agent ?? "").slice(0,10)}… → ${String(j.new_agent ?? "").slice(0,10)}…`
            if (name === "AdminOverride") {
              const raw = j.action
              const decoded = Array.isArray(raw)
                ? String.fromCharCode(...(raw as number[]))
                : String(raw ?? "")
              return `action: ${decoded}`
            }
            if (name === "PolicyCreated")    return `leverage ${j.max_leverage}bp · liq ${j.liquidation_threshold}bp`
            return ""
          }

          if (guardianLoading) return (
            <Card style={{ padding: 40, textAlign: "center" }}>
              <div style={{ fontFamily: MONO, fontSize: 14, color: C.accent, animation: "pulse 1.2s infinite" }}>
                READING ON-CHAIN STATE…
              </div>
              <div style={{ fontFamily: SANS, fontSize: 12, color: C.muted, marginTop: 10 }}>
                Querying Sui Testnet · RiskGuardian contract
              </div>
            </Card>
          )

          if (guardianError) return (
            <Card style={{ padding: 24, border: `1px solid ${C.danger}44` }}>
              <Glow color={C.danger} size={12} style={{ display: "block", marginBottom: 8 }}>CONTRACT READ ERROR</Glow>
              <div style={{ fontFamily: MONO, fontSize: 11, color: C.mutedHi }}>{guardianError}</div>
            </Card>
          )

          if (!policyState) return (
            <Card style={{ padding: 32, textAlign: "center" }}>
              <Glow size={13} color={C.muted} style={{ display: "block", marginBottom: 8 }}>NO RISK POLICY FOUND</Glow>
              <div style={{ fontFamily: SANS, fontSize: 12, color: C.muted }}>Deploy the contract first: <code>sui client publish</code></div>
            </Card>
          )

          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

              {/* Testnet badge */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <div style={{
                    display: "flex", alignItems: "center", gap: 6, padding: "4px 12px",
                    border: `1px solid ${C.warn}44`, borderRadius: 3, background: C.warn+"11",
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.warn, boxShadow: `0 0 8px ${C.warn}`, display: "inline-block" }} />
                    <span style={{ fontFamily: MONO, fontSize: 10, color: C.warn, letterSpacing: 2 }}>TESTNET · RISK GUARDIAN</span>
                  </div>
                  <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>Live on-chain · auto-refresh 10s</span>
                </div>
                <button onClick={refetchGuardian} style={{
                  fontFamily: MONO, fontSize: 10, padding: "4px 12px",
                  background: C.accent+"11", border: `1px solid ${C.accent}44`,
                  color: C.accent, borderRadius: 2, cursor: "pointer", letterSpacing: 1,
                }}>↺ REFRESH</button>
              </div>

              {/* AI RISK ENGINE panel */}
              <Card style={{ border: `1px solid ${C.accent}33`, background: C.accent+"05" }}>
                <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: "50%", background: C.safe,
                      boxShadow: `0 0 10px ${C.safe}`, display: "inline-block",
                      animation: "pulse 2s infinite",
                    }} />
                    <Glow size={11} style={{ letterSpacing: 3 }}>AI RISK ENGINE</Glow>
                  </div>
                  <span style={{ fontFamily: SANS, fontSize: 11, color: C.mutedHi }}>Autonomous risk monitoring · CoinGecko feed · 30s refresh</span>
                </div>

                <div style={{ padding: 16 }}>
                  {!riskAssessment ? (
                    <div style={{ fontFamily: MONO, fontSize: 12, color: C.muted, animation: "pulse 1.2s infinite" }}>
                      Waiting for price data…
                    </div>
                  ) : (
                    <>
                      {/* Score + level */}
                      <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 16 }}>
                        <div>
                          <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 3, marginBottom: 6 }}>AI-CALCULATED SCORE</div>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                            <Glow color={riskScoreColor(riskAssessment.score)} size={48} weight={700}>{riskAssessment.score}</Glow>
                            <span style={{ fontFamily: MONO, fontSize: 16, color: C.muted }}>/100</span>
                          </div>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {/* Level badge */}
                          <div style={{
                            padding: "6px 16px", borderRadius: 3, fontFamily: MONO, fontSize: 13, fontWeight: 700,
                            letterSpacing: 2,
                            background: (
                              riskAssessment.level === "CRITICAL" ? C.danger+"22" :
                              riskAssessment.level === "HIGH"     ? C.warn+"22"   :
                              riskAssessment.level === "MEDIUM"   ? C.gold+"22"   : C.safe+"22"
                            ),
                            border: `1px solid ${
                              riskAssessment.level === "CRITICAL" ? C.danger+"66" :
                              riskAssessment.level === "HIGH"     ? C.warn+"66"   :
                              riskAssessment.level === "MEDIUM"   ? C.gold+"66"   : C.safe+"66"
                            }`,
                            color: (
                              riskAssessment.level === "CRITICAL" ? C.danger :
                              riskAssessment.level === "HIGH"     ? C.warn   :
                              riskAssessment.level === "MEDIUM"   ? C.gold   : C.safe
                            ),
                            animation: riskAssessment.level === "CRITICAL" ? "pulse 1s infinite" : "none",
                            textShadow: `0 0 10px ${
                              riskAssessment.level === "CRITICAL" ? C.danger :
                              riskAssessment.level === "HIGH"     ? C.warn   :
                              riskAssessment.level === "MEDIUM"   ? C.gold   : C.safe
                            }88`,
                          }}>{riskAssessment.level}</div>
                          <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 1 }}>
                            updated {new Date(riskAssessment.timestamp).toLocaleTimeString()}
                          </div>
                        </div>

                        {/* Findings */}
                        <div style={{ flex: 1, borderLeft: `1px solid ${C.border}`, paddingLeft: 20 }}>
                          <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 3, marginBottom: 8 }}>FINDINGS</div>
                          {riskAssessment.reasons.length === 0 ? (
                            <div style={{ fontFamily: SANS, fontSize: 12, color: C.safe }}>✓ No elevated risk factors detected</div>
                          ) : (
                            riskAssessment.reasons.map((r, i) => (
                              <div key={i} style={{ fontFamily: SANS, fontSize: 12, color: C.warn, marginBottom: 5, display: "flex", gap: 6 }}>
                                <span>⚠</span><span>{r}</span>
                              </div>
                            ))
                          )}
                        </div>
                      </div>

                      {/* vs On-Chain comparison */}
                      {policyState && (
                        <div style={{
                          padding: "10px 14px", borderRadius: 4,
                          background: C.bg, border: `1px solid ${C.border}`,
                          display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
                        }}>
                          <div>
                            <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 2, marginBottom: 3 }}>AI SCORE</div>
                            <Glow color={riskScoreColor(riskAssessment.score)} size={18} weight={700}>{riskAssessment.score}</Glow>
                          </div>
                          <div style={{ fontFamily: MONO, fontSize: 14, color: C.border }}>vs</div>
                          <div>
                            <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 2, marginBottom: 3 }}>ON-CHAIN SCORE</div>
                            <Glow color={riskScoreColor(policyState.risk_score)} size={18} weight={700}>{policyState.risk_score}</Glow>
                          </div>
                          {Math.abs(riskAssessment.score - policyState.risk_score) > 10 && (
                            <div style={{
                              marginLeft: "auto", padding: "6px 12px", borderRadius: 3,
                              background: C.gold+"18", border: `1px solid ${C.gold}44`,
                              fontFamily: MONO, fontSize: 10, color: C.gold, letterSpacing: 1,
                            }}>⚠ Score drift detected — sync recommended</div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </Card>

              {/* ORACLE FEEDS */}
              <Card style={{ border: `1px solid ${C.border}` }}>
                <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <Glow size={11} style={{ letterSpacing: 3, display: "block", marginBottom: 3 }}>ORACLE FEEDS</Glow>
                    <span style={{ fontFamily: SANS, fontSize: 12, color: C.mutedHi }}>Pyth Network · 10s refresh · real-time confidence bands</span>
                  </div>
                  <Tag color={pythLoading ? C.muted : C.safe}>{pythLoading ? "FETCHING" : "LIVE"}</Tag>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 0 }}>
                  {[
                    { label: "SUI/USD",  key: "sui" },
                    { label: "ETH/USD",  key: "ethereum" },
                    { label: "BTC/USD",  key: "bitcoin" },
                    { label: "USDT/USD", key: "tether" },
                    { label: "USDC/USD", key: "usd-coin" },
                  ].map(({ label, key }, i) => {
                    const p = pythPrices?.[key]
                    const cgP = prices?.[key]
                    const conf = p?.conf ?? 0
                    const usd = p?.usd ?? cgP?.usd ?? null
                    const pct = usd && usd > 0 ? (conf / usd) * 100 : null
                    return (
                      <div key={key} style={{
                        padding: "14px 16px",
                        borderRight: i < 4 ? `1px solid ${C.border}` : "none",
                      }}>
                        <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 2, marginBottom: 8 }}>{label}</div>
                        {usd === null ? (
                          <div style={{ fontFamily: MONO, fontSize: 11, color: C.muted, animation: "pulse 1.2s infinite" }}>—</div>
                        ) : (
                          <>
                            <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4 }}>
                              ${usd < 0.01 ? usd.toFixed(6) : usd < 1 ? usd.toFixed(4) : usd < 10 ? usd.toFixed(3) : usd.toFixed(2)}
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <Tag color={p ? C.accent : C.muted}>{p ? "Pyth" : "CG"}</Tag>
                              {pct !== null && (
                                <span style={{ fontFamily: MONO, fontSize: 9, color: C.muted }}>±{pct.toFixed(3)}%</span>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
              </Card>

              {/* PENDING ACTIONS */}
              {actionLog.length > 0 && (
                <Card style={{ border: `1px solid ${C.gold}33` }}>
                  <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <Glow size={11} color={C.gold} style={{ letterSpacing: 3, display: "block", marginBottom: 3 }}>PENDING AGENT ACTIONS</Glow>
                      <span style={{ fontFamily: SANS, fontSize: 12, color: C.mutedHi }}>AI recommendations awaiting on-chain sync</span>
                    </div>
                    <button
                      onClick={() => {
                        if (!riskAssessment) return
                        try {
                          const tx = new Transaction()
                          tx.moveCall({
                            target: `${RISK_GUARDIAN.PACKAGE_ID}::${RISK_GUARDIAN.MODULE}::update_risk_score`,
                            arguments: [
                              tx.object(RISK_GUARDIAN.POLICY_ID),
                              tx.pure.u64(riskAssessment.score),
                              tx.object(RISK_GUARDIAN.CLOCK),
                            ],
                          })
                          signAndExecute(
                            { transaction: tx },
                            {
                              onSuccess: () => { setTxMsg(`✓ Risk score synced to ${riskAssessment.score}`); setTimeout(refetchGuardian, 2000) },
                              onError:   (e: any) => setTxMsg(`✗ ${e?.message ?? "Sync failed"}`),
                            },
                          )
                        } catch (e: any) { setTxMsg(`✗ ${e?.message ?? "Sync failed"}`) }
                      }}
                      style={{
                        fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: 2,
                        padding: "8px 18px", borderRadius: 4, cursor: "pointer",
                        background: C.gold+"22", border: `1px solid ${C.gold}66`,
                        color: C.gold, textShadow: `0 0 8px ${C.gold}88`,
                      }}
                    >SYNC TO CHAIN →</button>
                  </div>
                  <div>
                    {actionLog.slice(0, 8).map((entry, i) => (
                      <div key={i} style={{
                        padding: "10px 16px",
                        borderBottom: i < Math.min(actionLog.length, 8) - 1 ? `1px solid ${C.border}` : "none",
                        display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
                      }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <div style={{ width: 3, height: 16, background: entry.action.includes("Pause") ? C.danger : C.gold, borderRadius: 2, flexShrink: 0 }} />
                          <span style={{ fontFamily: MONO, fontSize: 11, color: C.text }}>{entry.action}</span>
                        </div>
                        <div style={{ display: "flex", gap: 12, alignItems: "center", flexShrink: 0 }}>
                          <Tag color={riskScoreColor(entry.score)}>{entry.score}/100</Tag>
                          <span style={{ fontFamily: MONO, fontSize: 9, color: C.muted }}>
                            {new Date(entry.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Section A — Status Cards */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10 }}>
                {/* Risk Score */}
                <Card style={{ padding: "16px 18px" }}>
                  <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 3, marginBottom: 8 }}>RISK SCORE</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
                    <Glow color={riskScoreColor(policyState.risk_score)} size={32} weight={700}>{policyState.risk_score}</Glow>
                    <span style={{ fontFamily: MONO, fontSize: 14, color: C.muted }}>/100</span>
                  </div>
                  <div style={{ marginTop: 8, height: 4, background: C.border, borderRadius: 2, overflow: "hidden" }}>
                    <div style={{
                      height: "100%", width: `${policyState.risk_score}%`,
                      background: riskScoreColor(policyState.risk_score),
                      boxShadow: `0 0 8px ${riskScoreColor(policyState.risk_score)}`,
                      transition: "width 0.6s ease", borderRadius: 2,
                    }} />
                  </div>
                  <div style={{ fontFamily: SANS, fontSize: 11, color: C.mutedHi, marginTop: 6 }}>
                    {policyState.risk_score <= 40 ? "Low risk" : policyState.risk_score <= 70 ? "Elevated risk" : "Critical — action needed"}
                  </div>
                </Card>

                {/* Protocol Status */}
                <Card style={{ padding: "16px 18px", border: `1px solid ${policyState.is_paused ? C.danger+"44" : C.border}`, background: policyState.is_paused ? C.danger+"08" : C.card }}>
                  <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 3, marginBottom: 8 }}>PROTOCOL STATUS</div>
                  <Glow color={policyState.is_paused ? C.danger : C.safe} size={22} weight={700}>
                    {policyState.is_paused ? "PAUSED" : "ACTIVE"}
                  </Glow>
                  <div style={{ fontFamily: SANS, fontSize: 11, color: C.mutedHi, marginTop: 6 }}>
                    {policyState.is_paused ? "AI agent triggered pause" : "Protocol operating normally"}
                  </div>
                </Card>

                {/* Max Leverage */}
                <Card style={{ padding: "16px 18px" }}>
                  <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 3, marginBottom: 8 }}>MAX LEVERAGE</div>
                  <Glow color={C.gold} size={28} weight={700}>{(policyState.max_leverage / 100).toFixed(0)}x</Glow>
                  <div style={{ fontFamily: SANS, fontSize: 11, color: C.mutedHi, marginTop: 6 }}>{policyState.max_leverage}bp on-chain</div>
                </Card>

                {/* Liquidation Threshold */}
                <Card style={{ padding: "16px 18px" }}>
                  <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 3, marginBottom: 8 }}>LIQUIDATION THRESHOLD</div>
                  <Glow color={C.blue} size={28} weight={700}>{(policyState.liquidation_threshold / 100).toFixed(0)}%</Glow>
                  <div style={{ fontFamily: SANS, fontSize: 11, color: C.mutedHi, marginTop: 6 }}>{policyState.liquidation_threshold}bp on-chain</div>
                </Card>
              </div>

              {/* Section B — Agent Info */}
              <Card style={{ padding: "14px 18px" }}>
                <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 3, marginBottom: 12 }}>AI AGENT STATUS</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
                  <div>
                    <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 2, marginBottom: 5 }}>AGENT ADDRESS</div>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: C.accent }}>{fmt.addr(policyState.agent)}</span>
                  </div>
                  <div>
                    <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 2, marginBottom: 5 }}>AGENT STATUS</div>
                    <Tag color={policyState.agent_active ? C.safe : C.danger}>{policyState.agent_active ? "ACTIVE" : "REVOKED"}</Tag>
                  </div>
                  <div>
                    <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 2, marginBottom: 5 }}>ACTIONS REMAINING</div>
                    <Glow color={policyState.actions_remaining < 10 ? C.warn : C.text} size={14} weight={700}>
                      {policyState.actions_remaining}/{policyState.max_actions}
                    </Glow>
                  </div>
                  <div>
                    <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 2, marginBottom: 5 }}>TOTAL ACTIONS TAKEN</div>
                    <Glow color={C.text} size={14} weight={700}>{policyState.total_actions}</Glow>
                  </div>
                </div>
              </Card>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 14 }}>
                {/* Section C — Event Log */}
                <Card>
                  <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
                    <SectionHeader
                      title="ON-CHAIN AUDIT LOG"
                      sub="Every AI action is permanently recorded on Sui · Immutable"
                    />
                  </div>
                  {guardianEvents.length === 0 ? (
                    <div style={{ padding: 24, fontFamily: SANS, fontSize: 12, color: C.muted, textAlign: "center" }}>
                      No events found for this policy.
                    </div>
                  ) : (
                    guardianEvents.map((e, i) => {
                      const name = shortEventType(e.type)
                      const summary = eventSummary(e.type, e.parsedJson)
                      const isHighSev = name === "ProtocolPaused" || name === "AgentRevoked"
                      const isMedSev  = name === "AdminOverride" || name === "RiskScoreUpdated"
                      const dotColor  = isHighSev ? C.danger : isMedSev ? C.warn : C.accent
                      return (
                        <div key={i} style={{
                          padding: "11px 16px",
                          borderBottom: i < guardianEvents.length - 1 ? `1px solid ${C.border}` : "none",
                          display: "flex", gap: 12, alignItems: "flex-start",
                        }}>
                          <div style={{
                            width: 3, alignSelf: "stretch", background: dotColor,
                            borderRadius: 2, flexShrink: 0, boxShadow: `0 0 6px ${dotColor}`,
                          }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                              <span style={{ fontFamily: MONO, fontSize: 11, color: C.text, fontWeight: 600 }}>{name}</span>
                              <span style={{ fontFamily: MONO, fontSize: 9, color: C.muted, flexShrink: 0, marginLeft: 8 }}>{fmtTs(e.timestampMs)}</span>
                            </div>
                            {summary && <div style={{ fontFamily: SANS, fontSize: 11, color: C.mutedHi, marginBottom: 4 }}>{summary}</div>}
                            <a
                              href={`https://testnet.suivision.xyz/txblock/${e.txDigest}`}
                              target="_blank" rel="noopener noreferrer"
                              style={{ fontFamily: MONO, fontSize: 9, color: C.blue, textDecoration: "none", letterSpacing: 0.5 }}
                            >{e.txDigest.slice(0, 20)}… ↗</a>
                          </div>
                        </div>
                      )
                    })
                  )}
                </Card>

                {/* Section D — Admin Controls */}
                <Card>
                  <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
                    <SectionHeader title="ADMIN CONTROLS" sub="Human override · DAO governance" />
                  </div>
                  <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{
                      padding: "8px 10px", background: C.warn+"0a",
                      border: `1px solid ${C.warn}22`, borderRadius: 3, marginBottom: 4,
                    }}>
                      <span style={{ fontFamily: SANS, fontSize: 11, color: C.warn }}>
                        ⚠ Requires AdminCap · On-chain governance
                      </span>
                    </div>

                    {policyState.is_paused && (
                      <button onClick={handleAdminResume} style={{
                        padding: "11px 14px", fontFamily: MONO, fontSize: 11, fontWeight: 700,
                        letterSpacing: 2, borderRadius: 4, cursor: "pointer",
                        background: C.safe+"18", border: `1px solid ${C.safe}66`,
                        color: C.safe, textShadow: `0 0 8px ${C.safe}88`,
                      }}>RESUME PROTOCOL</button>
                    )}

                    <button onClick={handleRevokeAgent} disabled={!policyState.agent_active} style={{
                      padding: "11px 14px", fontFamily: MONO, fontSize: 11, fontWeight: 700,
                      letterSpacing: 2, borderRadius: 4, cursor: policyState.agent_active ? "pointer" : "not-allowed",
                      background: C.danger+"18", border: `1px solid ${C.danger}66`,
                      color: policyState.agent_active ? C.danger : C.muted,
                      textShadow: policyState.agent_active ? `0 0 8px ${C.danger}88` : "none",
                      opacity: policyState.agent_active ? 1 : 0.4,
                    }}>REVOKE AGENT</button>

                    <button onClick={handleResetBudget} style={{
                      padding: "11px 14px", fontFamily: MONO, fontSize: 11, fontWeight: 700,
                      letterSpacing: 2, borderRadius: 4, cursor: "pointer",
                      background: C.gold+"18", border: `1px solid ${C.gold}66`,
                      color: C.gold, textShadow: `0 0 8px ${C.gold}88`,
                    }}>RESET AGENT BUDGET</button>

                    <button onClick={() => {
                      if (!showParamsForm) {
                        setParamLeverage(String(policyState.max_leverage))
                        setParamLiqThreshold(String(policyState.liquidation_threshold))
                      }
                      setShowParamsForm(v => !v)
                    }} style={{
                      padding: "11px 14px", fontFamily: MONO, fontSize: 11, fontWeight: 700,
                      letterSpacing: 2, borderRadius: 4, cursor: "pointer",
                      background: C.gold+"18", border: `1px solid ${C.gold}66`,
                      color: C.gold, textShadow: `0 0 8px ${C.gold}88`,
                    }}>ADJUST PARAMETERS</button>

                    {showParamsForm && (
                      <div style={{
                        padding: "14px 16px", borderRadius: 4,
                        background: C.bg, border: `1px solid ${C.border}`,
                        display: "flex", flexDirection: "column", gap: 10,
                      }}>
                        <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 2 }}>SET NEW PARAMETERS</div>
                        <div style={{ display: "flex", gap: 10 }}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontFamily: SANS, fontSize: 11, color: C.mutedHi, marginBottom: 4 }}>Max Leverage</div>
                            <input
                              type="number" min={1} value={paramLeverage}
                              onChange={e => setParamLeverage(e.target.value)}
                              style={{
                                width: "100%", background: C.surface, border: `1px solid ${C.borderHi}`,
                                color: C.text, fontFamily: MONO, fontSize: 13, padding: "7px 10px",
                                borderRadius: 3, outline: "none",
                              }}
                            />
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontFamily: SANS, fontSize: 11, color: C.mutedHi, marginBottom: 4 }}>Liq. Threshold (bps)</div>
                            <input
                              type="number" min={1} value={paramLiqThreshold}
                              onChange={e => setParamLiqThreshold(e.target.value)}
                              style={{
                                width: "100%", background: C.surface, border: `1px solid ${C.borderHi}`,
                                color: C.text, fontFamily: MONO, fontSize: 13, padding: "7px 10px",
                                borderRadius: 3, outline: "none",
                              }}
                            />
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button onClick={handleAdjustParams} style={{
                            flex: 1, padding: "9px 0", fontFamily: MONO, fontSize: 11, fontWeight: 700,
                            letterSpacing: 2, borderRadius: 4, cursor: "pointer",
                            background: C.gold+"22", border: `1px solid ${C.gold}66`,
                            color: C.gold, textShadow: `0 0 8px ${C.gold}88`,
                          }}>SUBMIT →</button>
                          <button onClick={() => setShowParamsForm(false)} style={{
                            padding: "9px 16px", fontFamily: MONO, fontSize: 11,
                            borderRadius: 4, cursor: "pointer",
                            background: "transparent", border: `1px solid ${C.border}`,
                            color: C.muted,
                          }}>CANCEL</button>
                        </div>
                      </div>
                    )}

                    {txStatus && (
                      <div style={{
                        padding: "10px 12px", borderRadius: 4, fontFamily: MONO, fontSize: 11,
                        background: txStatus.startsWith("✓") ? C.safe+"14" : C.danger+"14",
                        border: `1px solid ${txStatus.startsWith("✓") ? C.safe : C.danger}44`,
                        color: txStatus.startsWith("✓") ? C.safe : C.danger,
                      }}>{txStatus}</div>
                    )}

                    <div style={{ marginTop: 8, padding: "12px 14px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 4 }}>
                      <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 2, marginBottom: 8 }}>POLICY METADATA</div>
                      {[
                        ["Admin",       fmt.addr(policyState.admin)],
                        ["Created",     fmtTs(String(policyState.created_at))],
                        ["Last Action", fmtTs(String(policyState.last_action_at))],
                      ].map(([k, v]) => (
                        <div key={k} style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                          <span style={{ fontFamily: SANS, fontSize: 11, color: C.muted }}>{k}</span>
                          <span style={{ fontFamily: MONO, fontSize: 11, color: C.text }}>{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </Card>
              </div>
            </div>
          )
        })()}

        {/* POSITIONS TAB */}
        {tab === "positions" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <PortfolioOverview positions={positions} walletConnected={isWalletConnected} />

              {/* Wallet Balances section */}
              <PositionTable positions={positions} onSelect={setSelectedPos} selected={selectedPos} walletConnected={isWalletConnected} />

              {/* Protocol Positions section */}
              <Card>
                <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <Glow size={11} style={{ letterSpacing: 3, display: "block", marginBottom: 3 }}>PROTOCOL POSITIONS</Glow>
                    <span style={{ fontFamily: SANS, fontSize: 12, color: C.mutedHi }}>
                      Navi · Scallop · Cetus · Bluefin · SuiLend · DeepBook · 8 protocols scanned
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    {protocolLoading && <span style={{ fontFamily: MONO, fontSize: 9, color: C.accent, animation: "pulse 1.2s infinite" }}>SCANNING…</span>}
                    {protocolPositions.length > 0 && <Tag color={C.safe}>{protocolPositions.length} found</Tag>}
                  </div>
                </div>

                {!isWalletConnected ? (
                  <div style={{ padding: "28px 16px", textAlign: "center" }}>
                    <div style={{ fontFamily: MONO, fontSize: 12, color: C.muted, marginBottom: 4 }}>Connect wallet to scan DeFi protocols</div>
                    <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted }}>All owned objects are scanned for known protocol position types.</div>
                  </div>
                ) : protocolPositions.length === 0 && !protocolLoading ? (
                  <div style={{ padding: "28px 16px", textAlign: "center" }}>
                    <div style={{ fontFamily: MONO, fontSize: 12, color: C.muted, marginBottom: 4 }}>No protocol positions found</div>
                    <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted }}>No Navi, Scallop, Cetus, or other DeFi protocol objects detected on this address.</div>
                  </div>
                ) : (
                  /* Group by protocol */
                  (() => {
                    const PROTO_COLORS: Record<string, string> = {
                      "Navi Protocol":     C.safe,
                      "Scallop":           "#8b5cf6",
                      "Cetus":             C.blue,
                      "Aftermath Finance": C.danger,
                      "Bluefin":           C.accent,
                      "SuiLend":           C.warn,
                      "DeepBook":          C.gold,
                      "Ember":             "#ec4899",
                    }
                    const TYPE_COLORS: Record<string, string> = {
                      LP:       "#8b5cf6",
                      LEND:     C.safe,
                      BORROW:   C.warn,
                      STAKE:    C.blue,
                      POSITION: C.muted,
                    }
                    const grouped: Record<string, ProtocolPosition[]> = {}
                    for (const p of protocolPositions) {
                      if (!grouped[p.protocol]) grouped[p.protocol] = []
                      grouped[p.protocol].push(p)
                    }
                    return Object.entries(grouped).map(([proto, items]) => {
                      const protoColor = PROTO_COLORS[proto] ?? C.accent
                      return (
                        <div key={proto}>
                          <div style={{
                            padding: "8px 16px", background: C.surface,
                            borderBottom: `1px solid ${C.border}`,
                            display: "flex", alignItems: "center", gap: 8,
                          }}>
                            <div style={{ width: 7, height: 7, borderRadius: "50%", background: protoColor }} />
                            <span style={{ fontFamily: MONO, fontSize: 10, color: protoColor, letterSpacing: 2 }}>{proto.toUpperCase()}</span>
                            <Tag color={protoColor}>{items.length}</Tag>
                          </div>
                          {items.map((pos, i) => {
                            const typeColor = TYPE_COLORS[pos.type] ?? C.accent
                            const valueLabel = pos.details.balance
                              ? `bal: ${pos.details.balance}`
                              : pos.details.liquidity
                              ? `liq: ${pos.details.liquidity}`
                              : null
                            return (
                              <div key={pos.objectId} style={{
                                padding: "11px 16px",
                                borderBottom: i < items.length - 1 ? `1px solid ${C.border}` : "none",
                                display: "flex", justifyContent: "space-between", alignItems: "center",
                              }}>
                                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                                  <Tag color={typeColor}>{pos.type}</Tag>
                                  <span style={{ fontFamily: MONO, fontSize: 12, color: C.text }}>{pos.asset}</span>
                                  {valueLabel && (
                                    <span style={{ fontFamily: MONO, fontSize: 9, color: C.mutedHi }}>{valueLabel}</span>
                                  )}
                                </div>
                                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                                  <span style={{ fontFamily: MONO, fontSize: 9, color: C.muted }}>
                                    {pos.objectId.slice(0, 10)}…
                                  </span>
                                  <a
                                    href={`https://suiscan.xyz/${network}/object/${pos.objectId}`}
                                    target="_blank" rel="noopener noreferrer"
                                    style={{ fontFamily: MONO, fontSize: 9, color: C.blue, textDecoration: "none" }}
                                  >↗</a>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )
                    })
                  })()
                )}
                {protocolError && (
                  <div style={{ padding: "8px 16px", fontFamily: SANS, fontSize: 11, color: C.danger }}>
                    Scan error: {protocolError}
                  </div>
                )}
              </Card>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <AIAdvisor positions={positions} pools={pools} groqKey={groqKey} />
              <RiskFeed events={riskEvents} walletConnected={isWalletConnected} />
            </div>
          </div>
        )}

        {/* DEEPBOOK TAB */}
        {tab === "deepbook" && (
          <div>
            {pools.length > 0 && (
              <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                {pools.map(p => (
                  <Pill key={p.id} label={`${p.base}/${p.quote}`}
                    active={selectedPool?.id === p.id}
                    onClick={() => setSelectedPool(p)} color={C.gold} />
                ))}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <DeepBookPanel selectedPool={selectedPool} />
                {selectedPool && (
                  <Card style={{ padding: 16 }}>
                    <SectionHeader title="POOL STATISTICS" sub={`${selectedPool.base}/${selectedPool.quote} · DeepBook CLOB · Simulated`} />
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10 }}>
                      {[
                        ["24H VOLUME",      "—"],
                        ["LIQUIDITY",       "—"],
                        ["BID/ASK SPREAD",  `${selectedPool.spread}%`],
                        ["MID PRICE",       fmt.usd(selectedPool.price)],
                        ["24H CHANGE",      fmt.pct(selectedPool.change)],
                        ["DATA SOURCE",     "CoinGecko / Pyth"],
                      ].map(([k, v]: any) => (
                        <div key={k} style={{ padding: "12px 14px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 4 }}>
                          <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 2, marginBottom: 6 }}>{k}</div>
                          <Glow size={14} color={String(v).startsWith("-") ? C.danger : String(v).startsWith("+") ? C.safe : C.text}>{v as string}</Glow>
                        </div>
                      ))}
                    </div>
                    <div style={{ marginTop: 10, padding: "8px 12px", background: C.bg, border: `1px solid ${C.border}`, borderRadius: 3 }}>
                      <span style={{ fontFamily: SANS, fontSize: 11, color: C.muted }}>
                        Volume and liquidity data require direct DeepBook API access — coming soon.
                      </span>
                    </div>
                  </Card>
                )}
              </div>
              {selectedPool && <TradingPanel pool={selectedPool} network={network} />}
            </div>
          </div>
        )}

        {/* AI ADVISOR TAB */}
        {tab === "advisor" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 14 }}>
            <AIAdvisor positions={positions} pools={pools} groqKey={groqKey} />
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <RiskFeed events={riskEvents} walletConnected={isWalletConnected} />
              {positions.length > 0 && (
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
              )}
            </div>
          </div>
        )}

        {/* SIMULATOR TAB */}
        {tab === "simulator" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <ScenarioSimulator positions={positions} />
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <PortfolioOverview positions={positions} walletConnected={isWalletConnected} />
              {positions.length > 0 && (
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
              )}
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
                { label: "FRONTEND LAYER",            color: C.accent,   items: ["React 19 + Next.js 16", "Sui Wallet Kit v1.0.5", "@tanstack/react-query for data", "AI Chat Interface", isWalletConnected ? `● Live wallet: ${fmt.addr(walletAddr)}` : "○ Connect wallet for live data"] },
                { label: "SUI INTEGRATION LAYER",    color: C.blue,     items: [`${network.toUpperCase()} · Sui JSON-RPC`, "RiskGuardian Move contract", "Pyth Network oracle (10s)", "Sui object model"] },
                { label: "DEEPBOOK LAYER",           color: C.gold,     items: ["CLOB orderbook visualization", "Limit/Market order UI", "Pool price monitoring", "Live API integration coming soon"] },
                { label: "AI INTELLIGENCE LAYER",    color: C.accentDim, items: ["Llama 3.3 70B via Groq", "Portfolio stress testing", "Natural language advisor", "Anomaly detection signals"] },
                { label: "DEPLOYMENT",               color: C.safe,     items: ["Vercel · Production build", isWalletConnected ? `● Connected: ${fmt.addr(walletAddr)}` : "○ Connect wallet to load positions", "RiskGuardian on Testnet", "DAO governance (Phase 4)"] },
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
