"use client"

import { useState, useEffect, useRef } from "react"
import { SuiClientProvider, WalletProvider, ConnectButton as DappConnectButton } from "@mysten/dapp-kit"
import { useCurrentAccount, useSuiClient, useSignAndExecuteTransaction, useDisconnectWallet } from "@mysten/dapp-kit"
import { Transaction } from "@mysten/sui/transactions"
import { useRiskGuardian } from "@/app/hooks/useRiskGuardian"
import { useRiskEngine } from "@/app/hooks/useRiskEngine"
import { usePythPrices } from "@/app/hooks/usePythPrices"
import { useProtocolPositions, type ProtocolPosition } from "@/app/hooks/useProtocolPositions"
import { RISK_GUARDIAN } from "@/app/config/contracts"
import { RiskGauge } from "@/app/components/RiskGauge"
import { DecisionPipeline } from "@/app/components/DecisionPipeline"
import { IntentEngine } from "@/app/components/IntentEngine"
import { ActionPreview, type ActionIntent } from "@/app/components/ActionPreview"
import { Landing } from "@/app/components/Landing"

// ─── DESIGN TOKENS ─────────────────────────────────────────────────────────────
const C = {
  bg: "#FBFBFA", surface: "#F4F5F7", card: "#FFFFFF",
  border: "#E4E6EB", borderHi: "#D4D8E0",
  accent: "#1A56DB", accentDim: "#E6F1FB",
  blue: "#1A56DB", blueDim: "#1245B5",
  gold: "#BA7517", danger: "#E24B4A",
  warn: "#BA7517", safe: "#1D9E75",
  text: "#16181D", muted: "#5B6470", mutedHi: "#8A929E",
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
function riskLevelColor(level?: string) {
  if (level === "CRITICAL") return C.danger
  if (level === "HIGH")     return C.warn
  if (level === "MEDIUM")   return C.gold
  return C.accent  // LOW / undefined
}
function fmtAgo(ts: number | undefined, now: number): string {
  if (!ts) return "—"
  const s = Math.floor((now - ts) / 1000)
  if (s < 5)    return "just now"
  if (s < 60)   return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

// ─── NETWORK TAGS ──────────────────────────────────────────────────────────────
const NET = {
  testnet: { label: "TESTNET", color: C.warn,   rpc: "https://fullnode.testnet.sui.io" },
  mainnet: { label: "MAINNET", color: C.safe,   rpc: "https://fullnode.mainnet.sui.io" },
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
  }
  return <span style={{ ...merged, ...style }}>{children}</span>
}
function Tag({ children, color = C.accent }: any) {
  return <span style={{
    fontFamily: MONO, fontSize: 10, color, border: `1px solid ${color}55`,
    padding: "2px 7px", borderRadius: 2, background: color+"11", letterSpacing: 1,
  }}>{children}</span>
}
function Card({ children, style, glow = false, onClick }: any) {
  return <div onClick={onClick} style={{
    background: C.card,
    border: `1px solid ${glow ? C.borderHi : C.border}`,
    borderRadius: 6,
    boxShadow: glow ? "0 2px 8px rgba(16,24,40,0.08)" : "0 1px 2px rgba(16,24,40,0.04)",
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
        transition: "width 0.6s ease", borderRadius: 2,
      }} />
    </div>
  )
}
function Skeleton({ w = "100%", h = 14, style }: { w?: string|number; h?: number; style?: any }) {
  return <div className="ds-skeleton" style={{ width: w, height: h, ...style }} />
}
function SkeletonCard({ lines = 2, style }: { lines?: number; style?: any }) {
  return (
    <Card style={{ padding: "16px 18px", ...style }}>
      <Skeleton h={8} w="42%" style={{ marginBottom: 12 }} />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} h={i === 0 ? 22 : 11} w={i === 0 ? "68%" : "44%"}
          style={{ marginBottom: i < lines - 1 ? 8 : 0 }} />
      ))}
    </Card>
  )
}
function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "10px 16px", marginBottom: 14,
      background: C.danger + "0a", border: `1px solid ${C.danger}33`, borderRadius: 6,
    }}>
      <span style={{ color: C.danger, fontSize: 14, flexShrink: 0 }}>⚠</span>
      <span style={{ fontFamily: SANS, fontSize: 12, color: C.text, flex: 1 }}>{message}</span>
      {onRetry && (
        <button onClick={onRetry} style={{
          fontFamily: MONO, fontSize: 10, padding: "4px 10px", letterSpacing: 1,
          background: C.danger + "18", border: `1px solid ${C.danger}44`,
          color: C.danger, borderRadius: 3, cursor: "pointer", flexShrink: 0,
        }}>RETRY</button>
      )}
    </div>
  )
}
function Pill({ label, active, onClick, color = C.accent }: any) {
  return <button onClick={onClick} style={{
    fontFamily: MONO, fontSize: 11, padding: "5px 14px",
    background: active ? color+"22" : "transparent",
    border: `1px solid ${active ? color : C.border}`,
    color: active ? color : C.muted, borderRadius: 3,
    cursor: "pointer",
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
      display: "inline-block",
    }} />
    <span style={{ fontFamily: MONO, fontSize: 10, color: net.color, letterSpacing: 2 }}>{net.label}</span>
  </div>
}
function SectionHeader({ title, sub, action }: any) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
      <div>
        <span style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: C.text, display: "block", marginBottom: 3 }}>{title}</span>
        {sub && <span style={{ fontFamily: SANS, fontSize: 12, color: C.mutedHi }}>{sub}</span>}
      </div>
      {action}
    </div>
  )
}

// ─── SCORE BAR ─────────────────────────────────────────────────────────────────
function ScoreBar({ score, level, demoMode, onToggleDemo }: {
  score: number; level?: string; demoMode: boolean; onToggleDemo: () => void
}) {
  const color = level === "CRITICAL" ? C.danger : level === "HIGH" ? C.warn : level === "MEDIUM" ? C.gold : C.safe
  return (
    <div style={{ maxWidth: 560, margin: "0 auto 24px" }}>
      <div style={{
        background: C.card, border: `1px solid ${C.border}`, borderRadius: 8,
        padding: "24px 28px", position: "relative",
      }}>
        <div style={{ position: "absolute", top: 14, right: 14, display: "flex", alignItems: "center", gap: 8 }}>
          {demoMode && (
            <span style={{ fontFamily: SANS, fontSize: 11, color: C.danger }}>● Simulating crash</span>
          )}
          <button onClick={onToggleDemo} style={{
            fontFamily: SANS, fontSize: 12, padding: "5px 12px",
            background: demoMode ? C.danger + "14" : "transparent",
            border: `1px solid ${demoMode ? C.danger + "55" : C.border}`,
            color: demoMode ? C.danger : C.muted,
            borderRadius: 6, cursor: "pointer",
          }}>{demoMode ? "Reset" : "Simulate crash"}</button>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 14 }}>
          <span style={{ fontFamily: MONO, fontSize: 56, fontWeight: 700, color, lineHeight: 1 }}>{score}</span>
          <span style={{ fontFamily: MONO, fontSize: 22, color: C.muted }}>/100</span>
          <span style={{
            marginLeft: 10, fontFamily: SANS, fontSize: 13, fontWeight: 600, color,
            background: color + "14", border: `1px solid ${color}44`,
            padding: "4px 12px", borderRadius: 20,
          }}>{level ?? "—"}</span>
        </div>
        <div style={{ height: 8, background: C.border, borderRadius: 4, overflow: "hidden" }}>
          <div style={{
            height: "100%", width: `${score}%`, background: color,
            borderRadius: 4, transition: "width 0.6s ease",
          }} />
        </div>
      </div>
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
  // Net value = sum of supplied USD values minus sum of borrowed USD values.
  // Only positions with a real usdValue (size > 0) contribute — others default to 0.
  const supplied  = hasPositions ? positions.filter((p: any) => p.type === "LEND"  || p.type === "STAKE" || p.type === "LP").reduce((s: number, p: any) => s + (p.size || 0), 0) : 0
  const borrowed  = hasPositions ? positions.filter((p: any) => p.type === "BORROW").reduce((s: number, p: any) => s + (p.size || 0), 0) : 0
  const netValue  = supplied - borrowed
  const totalPnl  = hasPositions ? positions.reduce((s: number, p: any) => s + p.pnl, 0) : 0
  // PnL is only meaningful when at least one position has a real entry price.
  // The adapter hardcodes pnl:0 for all positions (no entry-price data available
  // from Navi/fallback scan), so totalPnl===0 with every p.pnl===0 means "no data".
  const hasPnlData = hasPositions && positions.some((p: any) => p.pnl !== 0)
  // healthPos = positions that have REAL health data (not null).
  // Previously filtered for health < 100, which excluded genuinely healthy accounts
  // (HF ≥ 2.0 maps to 100%) and caused "No health data yet" even when data was present.
  const healthPos = hasPositions ? positions.filter((p: any) => p.health !== null) : []
  const avgHealth = healthPos.length > 0 ? Math.round(healthPos.reduce((s: number, p: any) => s + p.health, 0) / healthPos.length) : 0
  const atRisk    = hasPositions ? positions.filter((p: any) => p.health !== null && p.health < 60).length : 0
  const stats = [
    {
      label: "Net DeFi value",
      value: hasPositions ? fmt.usd(netValue) : "$0.00",
      color: C.text,
      sub: hasPositions
        ? `${fmt.usd(supplied)} supplied · ${fmt.usd(borrowed)} borrowed`
        : "Connect wallet to load",
    },
    {
      label: "Total PnL",
      value: hasPnlData ? fmt.usd(Math.abs(totalPnl)) : "—",
      color: hasPnlData ? (totalPnl >= 0 ? C.safe : C.danger) : C.muted,
      sub: hasPnlData ? (totalPnl >= 0 ? "▲ Profitable" : "▼ In loss") : "Entry price data unavailable",
    },
    {
      label: "Avg health",
      value: healthPos.length > 0 ? `${avgHealth}%` : "—",
      color: healthPos.length > 0 ? healthColor(avgHealth) : C.muted,
      sub: healthPos.length > 0
        ? `Navi account · ${healthPos.length} position${healthPos.length !== 1 ? "s" : ""}`
        : hasPositions ? "Health factor unavailable" : "—",
    },
    {
      label: "At risk",
      value: hasPositions ? `${atRisk} pos` : "0 pos",
      color: hasPositions && atRisk > 0 ? C.danger : C.muted,
      sub: "Health < 60%",
    },
  ]
  return (
    <div className="ds-metric-grid">
      {stats.map((s: any) => (
        <Card key={s.label} style={{ padding: "16px 18px" }}>
          <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted, marginBottom: 8 }}>{s.label}</div>
          <Glow color={s.color} size={24} weight={700}>
            <span key={s.value} className="ds-num-pop">{s.value}</span>
          </Glow>
          <div style={{ fontFamily: SANS, fontSize: 11, color: C.mutedHi, marginTop: 5 }}>{s.sub}</div>
        </Card>
      ))}
    </div>
  )
}

// ─── POSITION TABLE ────────────────────────────────────────────────────────────
function PositionTable({ positions, onSelect, selected, walletConnected }: any) {
  function healthStatus(health: number | null, type: string): { label: string; color: string } | null {
    if (health === null) return null
    // Navi's HF is account-level. Show it only on BORROW rows — those are what
    // get liquidated. LEND/LP/STAKE positions have no independent per-row HF.
    if (type !== "BORROW") return null
    if (health >= 80) return { label: `Healthy · ${health}%`, color: C.safe }
    if (health >= 50) return { label: `Monitor · ${health}%`, color: C.warn }
    return { label: `At risk · ${health}%`, color: C.danger }
  }
  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
        <SectionHeader title="Open positions" sub={
          walletConnected
            ? "Live on-chain data · Sui Mainnet"
            : "Connect wallet to view positions"
        } />
      </div>
      {!walletConnected ? (
        <div style={{ padding: 32, textAlign: "center" }}>
          <div style={{ fontFamily: SANS, fontSize: 14, color: C.muted, marginBottom: 8 }}>No wallet connected</div>
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.muted }}>Connect a Sui wallet to load your on-chain positions.</div>
        </div>
      ) : positions.length === 0 ? (
        <div style={{ padding: 32, textAlign: "center" }}>
          <div style={{ fontFamily: SANS, fontSize: 14, color: C.muted, marginBottom: 8 }}>No DeFi positions found</div>
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.muted }}>No Navi, Scallop, Cetus, or other DeFi protocol positions detected on this wallet.</div>
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                {["Asset / Protocol", "Value", "Health", ""].map(h => (
                  <th key={h} style={{
                    fontFamily: SANS, fontSize: 11, color: C.muted,
                    padding: "8px 16px", textAlign: "left", fontWeight: 500,
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.map((p: any) => {
                const status = healthStatus(p.health, p.type)
                return (
                  <tr key={p.id} onClick={() => onSelect(p)}
                    style={{
                      borderBottom: `1px solid ${C.border}`, cursor: "pointer",
                      background: selected?.id === p.id ? `${C.blue}06` : "transparent",
                      transition: "background 0.15s",
                    }}>
                    <td style={{ padding: "13px 16px" }}>
                      <div style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 3 }}>
                        {p.asset}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontFamily: SANS, fontSize: 11, color: C.muted }}>{p.protocol}</span>
                        <span style={{
                          fontFamily: SANS, fontSize: 10, color: C.muted,
                          background: C.border, padding: "1px 6px", borderRadius: 3,
                        }}>{p.type}</span>
                      </div>
                    </td>
                    <td style={{ padding: "13px 16px" }}>
                      <span style={{ fontFamily: MONO, fontSize: 13, color: C.text }}>
                        {p.size > 0 ? fmt.usd(p.size) : p.balStr ? `${parseFloat(p.balStr).toFixed(4)} ${p.asset}` : "—"}
                      </span>
                      {p.size > 0 && p.balStr && (
                        <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted, display: "block", marginTop: 2 }}>
                          {parseFloat(p.balStr).toFixed(4)} {p.asset}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: "13px 16px" }}>
                      {status ? (
                        <span style={{
                          fontFamily: SANS, fontSize: 12, fontWeight: 600, color: status.color,
                          background: status.color + "12", border: `1px solid ${status.color}33`,
                          padding: "4px 12px", borderRadius: 20, whiteSpace: "nowrap",
                        }}>{status.label}</span>
                      ) : (
                        <span style={{ fontFamily: SANS, fontSize: 12, color: C.muted }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: "13px 16px" }}>
                      <button style={{
                        fontFamily: SANS, fontSize: 12, padding: "6px 14px",
                        background: C.card, border: `1px solid ${C.border}`,
                        color: C.text, borderRadius: 6, cursor: "pointer", fontWeight: 500,
                      }}>Analyze</button>
                    </td>
                  </tr>
                )
              })}
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
          <SectionHeader title="DeepBook orderbook" sub="Waiting for price data…" />
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
          title="DeepBook orderbook"
          sub={`${selectedPool.base}/${selectedPool.quote} · CLOB · Simulated orderbook visualization`}
        />
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <div>
            <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted }}>Spread</div>
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
        <SectionHeader title="Risk event feed" sub="AI-detected anomalies · Real-time" />
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
              borderRadius: 2, flexShrink: 0,
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
  `- ${p.type} ${p.asset} on ${p.protocol}: Size $${p.size}, Leverage ${p.leverage}x${p.health !== null ? `, Health ${p.health}%` : ""}, Liquidation at $${p.liquidationPrice ?? "N/A"}, Current PNL: $${p.pnl}`
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
        <SectionHeader title="Scenario simulator" sub="AI stress-test your portfolio" />
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

        {/* Quick-status rows — only for positions with a liquidation price */}
        {positions.filter((p: any) => p.liquidationPrice && p.entryPrice).length > 0 && (
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, overflow: "hidden", marginBottom: 14 }}>
            {positions.filter((p: any) => p.liquidationPrice && p.entryPrice).map((p: any, i: number, arr: any[]) => {
              const crashPrice = (p.entryPrice as number) * (1 - drop / 100)
              const liq = p.liquidationPrice as number
              const willLiq = p.type === "LONG" ? crashPrice < liq : crashPrice > liq
              const atRisk = !willLiq && (p.type === "LONG" ? crashPrice < liq * 1.2 : crashPrice > liq * 0.8)
              const rowBg = willLiq ? "#FCEBEB" : atRisk ? "#FAEEDA" : "#E1F5EE"
              const statusColor = willLiq ? C.danger : atRisk ? C.warn : C.safe
              const statusWord = willLiq ? "Liquidated" : atRisk ? "At risk" : "Safe"
              return (
                <div key={p.id} style={{
                  padding: "12px 16px", background: rowBg,
                  borderBottom: i < arr.length - 1 ? `1px solid ${C.border}` : "none",
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}>
                  <div>
                    <span style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: C.text }}>{p.asset}</span>
                    <span style={{ fontFamily: SANS, fontSize: 11, color: C.muted, marginLeft: 8 }}>{p.protocol}</span>
                    <div style={{ fontFamily: MONO, fontSize: 11, color: C.muted, marginTop: 3 }}>
                      Crash: ~{fmt.usd(Number(crashPrice.toFixed(2)))} · Liq: {fmt.usd(liq)}
                    </div>
                  </div>
                  <span style={{ fontFamily: SANS, fontSize: 14, fontWeight: 700, color: statusColor }}>
                    {statusWord}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        <button onClick={simulate} disabled={loading} style={{
          width: "100%", padding: "12px",
          background: loading ? C.border : C.blue,
          border: `1px solid ${loading ? C.border : C.blue}`,
          color: loading ? C.muted : "#fff",
          fontFamily: SANS, fontSize: 14, fontWeight: 600,
          borderRadius: 6, cursor: loading ? "not-allowed" : "pointer",
          marginBottom: result ? 14 : 0,
        }}>
          {loading ? "Running simulation…" : "Run AI stress test"}
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

// Strip the optional ```action block from an AI reply and return both parts.
// parseActionBlock — tolerant extraction of the model's optional action signal.
//
// Accepted formats (in priority order):
//   1. ```action\n{...}\n```   — fenced, canonical
//   2. {..."action":...}       — bare JSON object containing "action" key
//   3. single-quoted keys/values, trailing commas — normalised before parse
//
// On total failure: returns { cleanText: original text, actionJson: null } — never throws.
//
// Test corpus (5/6 must parse; #6 must return null):
// const _PARSE_TESTS = [
//   /* 1 fenced canonical  */ '```action\n{"action":"update_risk_score","score":72}\n```',
//   /* 2 fenced no newline */ '```action{"action":"update_risk_score","score":55}```',
//   /* 3 bare JSON         */ 'You should sync. {"action":"update_risk_score","score":60}',
//   /* 4 single quotes     */ "```action\n{'action':'update_risk_score','score':45}\n```",
//   /* 5 trailing comma    */ '```action\n{"action":"update_risk_score","score":80,}\n```',
//   /* 6 malformed / null  */ '```action\nnot json at all\n```',
// ]
// _PARSE_TESTS.forEach((t, i) => {
//   const r = parseActionBlock(t)
//   console.assert(i === 5 ? r.actionJson === null : r.actionJson !== null, `test ${i + 1} failed`, r)
// })
function parseActionBlock(text: string): { cleanText: string; actionJson: Record<string, unknown> | null } {
  // Normalise raw candidate string before JSON.parse
  function tryParse(raw: string): Record<string, unknown> | null {
    const normalised = raw
      .trim()
      .replace(/'/g, '"')            // single → double quotes
      .replace(/,\s*([}\]])/g, "$1") // trailing commas
    try {
      const obj = JSON.parse(normalised)
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Record<string, unknown>
    } catch { /* fall through */ }
    return null
  }

  // Priority 1: fenced block (with or without newline after opening fence)
  const fenced = text.match(/```action\s*([\s\S]*?)```/)
  if (fenced) {
    const obj = tryParse(fenced[1])
    const cleanText = text.slice(0, fenced.index).trimEnd()
    return { cleanText: cleanText || text, actionJson: obj }
  }

  // Priority 2: bare JSON object containing an "action" key anywhere in the text
  const bare = text.match(/\{[^{}]*"action"\s*:[^{}]*\}/)
  if (bare) {
    const obj = tryParse(bare[0])
    if (obj) {
      const cleanText = (text.slice(0, bare.index) + text.slice((bare.index ?? 0) + bare[0].length)).trimEnd()
      return { cleanText: cleanText || text, actionJson: obj }
    }
  }

  return { cleanText: text, actionJson: null }
}

// Map a parsed action object to an ActionIntent (guardian-only for now — no user funds moved).
// IMPORTANT: the model's job is to signal *whether* to act, not to supply numbers.
// riskScore and policyState always come from our live engine — never from actionJson.
function buildGuardianIntent(
  actionJson: Record<string, unknown>,
  riskScore: number,           // live value from useRiskEngine — NOT from the model
  policyState: { risk_score: number } | null,
): ActionIntent | null {
  if (actionJson.action === "update_risk_score") {
    // Discard actionJson.score — our engine owns this number.
    const score = riskScore
    const prev  = policyState?.risk_score ?? score
    return {
      protocol:      "RiskGuardian · Sui Testnet",
      action:        "Update Risk Score",
      amount:        score,
      asset:         "score points",
      effectOnScore: score - prev,
      gasEstimate:   "~0.005 SUI",
      buildTx: () => {
        const tx = new Transaction()
        tx.moveCall({
          target: `${RISK_GUARDIAN.PACKAGE_ID}::${RISK_GUARDIAN.MODULE}::update_risk_score`,
          arguments: [
            tx.object(RISK_GUARDIAN.POLICY_ID),
            tx.pure.u64(score),
            tx.object(RISK_GUARDIAN.CLOCK),
          ],
        })
        return tx
      },
    }
  }
  return null
}

function AIAdvisor({ positions, pools, groqKey, riskAssessment, policyState, protocolPositions, onStageChange, onIntentSuccess }: any) {
  const hasPositions = positions.length > 0
  const riskLevel = riskAssessment?.level
  const [messages, setMessages] = useState<{role:"assistant"|"user";text:string;intent?:ActionIntent|null}[]>([
    { role: "assistant", text: hasPositions
        ? `Hello. I'm DeepSense — your AI risk advisor for Sui DeFi. I have visibility into your on-chain positions${riskLevel && riskLevel !== "LOW" ? ` and the live risk engine is showing a ${riskLevel} alert` : ""}. Ask me anything about your portfolio, risk exposure, or market conditions.`
        : "Hello. I'm DeepSense — your AI risk advisor for Sui DeFi. No wallet is connected yet, so I'll provide general DeFi and Sui risk advice. Connect your wallet for personalized portfolio analysis."
    }
  ])
  const [input, setInput] = useState("")
  const [loading, setLoading] = useState(false)
  const [dismissedIntents, setDismissedIntents] = useState<Set<number>>(new Set())
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
    const ra = riskAssessment
    const ps = policyState
    const pp: any[] = protocolPositions ?? []

    const context = `You are DeepSense, an AI risk advisor embedded in a real-time Sui DeFi monitoring dashboard.

## LIVE RISK ENGINE
${ra
  ? `Risk Score: ${ra.score}/100 | Level: ${ra.level}
${ra.reasons.length > 0
  ? `Active risk factors:\n${ra.reasons.map((r: string) => `• ${r}`).join("\n")}`
  : "No elevated risk factors detected."
}`
  : "Risk engine initialising — prices loading."
}

## ON-CHAIN GUARDIAN POLICY
${ps
  ? `Protocol status: ${ps.is_paused ? "PAUSED — AI agent has suspended operations" : "ACTIVE"}
AI agent: ${ps.agent_active ? "Enabled" : "Disabled / revoked"}
Max leverage: ${(ps.max_leverage / 100).toFixed(1)}x | Liquidation threshold: ${(ps.liquidation_threshold / 100).toFixed(1)}%
On-chain risk score: ${ps.risk_score}/100 | Actions taken: ${ps.total_actions} | Budget remaining: ${ps.actions_remaining}/${ps.max_actions}`
  : "Guardian policy not yet loaded."
}

## USER COIN BALANCES (Sui Mainnet)
${hasPositions
  ? positions.map((p: any) =>
      `- ${p.asset}: $${p.size.toFixed(2)} value${p.leverage > 1 ? `, ${p.leverage}x leverage` : ""}${p.health !== null ? `, Health ${p.health}%` : ""}${p.liquidationPrice ? `, Liquidation $${p.liquidationPrice}` : ""}, PnL $${p.pnl.toFixed(2)} (${p.pnlPct.toFixed(1)}%)`
    ).join("\n")
  : "No wallet connected — provide general Sui DeFi advice."
}

## DETECTED ON-CHAIN DEFI POSITIONS (${pp.length} found across protocols)
${pp.length > 0
  ? pp.map((p: any) =>
      `- ${p.protocol} ${p.type} ${p.asset}${p.details?.balance ? ` | balance: ${p.details.balance}` : ""}${p.details?.liquidity ? ` | liquidity: ${p.details.liquidity}` : ""}${p.details?.coinTypeA ? ` | pair: ${p.details.coinTypeA.split("::").pop()}/${(p.details.coinTypeB ?? "").split("::").pop()}` : ""}`
    ).join("\n")
  : "No active DeFi positions detected on-chain."
}

## LIVE MARKET PRICES (DeepBook pools)
${pools.length > 0
  ? pools.map((p: any) =>
      `- ${p.base}/${p.quote}: ${fmt.usd(p.price)} (${fmt.pct(p.change)}), Spread ${p.spread}%`
    ).join("\n")
  : "Market price data loading."
}

Answer grounded in THIS user's specific situation. Reference their actual assets, protocol positions, and risk factors by name. When policy is paused or score is HIGH/CRITICAL, highlight urgency and concrete steps. Be conversational but precise. Keep responses under 200 words. You understand Sui's object model, Move contracts, and DeepBook CLOB mechanics.

## ACTION OUTPUT (optional)
When you are explicitly telling the user to take a specific on-chain action RIGHT NOW — not just mentioning it as a possibility — append this exact block at the very end of your reply, after your prose:
\`\`\`action
{"action":"update_risk_score","reason":"<one sentence why>"}
\`\`\`
Rules:
- Omit entirely for analysis, explanations, or general advice.
- The only supported action is "update_risk_score".
- Do NOT include a "score" field — our system always uses the live engine value (currently ${ra?.score ?? 0}/100). Any score you invent will be ignored.`

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
      const rawReply: string = res.status === 401
        ? "API key not configured. Set GROQ_API_KEY in .env.local or provide a key via the session store."
        : (data.reply || "Unable to respond.")
      const { cleanText, actionJson } = parseActionBlock(rawReply)
      const intent = actionJson ? buildGuardianIntent(actionJson, ra?.score ?? 0, ps) : null
      setMessages(m => [...m, { role: "assistant", text: cleanText, intent }])
    } catch {
      setMessages(m => [...m, { role: "assistant", text: "Connection error. Please retry." }])
    }
    setLoading(false)
  }

  return (
    <Card style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
        <SectionHeader title="AI risk advisor" sub={"Powered by Llama 3.3 · Context-aware · Portfolio-specific"} />
      </div>
      <div style={{
        flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column",
        gap: 12, minHeight: 300, maxHeight: 400,
      }}>
        {messages.map((m: any, i: number) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {/* Message bubble row */}
            <div style={{
              display: "flex", flexDirection: m.role === "user" ? "row-reverse" : "row", gap: 8,
            }}>
              <div style={{
                width: 26, height: 26, borderRadius: "50%", flexShrink: 0,
                background: m.role === "user" ? C.blue : C.border,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: SANS, fontSize: 10, fontWeight: 600,
                color: m.role === "user" ? "#fff" : C.muted,
              }}>{m.role === "user" ? "Y" : "AI"}</div>
              <div style={{
                maxWidth: "82%", padding: "10px 14px", borderRadius: 16,
                background: m.role === "user" ? C.blue : C.surface,
                border: "none",
                fontFamily: SANS, fontSize: 13,
                color: m.role === "user" ? "#fff" : C.text,
                lineHeight: 1.7, whiteSpace: "pre-wrap",
              }}>{m.text}</div>
            </div>
            {/* Inline ActionPreview — shown when AI attaches a guardian intent */}
            {m.role === "assistant" && m.intent && !dismissedIntents.has(i) && (
              <div style={{ marginLeft: 38 }}>
                <ActionPreview
                  intent={m.intent}
                  protocolPositions={protocolPositions ?? []}
                  onCancel={() => setDismissedIntents(prev => new Set([...prev, i]))}
                  onStageChange={onStageChange}
                  onSuccess={(digest: string) => {
                    onIntentSuccess(digest, m.intent.amount)
                    setDismissedIntents(prev => new Set([...prev, i]))
                  }}
                />
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{
              width: 26, height: 26, borderRadius: "50%", background: C.border,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: SANS, fontSize: 10, fontWeight: 600, color: C.muted,
            }}>AI</div>
            <div style={{
              padding: "10px 14px", borderRadius: 16, background: C.surface,
              fontFamily: SANS, fontSize: 13, color: C.muted,
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
              fontFamily: SANS, fontSize: 12, padding: "5px 12px",
              background: C.card, border: `1px solid ${C.border}`,
              color: C.muted, borderRadius: 20, cursor: "pointer",
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
            flex: 1, background: C.card, border: `1px solid ${C.border}`,
            color: C.text, fontFamily: SANS, fontSize: 13, padding: "10px 16px",
            borderRadius: 24, outline: "none",
          }}
        />
        <button onClick={() => send()} disabled={loading || !input.trim()} style={{
          width: 44, height: 44, padding: 0, flexShrink: 0,
          background: loading || !input.trim() ? C.border : C.blue,
          border: "none", borderRadius: "50%",
          cursor: loading || !input.trim() ? "not-allowed" : "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          color: loading || !input.trim() ? C.muted : "#fff",
          fontSize: 18, transition: "background 0.15s",
        }}>→</button>
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
        <SectionHeader title="DeepBook trading" sub={`${pool.base}/${pool.quote} · ${network.toUpperCase()} · Simulated execution`} />
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
    </div>
  )
}


// ─── DYNAMIC RISK EVENTS ──────────────────────────────────────────────────────
function generateRiskEvents(positions: any[]): any[] {
  if (positions.length === 0) return []
  const now = new Date()
  const timeStr = now.toTimeString().slice(0, 8)
  const totalValue = positions.reduce((s: number, p: any) => s + p.size, 0)
  const events: any[] = []

  for (const p of positions) {
    if (p.health !== null && p.health < 60) {
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
  const [launched, setLaunched]     = useState(false)
  const [tab, setTab]               = useState("dashboard")
  const [moreOpen, setMoreOpen]     = useState(false)
  const [network, setNetwork]       = useState("mainnet")
  // ── live wallet state ──
  const currentAccount       = useCurrentAccount()
  const suiClient            = useSuiClient()
  const walletAddr           = currentAccount?.address ?? null
  const isWalletConnected    = !!walletAddr
  // ── computed props passed to child components ──
  const { pools, prices, loading: cgLoading } = useCoinGeckoPrices()
  const { pythPrices, loading: pythLoading, error: pythError } = usePythPrices()

  // Protocol position aggregator — Navi SDK + raw object scan on Sui Mainnet
  const {
    positions: protocolPositions,
    loading: protocolLoading,
    error: protocolError,
    protocolCounts,
  } = useProtocolPositions(walletAddr, "mainnet", prices)

  // Adapt ProtocolPosition[] to the shape expected by PortfolioOverview, PositionTable, etc.
  // usdValue and healthPct are populated by the Navi SDK fetcher; other protocols default
  // to neutral values — no fabricated numbers.
  const positions = protocolPositions.map((p, i) => {
    // healthPct is the Navi ACCOUNT-LEVEL health factor converted to 0-100.
    // null means no health data — do NOT default to 100 (that masks fetch failures
    // and makes every position look healthy when data is unavailable).
    const healthPct = p.details.healthPct != null ? parseInt(p.details.healthPct, 10) : null
    return {
      id:               p.objectId || `pp-${i}`,
      protocol:         p.protocol,
      type:             p.type,
      asset:            p.asset,
      size:             p.usdValue ?? 0,
      collateral:       0,
      leverage:         1,
      entryPrice:       null,
      liquidationPrice: null,
      health:           healthPct,   // null = unknown; never default to 100
      pnl:              0,
      pnlPct:           0,
      pool:             "",
      balStr:           p.details.balance ?? p.details.liquidity ?? null,
    }
  })

  console.log("[DeepSense] Wallet status:", { isWalletConnected, walletAddr, livePositionsCount: positions.length, protocolLoading })
  const riskEvents = generateRiskEvents(positions)

  const [selectedPos, setSelectedPos] = useState<any>(null)
  const [selectedPool, setSelectedPool] = useState<any>(null)
  const [groqKey] = useState("")
  const [demoMode, setDemoMode] = useState(false)
  const [nowMs, setNowMs] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // ── Decision Pipeline state ──
  const [pipelineStage, setPipelineStage]       = useState(-1)
  const [pipelineTxDigest, setPipelineTxDigest] = useState<string | undefined>()
  // ── Action preview (guardian intent) ──
  const [pendingIntent, setPendingIntent]       = useState<ActionIntent | null>(null)
  const prevRiskScore = useRef(-1)
  const prevActionLen = useRef(0)

  // ── Risk Guardian on-chain state ──
  const { policyState, events: guardianEvents, loading: guardianLoading, error: guardianError, refetch: refetchGuardian } = useRiskGuardian()
  const { riskAssessment, actionLog } = useRiskEngine({
    prices: prices ?? {},
    pythPrices,
    policyState,
    enabled: true,
    walletConnected: isWalletConnected,
    demoMode,
  })
  const { mutate: signAndExecute } = useSignAndExecuteTransaction()
  const { mutate: disconnect } = useDisconnectWallet()
  const [walletMenuOpen, setWalletMenuOpen] = useState(false)
  const walletMenuRef = useRef<HTMLDivElement>(null)
  const [copied, setCopied] = useState(false)
  const [txStatus, setTxStatus] = useState<string>("")

  // Close wallet dropdown on outside click
  useEffect(() => {
    if (!walletMenuOpen) return
    function handleClick(e: MouseEvent) {
      if (walletMenuRef.current && !walletMenuRef.current.contains(e.target as Node)) {
        setWalletMenuOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [walletMenuOpen])

  // ── Pipeline effects (declared after riskAssessment / actionLog are in scope) ──
  // Trigger pipeline when score crosses into HIGH/CRITICAL, reset when it drops to LOW
  useEffect(() => {
    if (!riskAssessment) return
    const score = riskAssessment.score
    const prev  = prevRiskScore.current
    prevRiskScore.current = score
    if (score >= 61 && prev < 61) {
      setPipelineStage(0)
      setPipelineTxDigest(undefined)
    } else if (score < 31 && prev >= 31) {
      setPipelineStage(s => s >= 0 && s < 3 ? -1 : s)
      setPipelineTxDigest(d => d)           // preserve digest if already confirmed
    }
  }, [riskAssessment])

  // Auto-advance stage 0 → 1 after a beat (score shown, engine re-computed)
  useEffect(() => {
    if (pipelineStage !== 0) return
    const t = setTimeout(() => setPipelineStage(s => s === 0 ? 1 : s), 1100)
    return () => clearTimeout(t)
  }, [pipelineStage])

  // Advance to stage 2 when a new action appears in the action log
  useEffect(() => {
    if (actionLog.length > prevActionLen.current) {
      prevActionLen.current = actionLog.length
      setPipelineStage(s => (s === 0 || s === 1) ? 2 : s)
    }
  }, [actionLog.length])

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
  const isCritical = riskAssessment?.level === "CRITICAL"

  if (!launched) return <Landing onLaunch={() => setLaunched(true)} />

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text }}>
      {/* Critical viewport glow — fixed overlay, pointer-events:none, fades in/out */}
      <div style={{
        position: "fixed", inset: 0, pointerEvents: "none", zIndex: 9999,
        opacity: isCritical ? 1 : 0,
        transition: "opacity 1.6s ease",
      }}>
        <div style={{
          position: "absolute", inset: 0,
          animation: "critical-pulse 2.8s ease-in-out infinite",
        }} />
      </div>

      {/* Header */}
      <div style={{
        borderBottom: `1px solid ${C.border}`,
        background: C.card, display: "flex", alignItems: "center",
        padding: "0 24px", gap: 0, minWidth: 0, height: 56,
      }}>
        {/* Logo — click to return to landing */}
        <div onClick={() => setLaunched(false)} style={{
          display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
          paddingRight: 20, marginRight: 12, borderRight: `1px solid ${C.border}`,
          cursor: "pointer", opacity: 1, transition: "opacity 0.15s",
        }}
          onMouseEnter={e => (e.currentTarget.style.opacity = "0.72")}
          onMouseLeave={e => (e.currentTarget.style.opacity = "1")}
        >
          <div style={{
            width: 28, height: 28, borderRadius: 5, background: C.blue,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: MONO, fontSize: 11, fontWeight: 700, color: "#fff", letterSpacing: 0.5,
          }}>DS</div>
          <span style={{ fontFamily: SANS, fontSize: 15, fontWeight: 700, color: C.text }}>DeepSense</span>
        </div>
        {/* Primary pill tabs */}
        <div style={{ display: "flex", alignItems: "center", gap: 2, padding: "0 12px", flexShrink: 0 }}>
          {[
            { id: "dashboard", label: "Dashboard" },
            { id: "advisor",   label: "AI advisor" },
            { id: "simulator", label: "Simulator"  },
            { id: "positions", label: "Positions"  },
          ].map(t => (
            <button key={t.id} onClick={() => { setTab(t.id); setMoreOpen(false) }} style={{
              fontFamily: SANS, fontSize: 13, fontWeight: tab === t.id ? 600 : 400,
              padding: "6px 14px", borderRadius: 20, cursor: "pointer",
              background: tab === t.id ? C.card : "transparent",
              border: `1px solid ${tab === t.id ? C.border : "transparent"}`,
              color: tab === t.id ? C.text : C.muted,
              boxShadow: tab === t.id ? "0 1px 3px rgba(16,24,40,0.06)" : "none",
              transition: "all 0.15s",
            }}>{t.label}</button>
          ))}
        </div>
        {/* Spacer */}
        <div style={{ flex: 1 }} />
        {/* Wallet pill + net badge */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <NetBadge phase={network} />
          {isWalletConnected ? (
            <div ref={walletMenuRef} style={{ position: "relative" }}>
              <button onClick={() => setWalletMenuOpen(o => !o)} style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                background: C.card, border: `1px solid ${walletMenuOpen ? C.borderHi : C.border}`,
                borderRadius: 20, padding: "5px 12px",
                cursor: "pointer", transition: "border-color 0.15s",
              }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: C.safe, flexShrink: 0 }} />
                <span style={{ fontFamily: MONO, fontSize: 11, color: C.text }}>{fmt.addr(walletAddr ?? undefined)}</span>
                <span style={{ fontFamily: SANS, fontSize: 10, color: C.muted, marginLeft: 2 }}>▾</span>
              </button>
              {walletMenuOpen && (
                <div style={{
                  position: "absolute", top: "calc(100% + 8px)", right: 0,
                  background: C.card, border: `1px solid ${C.border}`,
                  borderRadius: 8, minWidth: 220,
                  boxShadow: "0 4px 16px rgba(16,24,40,0.10)",
                  zIndex: 1000, overflow: "hidden",
                }}>
                  {/* Address row */}
                  <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.border}` }}>
                    <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted, marginBottom: 4 }}>Connected wallet</div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ fontFamily: MONO, fontSize: 11, color: C.text, wordBreak: "break-all" }}>
                        {walletAddr ? `${walletAddr.slice(0, 10)}…${walletAddr.slice(-8)}` : "—"}
                      </span>
                      <button onClick={() => {
                        if (walletAddr) {
                          navigator.clipboard.writeText(walletAddr)
                          setCopied(true)
                          setTimeout(() => setCopied(false), 1500)
                        }
                      }} style={{
                        fontFamily: SANS, fontSize: 11, padding: "3px 8px", flexShrink: 0,
                        background: copied ? C.safe + "18" : C.surface,
                        border: `1px solid ${copied ? C.safe + "44" : C.border}`,
                        color: copied ? C.safe : C.muted,
                        borderRadius: 4, cursor: "pointer", transition: "all 0.15s",
                      }}>{copied ? "Copied" : "Copy"}</button>
                    </div>
                  </div>
                  {/* Disconnect */}
                  <button onClick={() => { disconnect(); setWalletMenuOpen(false) }} style={{
                    width: "100%", padding: "11px 14px", textAlign: "left",
                    fontFamily: SANS, fontSize: 13, fontWeight: 500,
                    color: C.danger, background: "transparent", border: "none",
                    cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
                    transition: "background 0.12s",
                  }}
                    onMouseEnter={e => (e.currentTarget.style.background = C.danger + "0a")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                  >
                    <span style={{ fontSize: 14 }}>⏻</span> Disconnect
                  </button>
                </div>
              )}
            </div>
          ) : (
            <DappConnectButton
              connectText="Connect wallet"
              style={{
                fontFamily: SANS, fontSize: 13, padding: "7px 16px",
                background: C.blue, border: `1px solid ${C.blue}`,
                color: "#fff", borderRadius: 6, cursor: "pointer", fontWeight: 600,
              } as any}
            />
          )}
        </div>
      </div>

      {/* Ticker */}
      <LiveTicker pools={pools} />

      {/* API key bar hidden — key read from GROQ_API_KEY env var server-side */}

      {/* ─── STATUS BANNER ─────────────────────────────────────────────────────── */}
      {(() => {
        const lvl   = riskAssessment?.level
        const score = riskAssessment?.score ?? 0
        const dot   = riskLevelColor(lvl)
        const lastAction = actionLog[0]?.timestamp
        return (
          <div style={{
            background: C.surface,
            borderBottom: `1px solid ${C.border}`,
            padding: "0 24px",
            minHeight: 34,
            display: "flex", alignItems: "center", gap: 0,
            fontSize: 10, fontFamily: MONO,
            overflowX: "auto", whiteSpace: "nowrap",
            scrollbarWidth: "none",
          }}>
            {/* Live dot — breathes gently always, faster when elevated */}
            <span style={{
              display: "inline-block", width: 7, height: 7, borderRadius: "50%",
              background: dot,
              flexShrink: 0, marginRight: 14,
              animation: `dot-breathe ${score >= 86 ? 1.4 : score >= 61 ? 2 : 3.5}s ease-in-out infinite`,
            }} />

            {/* Positions */}
            <span style={{ fontFamily: SANS, color: C.muted, marginRight: 5 }}>Monitoring</span>
            <span style={{ fontFamily: MONO, color: C.text, marginRight: 14 }}>{positions.length} position{positions.length !== 1 ? "s" : ""}</span>

            <span style={{ color: C.border, marginRight: 14, userSelect: "none" }}>│</span>

            {/* Risk score + level — number pops when score changes */}
            <span style={{ fontFamily: SANS, color: C.muted, marginRight: 5 }}>Risk</span>
            <span key={score} className="ds-num-pop" style={{ fontFamily: MONO, color: dot, marginRight: 3 }}>{score}</span>
            <span style={{ fontFamily: MONO, color: C.muted, marginRight: 5 }}>/100</span>
            <span key={lvl} style={{
              color: dot, letterSpacing: 1,
              padding: "1px 6px",
              border: `1px solid ${dot}44`,
              borderRadius: 2,
              background: dot + "10",
              marginRight: 14,
              fontSize: 9,
              transition: "color 0.6s ease, border-color 0.6s ease, background 0.6s ease",
            }}>{lvl ?? "—"}</span>

            <span style={{ color: C.border, marginRight: 14, userSelect: "none" }}>│</span>

            {/* Last AI action */}
            <span style={{ fontFamily: SANS, color: C.muted, marginRight: 5 }}>Last AI action</span>
            <span style={{ color: lastAction ? C.text : C.muted }}>{fmtAgo(lastAction, nowMs)}</span>

            {/* Spacer */}
            <div style={{ flex: 1 }} />

            {/* Demo indicator — repeat here so it's visible on all tabs */}
            {demoMode && (
              <span style={{
                color: C.danger, letterSpacing: 2, fontSize: 9,
                animation: "pulse 1.4s ease-in-out infinite",
              }}>● CRASH SIM ACTIVE</span>
            )}
          </div>
        )
      })()}

      {/* ─── MAIN CONTENT ─────────────────────────────────────────────────────── */}
      <div className="ds-tab-content" style={{ padding: "20px 24px" }} key={tab}>

        {/* DASHBOARD TAB */}
        {tab === "dashboard" && (
          <>
            {/* ── Score bar centerpiece ── */}
            <ScoreBar
              score={riskAssessment?.score ?? 0}
              level={riskAssessment?.level}
              demoMode={demoMode}
              onToggleDemo={() => setDemoMode(d => !d)}
            />

            {/* ── Risk factors list ── */}
            {(() => {
              const reasons = riskAssessment?.reasons ?? []
              const color   = riskLevelColor(riskAssessment?.level)
              const hasFacts = reasons.length > 0
              return (
                <div style={{ maxWidth: 540, margin: "0 auto 24px" }}>
                  {hasFacts ? (
                    <div style={{
                      background: C.card,
                      border: `1px solid ${color}30`,
                      borderRadius: 6,
                      overflow: "hidden",
                    }}>
                      {/* Header */}
                      <div style={{
                        padding: "8px 14px",
                        borderBottom: `1px solid ${C.border}`,
                        display: "flex", alignItems: "center", gap: 8,
                      }}>
                        <span style={{ color: color, fontSize: 11 }}>⚠</span>
                        <span style={{ fontFamily: MONO, fontSize: 9, color: color, letterSpacing: 3 }}>FLAGGED FACTORS</span>
                        <span style={{ fontFamily: MONO, fontSize: 9, color: C.muted }}>·</span>
                        <span style={{ fontFamily: MONO, fontSize: 9, color: C.muted }}>{reasons.length} active</span>
                      </div>
                      {/* Reasons */}
                      {reasons.map((reason, i) => (
                        <div key={i} style={{
                          display: "flex", alignItems: "center", gap: 10,
                          padding: "9px 14px",
                          borderBottom: i < reasons.length - 1 ? `1px solid ${C.border}` : "none",
                        }}>
                          <span style={{
                            display: "inline-block", width: 18, height: 18, flexShrink: 0,
                            borderRadius: "50%", background: color + "18",
                            border: `1px solid ${color}40`,
                            color, fontSize: 9, fontFamily: MONO, fontWeight: 700,
                            textAlign: "center", lineHeight: "18px",
                          }}>!</span>
                          <span style={{ fontFamily: SANS, fontSize: 12, color: C.text, lineHeight: 1.4 }}>{reason}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{
                      background: C.card,
                      border: `1px solid ${C.safe}22`,
                      borderRadius: 6,
                      padding: "11px 16px",
                      display: "flex", alignItems: "center", gap: 12,
                    }}>
                      <span style={{
                        display: "inline-block", width: 22, height: 22, flexShrink: 0,
                        borderRadius: "50%", background: C.safe + "18",
                        border: `1px solid ${C.safe}44`,
                        color: C.safe, fontSize: 12, textAlign: "center", lineHeight: "22px",
                      }}>✓</span>
                      <div>
                        <span style={{ fontFamily: MONO, fontSize: 11, color: C.safe }}>All clear</span>
                        <span style={{ fontFamily: SANS, fontSize: 11, color: C.muted, marginLeft: 8 }}>
                          No elevated risk factors detected
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )
            })()}

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
                <div className="ds-feature-grid">
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
                  } as any}
                />
                <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted, marginTop: 14 }}>
                  Supports Sui Wallet, Suiet, Martian and other dapp-kit compatible wallets
                </div>
              </Card>
            ) : (
              /* ── Portfolio view when wallet connected ── */
              <>
                {/* Errors surface here — never a blank screen */}
                {protocolError && (
                  <ErrorBanner message={`Position scan error: ${protocolError}`} />
                )}
                {pythError && !pythLoading && (
                  <ErrorBanner message={`Pyth oracle unavailable — prices may be stale: ${pythError}`} />
                )}
                {/* Skeleton metric cards while positions load */}
                {protocolLoading && positions.length === 0 ? (
                  <>
                    <div className="ds-metric-grid" style={{ marginBottom: 16 }}>
                      {[1,2,3,4].map(i => <SkeletonCard key={i} lines={2} />)}
                    </div>
                    <Card style={{ padding: "16px 18px", marginBottom: 14 }}>
                      <Skeleton h={10} w="30%" style={{ marginBottom: 14 }} />
                      {[1,2,3].map(i => (
                        <div key={i} style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center" }}>
                          <Skeleton h={12} w={48} style={{ flexShrink: 0 }} />
                          <Skeleton h={12} w="60%" />
                          <Skeleton h={12} w="15%" />
                        </div>
                      ))}
                    </Card>
                  </>
                ) : (
                  <>
                    <PortfolioOverview positions={positions} walletConnected={isWalletConnected} />
                    {positions.length === 0 && !protocolError && (
                      <Card style={{ padding: "20px 24px", marginBottom: 14, border: `1px solid ${C.safe}22` }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                          <span style={{
                            width: 32, height: 32, borderRadius: "50%", flexShrink: 0,
                            background: C.safe + "18", border: `1px solid ${C.safe}44`,
                            display: "flex", alignItems: "center", justifyContent: "center",
                            color: C.safe, fontSize: 14,
                          }}>✓</span>
                          <div>
                            <div style={{ fontFamily: MONO, fontSize: 11, color: C.safe, marginBottom: 3 }}>
                              WALLET CONNECTED · {fmt.addr(walletAddr)}
                            </div>
                            <div style={{ fontFamily: SANS, fontSize: 12, color: C.muted }}>
                              No DeFi positions found on this wallet on Sui Mainnet yet.
                            </div>
                          </div>
                        </div>
                      </Card>
                    )}
                  </>
                )}
              </>
            )}
            <div className="ds-side-grid">
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
                      <span style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: C.text, display: "block", marginBottom: 3 }}>Protocol coverage</span>
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
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.accent, display: "inline-block", animation: "dot-breathe 1.4s ease-in-out infinite" }} />
                <span style={{ fontFamily: MONO, fontSize: 10, color: C.accent, letterSpacing: 2 }}>READING ON-CHAIN STATE…</span>
                <span style={{ fontFamily: SANS, fontSize: 11, color: C.muted }}>Querying Sui Testnet · RiskGuardian contract</span>
              </div>
              <div className="ds-metric-grid" style={{ marginBottom: 0 }}>
                {[1,2,3,4].map(i => <SkeletonCard key={i} lines={2} />)}
              </div>
              <SkeletonCard lines={3} style={{ padding: "18px" }} />
              <div className="ds-side-grid">
                <SkeletonCard lines={5} />
                <SkeletonCard lines={4} />
              </div>
            </div>
          )

          if (guardianError) return (
            <div>
              <ErrorBanner message={`RiskGuardian contract error: ${guardianError}`} onRetry={refetchGuardian} />
              <Card style={{ padding: "32px 24px", textAlign: "center", border: `1px solid ${C.border}` }}>
                <div style={{ fontFamily: MONO, fontSize: 24, color: C.muted, marginBottom: 12 }}>⛓</div>
                <div style={{ fontFamily: MONO, fontSize: 12, color: C.muted, marginBottom: 6 }}>Could not reach the RiskGuardian contract</div>
                <div style={{ fontFamily: SANS, fontSize: 12, color: C.muted }}>
                  Check your network connection or try switching between Mainnet and Testnet above.
                </div>
              </Card>
            </div>
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
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.warn, display: "inline-block" }} />
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

              {/* Decision Pipeline */}
              <DecisionPipeline stage={pipelineStage} txDigest={pipelineTxDigest} />

              {/* Action Preview — shown when user hits PREVIEW INTENT */}
              {pendingIntent && (
                <ActionPreview
                  intent={pendingIntent}
                  protocolPositions={protocolPositions}
                  onCancel={() => setPendingIntent(null)}
                  onStageChange={setPipelineStage}
                  onSuccess={(digest) => {
                    setPipelineTxDigest(digest)
                    setTxMsg(`✓ Risk score synced to ${pendingIntent.amount}`)
                    setTimeout(refetchGuardian, 2000)
                    setTimeout(() => {
                      setPipelineStage(-1)
                      setPipelineTxDigest(undefined)
                      setPendingIntent(null)
                    }, 25_000)
                  }}
                />
              )}

              {/* AI RISK ENGINE panel */}
              <Card style={{ border: `1px solid ${C.accent}33`, background: C.accent+"05" }}>
                <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: "50%", background: C.safe,
                      display: "inline-block",
                      animation: "dot-breathe 2.4s ease-in-out infinite",
                    }} />
                    <span style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: C.text }}>AI risk engine</span>
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
                            animation: riskAssessment.level === "CRITICAL" ? "dot-breathe 1.4s ease-in-out infinite" : "none",
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
                    <span style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: C.text, display: "block", marginBottom: 3 }}>Oracle feeds</span>
                    <span style={{ fontFamily: SANS, fontSize: 12, color: C.mutedHi }}>Pyth Network · 10s refresh · real-time confidence bands</span>
                  </div>
                  <Tag color={pythLoading ? C.muted : C.safe}>{pythLoading ? "FETCHING" : "LIVE"}</Tag>
                </div>
                <div className="ds-scroll-row"><div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 0, minWidth: 480 }}>
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
                </div></div>{/* end ds-scroll-row */}
              </Card>

              {/* PENDING ACTIONS */}
              {actionLog.length > 0 && (
                <Card style={{ border: `1px solid ${C.gold}33` }}>
                  <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <span style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: C.gold, display: "block", marginBottom: 3 }}>Pending agent actions</span>
                      <span style={{ fontFamily: SANS, fontSize: 12, color: C.mutedHi }}>AI recommendations awaiting on-chain sync</span>
                    </div>
                    <button
                      onClick={() => {
                        if (!riskAssessment) return
                        const score = riskAssessment.score
                        const prevScore = policyState?.risk_score ?? score
                        setPendingIntent({
                          protocol:      "RiskGuardian · Sui Testnet",
                          action:        "Update Risk Score",
                          amount:        score,
                          asset:         "score points",
                          effectOnScore: score - prevScore,
                          gasEstimate:   "~0.005 SUI",
                          buildTx: () => {
                            const tx = new Transaction()
                            tx.moveCall({
                              target: `${RISK_GUARDIAN.PACKAGE_ID}::${RISK_GUARDIAN.MODULE}::update_risk_score`,
                              arguments: [
                                tx.object(RISK_GUARDIAN.POLICY_ID),
                                tx.pure.u64(score),
                                tx.object(RISK_GUARDIAN.CLOCK),
                              ],
                            })
                            return tx
                          },
                        })
                      }}
                      style={{
                        fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: 2,
                        padding: "8px 18px", borderRadius: 4, cursor: "pointer",
                        background: C.gold+"22", border: `1px solid ${C.gold}66`,
                        color: C.gold,
                      }}
                    >PREVIEW INTENT →</button>
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
              <div className="ds-metric-grid" style={{ marginBottom: 0 }}>
                {/* Risk Score */}
                <Card style={{ padding: "16px 18px" }}>
                  <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted, marginBottom: 8 }}>Risk score</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
                    <Glow color={riskScoreColor(policyState.risk_score)} size={32} weight={700}>{policyState.risk_score}</Glow>
                    <span style={{ fontFamily: MONO, fontSize: 14, color: C.muted }}>/100</span>
                  </div>
                  <div style={{ marginTop: 8, height: 4, background: C.border, borderRadius: 2, overflow: "hidden" }}>
                    <div style={{
                      height: "100%", width: `${policyState.risk_score}%`,
                      background: riskScoreColor(policyState.risk_score),
                      transition: "width 0.6s ease", borderRadius: 2,
                    }} />
                  </div>
                  <div style={{ fontFamily: SANS, fontSize: 11, color: C.mutedHi, marginTop: 6 }}>
                    {policyState.risk_score <= 40 ? "Low risk" : policyState.risk_score <= 70 ? "Elevated risk" : "Critical — action needed"}
                  </div>
                </Card>

                {/* Protocol Status */}
                <Card style={{ padding: "16px 18px", border: `1px solid ${policyState.is_paused ? C.danger+"44" : C.border}`, background: policyState.is_paused ? C.danger+"08" : C.card }}>
                  <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted, marginBottom: 8 }}>Protocol status</div>
                  <Glow color={policyState.is_paused ? C.danger : C.safe} size={22} weight={700}>
                    {policyState.is_paused ? "PAUSED" : "ACTIVE"}
                  </Glow>
                  <div style={{ fontFamily: SANS, fontSize: 11, color: C.mutedHi, marginTop: 6 }}>
                    {policyState.is_paused ? "AI agent triggered pause" : "Protocol operating normally"}
                  </div>
                </Card>

                {/* Max Leverage */}
                <Card style={{ padding: "16px 18px" }}>
                  <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted, marginBottom: 8 }}>Max leverage</div>
                  <Glow color={C.gold} size={28} weight={700}>{(policyState.max_leverage / 100).toFixed(0)}x</Glow>
                  <div style={{ fontFamily: SANS, fontSize: 11, color: C.mutedHi, marginTop: 6 }}>{policyState.max_leverage}bp on-chain</div>
                </Card>

                {/* Liquidation Threshold */}
                <Card style={{ padding: "16px 18px" }}>
                  <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted, marginBottom: 8 }}>Liquidation threshold</div>
                  <Glow color={C.blue} size={28} weight={700}>{(policyState.liquidation_threshold / 100).toFixed(0)}%</Glow>
                  <div style={{ fontFamily: SANS, fontSize: 11, color: C.mutedHi, marginTop: 6 }}>{policyState.liquidation_threshold}bp on-chain</div>
                </Card>
              </div>

              {/* Section B — Agent Info */}
              <Card style={{ padding: "14px 18px" }}>
                <div style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 12 }}>AI agent status</div>
                <div className="ds-metric-grid" style={{ marginBottom: 0, gap: 16 }}>
                  <div>
                    <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted, marginBottom: 5 }}>Agent address</div>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: C.accent }}>{fmt.addr(policyState.agent)}</span>
                  </div>
                  <div>
                    <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted, marginBottom: 5 }}>Agent status</div>
                    <Tag color={policyState.agent_active ? C.safe : C.danger}>{policyState.agent_active ? "ACTIVE" : "REVOKED"}</Tag>
                  </div>
                  <div>
                    <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted, marginBottom: 5 }}>Actions remaining</div>
                    <Glow color={policyState.actions_remaining < 10 ? C.warn : C.text} size={14} weight={700}>
                      {policyState.actions_remaining}/{policyState.max_actions}
                    </Glow>
                  </div>
                  <div>
                    <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted, marginBottom: 5 }}>Total actions taken</div>
                    <Glow color={C.text} size={14} weight={700}>{policyState.total_actions}</Glow>
                  </div>
                </div>
              </Card>

              <div className="ds-side-grid">
                {/* Section C — Event Log */}
                <Card>
                  <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}` }}>
                    <SectionHeader
                      title="On-chain audit log"
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
                            borderRadius: 2, flexShrink: 0,
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
                    <SectionHeader title="Admin controls" sub="Human override · DAO governance" />
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
                        color: C.safe,
                      }}>RESUME PROTOCOL</button>
                    )}

                    <button onClick={handleRevokeAgent} disabled={!policyState.agent_active} style={{
                      padding: "11px 14px", fontFamily: MONO, fontSize: 11, fontWeight: 700,
                      letterSpacing: 2, borderRadius: 4, cursor: policyState.agent_active ? "pointer" : "not-allowed",
                      background: C.danger+"18", border: `1px solid ${C.danger}66`,
                      color: policyState.agent_active ? C.danger : C.muted,
                      opacity: policyState.agent_active ? 1 : 0.4,
                    }}>REVOKE AGENT</button>

                    <button onClick={handleResetBudget} style={{
                      padding: "11px 14px", fontFamily: MONO, fontSize: 11, fontWeight: 700,
                      letterSpacing: 2, borderRadius: 4, cursor: "pointer",
                      background: C.gold+"18", border: `1px solid ${C.gold}66`,
                      color: C.gold,
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
                      color: C.gold,
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
                            color: C.gold,
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
          <div className="ds-side-grid">
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <PortfolioOverview positions={positions} walletConnected={isWalletConnected} />

              {/* Wallet Balances section */}
              <PositionTable positions={positions} onSelect={setSelectedPos} selected={selectedPos} walletConnected={isWalletConnected} />

              {/* Protocol Positions section */}
              <Card>
                <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                      <span style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: C.text }}>Protocol positions</span>
                      <span style={{
                        fontFamily: MONO, fontSize: 8, letterSpacing: 2,
                        padding: "2px 7px", borderRadius: 2,
                        border: `1px solid ${C.safe}44`, color: C.safe,
                        background: C.safe + "0d",
                      }}>LIVE MAINNET</span>
                    </div>
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
                            <div style={{ width: 6, height: 6, borderRadius: "50%", background: protoColor }} />
                            <span style={{ fontFamily: SANS, fontSize: 12, fontWeight: 600, color: C.text }}>{proto}</span>
                            <span style={{
                              fontFamily: SANS, fontSize: 11, color: protoColor,
                              background: protoColor + "14", border: `1px solid ${protoColor}33`,
                              padding: "1px 8px", borderRadius: 20,
                            }}>{items.length}</span>
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
                                <div>
                                  <div style={{ fontFamily: SANS, fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 2 }}>{pos.asset}</div>
                                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <span style={{ fontFamily: SANS, fontSize: 11, color: C.muted }}>{pos.type}</span>
                                    {valueLabel && (
                                      <span style={{ fontFamily: MONO, fontSize: 11, color: C.muted }}>· {valueLabel}</span>
                                    )}
                                  </div>
                                </div>
                                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                                  <span style={{ fontFamily: MONO, fontSize: 10, color: C.muted }}>
                                    {pos.objectId.slice(0, 10)}…
                                  </span>
                                  <a
                                    href={`https://suiscan.xyz/${network}/object/${pos.objectId}`}
                                    target="_blank" rel="noopener noreferrer"
                                    style={{ fontFamily: SANS, fontSize: 12, color: C.blue, textDecoration: "none" }}
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
              <AIAdvisor positions={positions} pools={pools} groqKey={groqKey} riskAssessment={riskAssessment} policyState={policyState} protocolPositions={protocolPositions}
                onStageChange={setPipelineStage}
                onIntentSuccess={(digest: string, score: number) => {
                  setPipelineTxDigest(digest)
                  setTxMsg(`✓ Risk score synced to ${score}`)
                  setTimeout(refetchGuardian, 2000)
                  setTimeout(() => { setPipelineStage(-1); setPipelineTxDigest(undefined) }, 25_000)
                }}
              />
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
            <div className="ds-side-grid">
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <DeepBookPanel selectedPool={selectedPool} />
                {selectedPool && (
                  <Card style={{ padding: 16 }}>
                    <SectionHeader title="Pool statistics" sub={`${selectedPool.base}/${selectedPool.quote} · DeepBook CLOB · Simulated`} />
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

        {/* INTENT ENGINE TAB */}
        {tab === "intent" && (
          <IntentEngine
            protocolPositions={protocolPositions}
            riskAssessment={riskAssessment}
          />
        )}

        {/* AI ADVISOR TAB */}
        {tab === "advisor" && (
          <div className="ds-side-grid">
            <AIAdvisor positions={positions} pools={pools} groqKey={groqKey} riskAssessment={riskAssessment} policyState={policyState} protocolPositions={protocolPositions}
              onStageChange={setPipelineStage}
              onIntentSuccess={(digest: string, score: number) => {
                setPipelineTxDigest(digest)
                setTxMsg(`✓ Risk score synced to ${score}`)
                setTimeout(refetchGuardian, 2000)
                setTimeout(() => { setPipelineStage(-1); setPipelineTxDigest(undefined) }, 25_000)
              }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <RiskFeed events={riskEvents} walletConnected={isWalletConnected} />
              {positions.length > 0 && (
                <Card style={{ padding: 16 }}>
                  <SectionHeader title="Position health" />
                  {positions.map(p => (
                    <div key={p.id} style={{ marginBottom: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <span style={{ fontFamily: SANS, fontSize: 12, color: C.text }}>{p.asset}</span>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <Tag color={p.type === "SHORT" ? C.danger : p.type === "LONG" ? C.safe : p.type === "LP" ? C.gold : C.blue}>{p.type}</Tag>
                          {p.health !== null
                            ? <Glow color={healthColor(p.health)} size={12}>{p.health}%</Glow>
                            : <span style={{ fontFamily: SANS, fontSize: 11, color: C.muted }}>—</span>}
                        </div>
                      </div>
                      {p.health !== null && <HealthBar value={p.health} />}
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
                  <SectionHeader title="Position health" />
                  {positions.map(p => (
                    <div key={p.id} style={{ marginBottom: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <span style={{ fontFamily: SANS, fontSize: 12, color: C.text }}>{p.asset}</span>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <Tag color={p.type === "SHORT" ? C.danger : p.type === "LONG" ? C.safe : p.type === "LP" ? C.gold : C.blue}>{p.type}</Tag>
                          {p.health !== null
                            ? <Glow color={healthColor(p.health)} size={12}>{p.health}%</Glow>
                            : <span style={{ fontFamily: SANS, fontSize: 11, color: C.muted }}>—</span>}
                        </div>
                      </div>
                      {p.health !== null && <HealthBar value={p.health} />}
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
              <SectionHeader title="Tech architecture" sub="Sui + DeepBook integration stack" />
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
