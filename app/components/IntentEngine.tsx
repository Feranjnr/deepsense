"use client"

import { useState, useRef } from "react"
import { Transaction } from "@mysten/sui/transactions"
import { useSignAndExecuteTransaction, useCurrentAccount, useSuiClient } from "@mysten/dapp-kit"
import type { ProtocolPosition } from "../hooks/useProtocolPositions"

// ─── Theme ───────────────────────────────────────────────────────────────────
const MONO = "'IBM Plex Mono','Courier New',monospace"
const SANS = "'IBM Plex Sans',system-ui,sans-serif"
const C = {
  bg:       "#03080f",
  card:     "#08111c",
  surface:  "#060d16",
  border:   "#0e2035",
  borderHi: "#1a3d5c",
  accent:   "#0af5d4",
  blue:     "#0a7fff",
  gold:     "#f5c842",
  danger:   "#ff4567",
  warn:     "#ff9900",
  safe:     "#00e676",
  text:     "#d0e8f0",
  muted:    "#3a5a70",
  mutedHi:  "#5a7a90",
}

// ─── Types ────────────────────────────────────────────────────────────────────
type ParsedAction = {
  action: "supply" | "borrow" | "withdraw" | "repay" | "unknown"
  asset: string
  amount: number
  protocol: "navi"
  reason: string
  error?: string
}

type RiskCard = {
  title: string
  level: "SAFE" | "WARN" | "DANGER"
  headline: string
  details: string[]
}

// Map user-facing asset names to navi-sdk pool keys
const ASSET_TO_POOL_KEY: Record<string, string> = {
  SUI:   "Sui",
  USDC:  "nUSDC",
  USDT:  "USDT",
  WETH:  "WETH",
  ETH:   "WETH",
  WBTC:  "WBTC",
  BTC:   "WBTC",
  CETUS: "CETUS",
  DEEP:  "DEEP",
  NAVX:  "NAVX",
  BLUE:  "BLUE",
  WAL:   "WAL",
  WSOL:  "WSOL",
  BUCK:  "BUCK",
}

// Decimals for amount→raw conversion (Navi normalises all to 9 internally, but
// we need the token's native decimals to present the right human-readable amount
// and to split/merge coins correctly for non-SUI tokens).
const TOKEN_DECIMALS: Record<string, number> = {
  SUI: 9, NAVX: 9, CETUS: 9, BLUE: 9, WAL: 9, BUCK: 9,
  USDC: 6, USDT: 6, DEEP: 6,
  WETH: 8, WBTC: 8, WSOL: 8,
}

function toRaw(amount: number, asset: string): number {
  const dec = TOKEN_DECIMALS[asset.toUpperCase()] ?? 9
  return Math.floor(amount * Math.pow(10, dec))
}

// ─── Risk card computation ────────────────────────────────────────────────────

function healthFactorCard(parsed: ParsedAction, protocolPositions: ProtocolPosition[]): RiskCard {
  const naviPos = protocolPositions.find(p => p.protocol === "Navi Protocol")
  const currentHF: number | null = naviPos?.healthFactor ?? null
  const supplies = protocolPositions.filter(p => p.protocol === "Navi Protocol" && p.type === "LEND")
  const borrows  = protocolPositions.filter(p => p.protocol === "Navi Protocol" && p.type === "BORROW")
  const hasBorrows = borrows.length > 0

  if (parsed.action === "supply") {
    const level = "SAFE"
    const hfLine = currentHF != null ? `Current health factor: ${currentHF.toFixed(2)}` : "No active borrow position"
    return {
      title: "HEALTH FACTOR RISK",
      level,
      headline: hasBorrows ? "Collateral increases — HF will improve ↑" : "Pure collateral deposit — no liquidation risk",
      details: [
        hfLine,
        `${parsed.amount} ${parsed.asset} added to collateral`,
        "Liquidation threshold moves further away",
      ],
    }
  }

  if (parsed.action === "borrow") {
    if (supplies.length === 0) {
      return {
        title: "HEALTH FACTOR RISK",
        level: "DANGER",
        headline: "No collateral detected — cannot borrow",
        details: [
          "Supply collateral first before borrowing",
          "Navi requires collateral to issue loans",
          "Tip: try 'supply X SUI to Navi' first",
        ],
      }
    }
    const level = currentHF != null && currentHF < 1.5 ? "DANGER" : currentHF != null && currentHF < 2.5 ? "WARN" : "SAFE"
    const hfLine = currentHF != null ? `Current health factor: ${currentHF.toFixed(2)}` : "Health factor unknown"
    return {
      title: "HEALTH FACTOR RISK",
      level,
      headline: level === "DANGER"
        ? "Health factor already low — borrowing is risky"
        : level === "WARN"
        ? "Health factor moderate — monitor closely after borrow"
        : "Health factor healthy — borrow proceeds safely",
      details: [
        hfLine,
        `Borrowing ${parsed.amount} ${parsed.asset} increases debt`,
        level !== "SAFE" ? "Consider repaying existing debt first" : "Ensure price feeds remain stable",
      ],
    }
  }

  if (parsed.action === "withdraw") {
    const level = currentHF != null && currentHF < 2.0 ? "WARN" : "SAFE"
    return {
      title: "HEALTH FACTOR RISK",
      level,
      headline: hasBorrows ? "Withdrawal reduces collateral — HF will decrease ↓" : "Withdrawal from uncollateralised supply",
      details: [
        currentHF != null ? `Current health factor: ${currentHF.toFixed(2)}` : "No active borrow",
        `Withdrawing ${parsed.amount} ${parsed.asset} from supply`,
        hasBorrows ? "Ensure remaining collateral covers outstanding debt" : "No outstanding debt — safe to withdraw",
      ],
    }
  }

  if (parsed.action === "repay") {
    return {
      title: "HEALTH FACTOR RISK",
      level: "SAFE",
      headline: "Debt repayment — health factor will improve ↑",
      details: [
        currentHF != null ? `Current health factor: ${currentHF.toFixed(2)}` : "No active debt detected",
        `Repaying ${parsed.amount} ${parsed.asset} reduces outstanding debt`,
        "Reduces liquidation risk and frees collateral",
      ],
    }
  }

  return {
    title: "HEALTH FACTOR RISK",
    level: "SAFE",
    headline: "No position health impact detected",
    details: ["Action does not affect Navi health factor"],
  }
}

function marketRiskCard(riskAssessment: any): RiskCard {
  const score: number = riskAssessment?.score ?? 0
  const level: string = riskAssessment?.level ?? "LOW"
  const reasons: string[] = riskAssessment?.reasons ?? []

  const cardLevel: "SAFE" | "WARN" | "DANGER" =
    score >= 70 ? "DANGER" : score >= 40 ? "WARN" : "SAFE"

  const advice =
    cardLevel === "DANGER"
      ? "HIGH RISK environment — consider delaying new positions"
      : cardLevel === "WARN"
      ? "Elevated market risk — proceed with caution"
      : "Market conditions favourable for DeFi operations"

  return {
    title: "MARKET ENVIRONMENT RISK",
    level: cardLevel,
    headline: `${level} risk · ${score}/100`,
    details: [
      advice,
      ...reasons.slice(0, 2),
    ],
  }
}

// ─── PTB builder ─────────────────────────────────────────────────────────────

async function buildNaviTx(
  parsed: ParsedAction,
  address: string,
  suiClient: any,
): Promise<Transaction> {
  const navi = await import("navi-sdk") as any
  const { pool, depositCoin, borrowCoin, withdrawCoin, repayDebt } = navi

  const poolKey = ASSET_TO_POOL_KEY[parsed.asset.toUpperCase()]
  if (!poolKey || !pool[poolKey]) {
    throw new Error(`${parsed.asset} is not supported in this demo. Try: SUI, USDC, USDT, WETH, CETUS, DEEP, NAVX, WAL, BLUE`)
  }
  const poolConfig = pool[poolKey]
  const rawAmount = toRaw(parsed.amount, parsed.asset)
  if (rawAmount <= 0) throw new Error("Amount must be greater than 0")

  // Cast to any: the .d.mts generic method signatures (splitCoins, mergeCoins,
  // transferObjects) fail TypeScript's bundler resolution in this Next.js build,
  // though they work correctly at runtime.
  const tx: any = new Transaction()

  if (parsed.action === "supply") {
    let coinArg: any
    if (parsed.asset.toUpperCase() === "SUI") {
      ;[coinArg] = tx.splitCoins(tx.gas, [tx.pure.u64(rawAmount)])
    } else {
      const result = await (suiClient as any).getCoins({ owner: address, coinType: poolConfig.type })
      const coins: any[] = result?.data ?? []
      if (coins.length === 0) throw new Error(`No ${parsed.asset} found in wallet`)
      const primary = tx.object(coins[0].coinObjectId)
      if (coins.length > 1) {
        tx.mergeCoins(primary, coins.slice(1).map((c: any) => tx.object(c.coinObjectId)))
      }
      ;[coinArg] = tx.splitCoins(primary, [tx.pure.u64(rawAmount)])
    }
    await depositCoin(tx, poolConfig, coinArg, rawAmount)

  } else if (parsed.action === "borrow") {
    const borrowed = await borrowCoin(tx, poolConfig, rawAmount)
    tx.transferObjects([borrowed[0]], tx.pure.address(address))

  } else if (parsed.action === "withdraw") {
    const withdrawn = await withdrawCoin(tx, poolConfig, rawAmount)
    tx.transferObjects([withdrawn[0]], tx.pure.address(address))

  } else if (parsed.action === "repay") {
    let coinArg: any
    if (parsed.asset.toUpperCase() === "SUI") {
      ;[coinArg] = tx.splitCoins(tx.gas, [tx.pure.u64(rawAmount)])
    } else {
      const result = await (suiClient as any).getCoins({ owner: address, coinType: poolConfig.type })
      const coins: any[] = result?.data ?? []
      if (coins.length === 0) throw new Error(`No ${parsed.asset} in wallet to repay`)
      const primary = tx.object(coins[0].coinObjectId)
      if (coins.length > 1) {
        tx.mergeCoins(primary, coins.slice(1).map((c: any) => tx.object(c.coinObjectId)))
      }
      ;[coinArg] = tx.splitCoins(primary, [tx.pure.u64(rawAmount)])
    }
    await repayDebt(tx, poolConfig, coinArg, rawAmount)

  } else {
    throw new Error(`Unsupported action: ${parsed.action}`)
  }

  return tx
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function RiskCardView({ card }: { card: RiskCard }) {
  const color = card.level === "DANGER" ? C.danger : card.level === "WARN" ? C.warn : C.safe
  const dot   = card.level === "DANGER" ? "●" : card.level === "WARN" ? "◐" : "○"
  return (
    <div style={{
      flex: 1,
      background: color + "09",
      border: `1px solid ${color}33`,
      borderLeft: `3px solid ${color}`,
      borderRadius: 5,
      padding: "14px 16px",
    }}>
      <div style={{ fontFamily: MONO, fontSize: 8, color: C.mutedHi, letterSpacing: 3, marginBottom: 8 }}>
        {card.title}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
        <span style={{ color, fontFamily: MONO, fontSize: 13 }}>{dot}</span>
        <span style={{ fontFamily: MONO, fontSize: 11, color, letterSpacing: 1 }}>
          {card.level}
        </span>
      </div>
      <div style={{ fontFamily: SANS, fontSize: 12, color: C.text, marginBottom: 8, lineHeight: 1.45 }}>
        {card.headline}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {card.details.map((d, i) => (
          <div key={i} style={{ fontFamily: SANS, fontSize: 11, color: C.mutedHi, display: "flex", gap: 6 }}>
            <span style={{ color, flexShrink: 0 }}>·</span>
            <span>{d}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ActionChip({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontFamily: MONO, fontSize: 10, letterSpacing: 2,
      padding: "3px 10px", borderRadius: 2,
      border: `1px solid ${color}55`,
      color,
      background: color + "12",
    }}>{label}</span>
  )
}

const ACTION_COLOR: Record<string, string> = {
  supply: C.safe, borrow: C.gold, withdraw: C.blue, repay: C.accent,
}

// ─── Main component ───────────────────────────────────────────────────────────

type Phase = "idle" | "parsing" | "preview" | "executing" | "success" | "error"

export function IntentEngine({
  protocolPositions,
  riskAssessment,
}: {
  protocolPositions: ProtocolPosition[]
  riskAssessment: any
}) {
  const [input, setInput]       = useState("")
  const [phase, setPhase]       = useState<Phase>("idle")
  const [parsed, setParsed]     = useState<ParsedAction | null>(null)
  const [txDigest, setTxDigest] = useState("")
  const [errorMsg, setErrorMsg] = useState("")
  const inputRef                = useRef<HTMLInputElement>(null)

  const account      = useCurrentAccount()
  const suiClient    = useSuiClient()
  const { mutate: signAndExecute } = useSignAndExecuteTransaction()

  const walletAddress = account?.address ?? null

  // Risk cards — computed from parsed action and current state
  const risk1 = parsed ? healthFactorCard(parsed, protocolPositions) : null
  const risk2 = parsed ? marketRiskCard(riskAssessment) : null

  // ── handlers ────────────────────────────────────────────────────────────────

  async function handleParse() {
    const text = input.trim()
    if (!text || !walletAddress) return
    setPhase("parsing")
    try {
      const res = await fetch("/api/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: text,
          riskScore: riskAssessment?.score ?? 0,
          riskLevel: riskAssessment?.level ?? "LOW",
        }),
      })
      const data: ParsedAction = await res.json()
      if (data.action === "unknown" || data.error) {
        setErrorMsg(data.error ?? data.reason ?? "Could not parse intent. Try: 'supply 5 SUI to Navi'")
        setPhase("error")
        return
      }
      if (!data.amount || data.amount <= 0) {
        setErrorMsg("Amount not specified. Try: 'supply 5 SUI' or 'borrow 100 USDC'")
        setPhase("error")
        return
      }
      setParsed(data)
      setPhase("preview")
    } catch (e: any) {
      setErrorMsg(e?.message ?? "Network error — check your connection")
      setPhase("error")
    }
  }

  async function handleConfirm() {
    if (!parsed || !walletAddress) return
    setPhase("executing")
    try {
      const tx = await buildNaviTx(parsed, walletAddress, suiClient)
      signAndExecute(
        { transaction: tx },
        {
          onSuccess: (result: any) => {
            setTxDigest(result.digest)
            setPhase("success")
          },
          onError: (e: any) => {
            setErrorMsg(e?.message ?? "Transaction failed or rejected")
            setPhase("error")
          },
        },
      )
    } catch (e: any) {
      setErrorMsg(e?.message ?? "Failed to build transaction")
      setPhase("error")
    }
  }

  function handleReset() {
    setPhase("idle")
    setParsed(null)
    setInput("")
    setErrorMsg("")
    setTxDigest("")
    setTimeout(() => inputRef.current?.focus(), 50)
  }

  // ── render ───────────────────────────────────────────────────────────────────

  const phaseBadge =
    phase === "idle"      ? null :
    phase === "parsing"   ? { text: "PARSING",   color: C.blue   } :
    phase === "preview"   ? { text: "PREVIEW",   color: C.accent } :
    phase === "executing" ? { text: "EXECUTING", color: C.warn   } :
    phase === "success"   ? { text: "CONFIRMED", color: C.safe   } :
                            { text: "ERROR",     color: C.danger }

  if (!walletAddress) {
    return (
      <div style={{
        background: C.card, border: `1px solid ${C.border}`, borderRadius: 6,
        padding: "48px 32px", textAlign: "center",
      }}>
        <div style={{ fontFamily: MONO, fontSize: 9, color: C.accent, letterSpacing: 3, marginBottom: 12 }}>
          INTENT ENGINE
        </div>
        <div style={{ fontFamily: SANS, fontSize: 14, color: C.muted }}>
          Connect wallet to use the Intent Engine
        </div>
        <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted, marginTop: 6 }}>
          Text → PTB → guardian risk assessment → execute on-chain
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ── Header card ──────────────────────────────────────────────────── */}
      <div style={{
        background: C.card, border: `1px solid ${C.borderHi}`, borderRadius: 6,
        padding: "16px 20px",
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div>
          <div style={{ fontFamily: MONO, fontSize: 9, color: C.accent, letterSpacing: 3, marginBottom: 3 }}>
            INTENT ENGINE
          </div>
          <div style={{ fontFamily: SANS, fontSize: 11, color: C.mutedHi }}>
            Natural language → Sui PTB · Guardian risk assessment · On-chain execution
          </div>
        </div>
        {phaseBadge && (
          <span style={{
            fontFamily: MONO, fontSize: 9, letterSpacing: 2,
            padding: "3px 10px", borderRadius: 2,
            border: `1px solid ${phaseBadge.color}55`,
            color: phaseBadge.color,
            background: phaseBadge.color + "0e",
          }}>
            {phaseBadge.text}
          </span>
        )}
      </div>

      {/* ── Input card ───────────────────────────────────────────────────── */}
      {(phase === "idle" || phase === "parsing" || phase === "error") && (
        <div style={{
          background: C.card, border: `1px solid ${C.border}`, borderRadius: 6,
          padding: "20px",
        }}>
          <div style={{ fontFamily: MONO, fontSize: 8, color: C.mutedHi, letterSpacing: 3, marginBottom: 12 }}>
            DESCRIBE YOUR INTENT
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && phase !== "parsing") handleParse() }}
              disabled={phase === "parsing"}
              placeholder={'e.g. "supply 5 SUI to Navi" · "borrow 100 USDC" · "repay 2 SUI"'}
              style={{
                flex: 1,
                background: C.bg,
                border: `1px solid ${phase === "error" ? C.danger + "66" : C.borderHi}`,
                borderRadius: 4,
                padding: "11px 14px",
                fontFamily: SANS, fontSize: 13,
                color: C.text,
                outline: "none",
              }}
            />
            <button
              onClick={handleParse}
              disabled={!input.trim() || phase === "parsing"}
              style={{
                background: C.accent + "18",
                border: `1px solid ${C.accent}55`,
                borderRadius: 4,
                padding: "0 20px",
                fontFamily: MONO, fontSize: 11,
                color: phase === "parsing" ? C.muted : C.accent,
                letterSpacing: 1,
                cursor: phase === "parsing" ? "not-allowed" : "pointer",
                flexShrink: 0,
                transition: "all 0.2s",
              }}
            >
              {phase === "parsing" ? "PARSING…" : "PARSE →"}
            </button>
          </div>

          {/* Quick examples */}
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            {[
              "supply 5 SUI to Navi",
              "borrow 100 USDC",
              "withdraw 2 WAL",
              "repay 10 USDC",
            ].map(ex => (
              <button
                key={ex}
                onClick={() => setInput(ex)}
                style={{
                  background: "none",
                  border: `1px solid ${C.border}`,
                  borderRadius: 3,
                  padding: "4px 10px",
                  fontFamily: MONO, fontSize: 9,
                  color: C.muted,
                  cursor: "pointer",
                  letterSpacing: 1,
                  transition: "border-color 0.15s",
                }}
              >
                {ex}
              </button>
            ))}
          </div>

          {/* Error message */}
          {phase === "error" && errorMsg && (
            <div style={{
              marginTop: 12, padding: "10px 14px",
              background: C.danger + "0d",
              border: `1px solid ${C.danger}44`,
              borderRadius: 4,
              fontFamily: SANS, fontSize: 12, color: C.danger,
              lineHeight: 1.5,
            }}>
              {errorMsg}
            </div>
          )}
        </div>
      )}

      {/* ── Preview ──────────────────────────────────────────────────────── */}
      {(phase === "preview" || phase === "executing") && parsed && risk1 && risk2 && (
        <>
          {/* Parsed action summary */}
          <div style={{
            background: C.card, border: `1px solid ${C.borderHi}`, borderRadius: 6,
            padding: "18px 20px",
          }}>
            <div style={{ fontFamily: MONO, fontSize: 8, color: C.mutedHi, letterSpacing: 3, marginBottom: 12 }}>
              PARSED ACTION · MAINNET
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
              <ActionChip label={parsed.action.toUpperCase()} color={ACTION_COLOR[parsed.action] ?? C.accent} />
              <span style={{ fontFamily: MONO, fontSize: 13, color: C.text }}>
                {parsed.amount} {parsed.asset.toUpperCase()}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: C.muted }}>→</span>
              <span style={{ fontFamily: SANS, fontSize: 12, color: C.mutedHi }}>
                Navi Protocol (Sui Mainnet)
              </span>
            </div>
            <div style={{
              fontFamily: SANS, fontSize: 12, color: C.mutedHi,
              background: C.bg, borderRadius: 4, padding: "9px 12px",
              border: `1px solid ${C.border}`,
              lineHeight: 1.5,
            }}>
              <span style={{ color: C.accent, marginRight: 6, fontFamily: MONO, fontSize: 9 }}>PTB</span>
              {parsed.reason}
            </div>
          </div>

          {/* Guardian risk assessment — 2 risk classes */}
          <div style={{
            background: C.card, border: `1px solid ${C.border}`, borderRadius: 6,
            padding: "18px 20px",
          }}>
            <div style={{ fontFamily: MONO, fontSize: 8, color: C.mutedHi, letterSpacing: 3, marginBottom: 12 }}>
              GUARDIAN RISK ASSESSMENT
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <RiskCardView card={risk1} />
              <RiskCardView card={risk2} />
            </div>
          </div>

          {/* Confirm / Cancel */}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button
              onClick={handleReset}
              disabled={phase === "executing"}
              style={{
                background: "none",
                border: `1px solid ${C.border}`,
                borderRadius: 4, padding: "10px 20px",
                fontFamily: MONO, fontSize: 11, color: C.muted,
                letterSpacing: 1, cursor: "pointer",
              }}
            >
              CANCEL
            </button>
            <button
              onClick={handleConfirm}
              disabled={phase === "executing"}
              style={{
                background: phase === "executing" ? C.safe + "08" : C.safe + "18",
                border: `1px solid ${C.safe}55`,
                borderRadius: 4, padding: "10px 28px",
                fontFamily: MONO, fontSize: 11,
                color: phase === "executing" ? C.muted : C.safe,
                letterSpacing: 1,
                cursor: phase === "executing" ? "not-allowed" : "pointer",
                transition: "all 0.2s",
              }}
            >
              {phase === "executing" ? "AWAITING WALLET…" : "CONFIRM TX →"}
            </button>
          </div>
        </>
      )}

      {/* ── Success ──────────────────────────────────────────────────────── */}
      {phase === "success" && parsed && (
        <div style={{
          background: C.card, border: `1px solid ${C.safe}33`, borderRadius: 6,
          padding: "32px 24px", textAlign: "center",
        }}>
          <div style={{ fontFamily: MONO, fontSize: 28, color: C.safe, marginBottom: 12 }}>✓</div>
          <div style={{ fontFamily: MONO, fontSize: 12, color: C.safe, letterSpacing: 2, marginBottom: 6 }}>
            TRANSACTION CONFIRMED
          </div>
          <div style={{ fontFamily: SANS, fontSize: 13, color: C.text, marginBottom: 16 }}>
            {parsed.reason}
          </div>
          {txDigest && (
            <a
              href={`https://suiscan.xyz/mainnet/tx/${txDigest}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                fontFamily: MONO, fontSize: 10,
                color: C.safe,
                textDecoration: "none",
                padding: "6px 14px",
                border: `1px solid ${C.safe}44`,
                borderRadius: 3,
                background: C.safe + "0e",
                marginBottom: 20,
              }}
            >
              <span style={{ opacity: 0.7 }}>TX</span>
              <span>{txDigest.slice(0, 24)}…</span>
              <span>↗</span>
            </a>
          )}
          <div style={{ marginTop: txDigest ? 0 : 4 }}>
            <button
              onClick={handleReset}
              style={{
                background: C.accent + "14",
                border: `1px solid ${C.accent}44`,
                borderRadius: 4, padding: "9px 20px",
                fontFamily: MONO, fontSize: 11, color: C.accent,
                letterSpacing: 1, cursor: "pointer",
              }}
            >
              NEW INTENT
            </button>
          </div>
        </div>
      )}

      {/* ── How it works (shown in idle) ─────────────────────────────────── */}
      {phase === "idle" && (
        <div style={{
          background: C.card, border: `1px solid ${C.border}`, borderRadius: 6,
          padding: "18px 20px",
        }}>
          <div style={{ fontFamily: MONO, fontSize: 8, color: C.mutedHi, letterSpacing: 3, marginBottom: 14 }}>
            HOW IT WORKS
          </div>
          <div style={{ display: "flex", gap: 0 }}>
            {[
              { step: "01", label: "TYPE INTENT",    sub: "Plain English",          color: C.blue   },
              { step: "02", label: "AI PARSES",      sub: "Groq · Llama 3.3 70B",  color: C.accent },
              { step: "03", label: "RISK ASSESSED",  sub: "2 guardian risk classes",color: C.warn   },
              { step: "04", label: "CONFIRM",        sub: "Explicit approval",       color: C.gold   },
              { step: "05", label: "EXECUTE PTB",    sub: "Sui Mainnet · Navi",     color: C.safe   },
            ].map((s, i, arr) => (
              <div key={s.step} style={{ display: "flex", alignItems: "center", flex: 1 }}>
                <div style={{ flex: 1, textAlign: "center" }}>
                  <div style={{ fontFamily: MONO, fontSize: 9, color: s.color, letterSpacing: 2 }}>
                    {s.step}
                  </div>
                  <div style={{ fontFamily: MONO, fontSize: 9, color: s.color, letterSpacing: 1, marginTop: 4, marginBottom: 2 }}>
                    {s.label}
                  </div>
                  <div style={{ fontFamily: SANS, fontSize: 10, color: C.muted }}>
                    {s.sub}
                  </div>
                </div>
                {i < arr.length - 1 && (
                  <div style={{ fontFamily: MONO, fontSize: 10, color: C.border, flexShrink: 0, margin: "0 4px", paddingBottom: 12 }}>→</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
