"use client"

import { useState } from "react"
import { Transaction } from "@mysten/sui/transactions"
import { useSignAndExecuteTransaction } from "@mysten/dapp-kit"
import type { ProtocolPosition } from "../hooks/useProtocolPositions"

// ─── Theme (matches globals) ──────────────────────────────────────────────────
const MONO = "'IBM Plex Mono','Courier New',monospace"
const SANS = "'IBM Plex Sans',system-ui,sans-serif"
const C = {
  bg:       "#FBFBFA",
  card:     "#FFFFFF",
  border:   "#E4E6EB",
  borderHi: "#D4D8E0",
  accent:   "#1A56DB",
  gold:     "#BA7517",
  danger:   "#E24B4A",
  warn:     "#BA7517",
  safe:     "#1D9E75",
  text:     "#16181D",
  muted:    "#5B6470",
  mutedHi:  "#8A929E",
}

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Describes a pending on-chain action.
 * buildTx is called lazily — only when the user hits Confirm.
 */
export type ActionIntent = {
  /** Human-readable protocol name, e.g. "RiskGuardian · Sui Testnet" */
  protocol: string
  /** Human-readable action label, e.g. "Update Risk Score" */
  action: string
  /** Numeric value for the action (0 if not applicable) */
  amount: number
  /** Token/unit label, e.g. "SUI" or "score points" or "" */
  asset: string
  /** Expected net change in the guardian risk score (positive = increases risk) */
  effectOnScore: number
  /** Human-readable gas estimate, e.g. "~0.005 SUI" */
  gasEstimate: string
  /** Factory: builds and returns the Transaction. Called only on Confirm. */
  buildTx: () => Transaction
}

// ─── Guardian risk-class computation ─────────────────────────────────────────
// Data source: protocolPositions from useProtocolPositions (Navi SDK + object scanner).
// Navi SDK positions carry healthFactor (account-level, from getHealthFactor RPC call)
// and usdValue (per position, from Navi's on-chain oracle via getCoinOracleInfo).
// Object-scanner positions (Scallop, Cetus, etc.) have healthFactor=undefined and
// usdValue=undefined — they are excluded from both risk calculations below.

type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"

type GuardianWarning = {
  riskClass: "LIQUIDATION RISK" | "CONCENTRATION RISK"
  level: RiskLevel
  metric: string           // e.g. "HF 3.87" or "72% SUI"
  headline: string
  body: string
}

// Reads: ProtocolPosition.healthFactor (number | undefined).
// Set by fetchNaviPositions via account.getHealthFactor(address).
// undefined when: no wallet, RPC error, or no Navi positions at all.
function computeLiquidationRisk(positions: ProtocolPosition[]): GuardianWarning {
  const naviPos  = positions.filter(p => p.protocol === "Navi Protocol")
  const borrows  = naviPos.filter(p => p.type === "BORROW")
  const hf: number | null = naviPos.find(p => p.healthFactor != null)?.healthFactor ?? null

  // No active borrows — no liquidation exposure
  if (borrows.length === 0) {
    return {
      riskClass: "LIQUIDATION RISK",
      level: "LOW",
      metric: "HF N/A",
      headline: "No active borrow positions",
      body: "No liquidation exposure on Navi Protocol mainnet. Signing this action does not affect your collateral.",
    }
  }

  if (hf === null) {
    return {
      riskClass: "LIQUIDATION RISK",
      level: "MEDIUM",
      metric: "HF unknown",
      headline: "Health factor unavailable",
      body: "Borrow positions detected but health factor could not be fetched. Verify position safety before signing.",
    }
  }

  const metric = `HF ${hf.toFixed(2)}`

  if (hf >= 3) return {
    riskClass: "LIQUIDATION RISK",
    level: "LOW",
    metric,
    headline: `Comfortable health factor: ${hf.toFixed(2)}`,
    body: "Your collateral is well over the liquidation threshold. Standard market volatility poses no immediate risk.",
  }

  if (hf >= 2) return {
    riskClass: "LIQUIDATION RISK",
    level: "LOW",
    metric,
    headline: `Healthy position: HF ${hf.toFixed(2)}`,
    body: "Positions are safe. A ~50% adverse price move would be needed to approach liquidation territory.",
  }

  if (hf >= 1.5) return {
    riskClass: "LIQUIDATION RISK",
    level: "MEDIUM",
    metric,
    headline: `Health factor moderate: ${hf.toFixed(2)}`,
    body: "A 25–30% price decline in your collateral assets could approach the liquidation threshold. Monitor closely.",
  }

  if (hf >= 1.1) return {
    riskClass: "LIQUIDATION RISK",
    level: "HIGH",
    metric,
    headline: `Health factor low: ${hf.toFixed(2)}`,
    body: "Near the liquidation zone. A 10% adverse move could trigger partial liquidation. Consider repaying debt.",
  }

  return {
    riskClass: "LIQUIDATION RISK",
    level: "CRITICAL",
    metric,
    headline: `CRITICAL: HF ${hf.toFixed(2)} — liquidation imminent`,
    body: "Position is at immediate liquidation risk. Repay debt or add collateral before signing any other action.",
  }
}

// Reads: ProtocolPosition.usdValue (number | undefined) for Navi LEND positions only.
// Set by fetchNaviPositions via getCoinOracleInfo (Navi on-chain oracle).
// Positions with usdValue=0 or undefined are excluded — other protocols have no oracle data
// and must not silently inflate or skew the concentration metric.
function computeConcentrationRisk(positions: ProtocolPosition[]): GuardianWarning {
  const supplies = positions.filter(
    p => p.protocol === "Navi Protocol" && p.type === "LEND" && (p.usdValue ?? 0) > 0,
  )

  if (supplies.length === 0) {
    return {
      riskClass: "CONCENTRATION RISK",
      level: "LOW",
      metric: "—",
      headline: "No supply positions detected",
      body: "No active supply positions across Navi positions. No single-asset concentration risk at this time.",
    }
  }

  // Aggregate USD value per asset
  const byAsset: Record<string, number> = {}
  let total = 0
  for (const p of supplies) {
    const v = p.usdValue ?? 0
    byAsset[p.asset] = (byAsset[p.asset] ?? 0) + v
    total += v
  }

  const [[topAsset, topValue]] = Object.entries(byAsset).sort(([, a], [, b]) => b - a)
  const pct = total > 0 ? Math.round((topValue / total) * 100) : 0
  const assetCount = Object.keys(byAsset).length
  const metric = `${pct}% ${topAsset}`

  if (pct >= 80) return {
    riskClass: "CONCENTRATION RISK",
    level: "HIGH",
    metric,
    headline: `${pct}% across Navi positions in ${topAsset} — high concentration`,
    body: `A sharp ${topAsset} price decline would severely reduce your value across Navi positions. Consider diversifying into stablecoins or other assets.`,
  }

  if (pct >= 60) return {
    riskClass: "CONCENTRATION RISK",
    level: "MEDIUM",
    metric,
    headline: `${pct}% across Navi positions in ${topAsset}`,
    body: `Moderate concentration in ${topAsset} across Navi positions — ${assetCount} asset${assetCount > 1 ? "s" : ""} total but ${topAsset} dominates. Consider partial diversification.`,
  }

  return {
    riskClass: "CONCENTRATION RISK",
    level: "LOW",
    metric,
    headline: `Diversified: largest position ${pct}% ${topAsset}`,
    body: `Supply is spread across ${assetCount} asset${assetCount > 1 ? "s" : ""} across Navi positions. No single-asset dominance detected.`,
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const LEVEL_COLOR: Record<RiskLevel, string> = {
  LOW:      C.safe,
  MEDIUM:   C.warn,
  HIGH:     C.danger,
  CRITICAL: C.danger,
}

const LEVEL_ICON: Record<RiskLevel, string> = {
  LOW:      "○",
  MEDIUM:   "◐",
  HIGH:     "●",
  CRITICAL: "⬤",
}

function WarningCard({ w }: { w: GuardianWarning }) {
  const color = LEVEL_COLOR[w.level]
  return (
    <div style={{
      flex: 1,
      background: color + "09",
      border: `1px solid ${color}33`,
      borderLeft: `3px solid ${color}`,
      borderRadius: 5,
      padding: "14px 16px",
      minWidth: 0,
    }}>
      <div style={{ fontFamily: SANS, fontSize: 11, color: C.muted, marginBottom: 8 }}>
        {w.riskClass.charAt(0) + w.riskClass.slice(1).toLowerCase()}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ fontFamily: MONO, fontSize: 16, color, lineHeight: 1 }}>{LEVEL_ICON[w.level]}</span>
        <span style={{ fontFamily: MONO, fontSize: 11, color, letterSpacing: 1 }}>{w.level}</span>
        <span style={{
          fontFamily: MONO, fontSize: 9, color: C.mutedHi,
          marginLeft: "auto", background: C.bg,
          padding: "1px 7px", borderRadius: 2, border: `1px solid ${C.border}`,
        }}>{w.metric}</span>
      </div>
      <div style={{ fontFamily: SANS, fontSize: 12, color: C.text, marginTop: 8, marginBottom: 6, lineHeight: 1.45, fontWeight: 600 }}>
        {w.headline}
      </div>
      <div style={{ fontFamily: SANS, fontSize: 11, color: C.mutedHi, lineHeight: 1.55 }}>
        {w.body}
      </div>
    </div>
  )
}

function Row({ label, value, valueColor }: { label: string; value: React.ReactNode; valueColor?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
      <span style={{ fontFamily: SANS, fontSize: 12, color: C.muted }}>{label}</span>
      <span style={{ fontFamily: SANS, fontSize: 13, color: valueColor ?? C.text, fontWeight: 500 }}>{value}</span>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

type Phase = "preview" | "signing" | "success" | "error"

export function ActionPreview({
  intent,
  protocolPositions,
  onCancel,
  onStageChange,
  onSuccess,
}: {
  intent: ActionIntent
  protocolPositions: ProtocolPosition[]
  /** Called with the tx digest when the transaction confirms on-chain */
  onSuccess: (digest: string) => void
  /** Called when the user clicks Cancel — caller should hide this component */
  onCancel: () => void
  /** Drives the DecisionPipeline in page.tsx: 3 = signing, 5 = confirmed */
  onStageChange: (stage: number) => void
}) {
  const [phase, setPhase]   = useState<Phase>("preview")
  const [digest, setDigest] = useState<string | null>(null)
  const [errMsg, setErrMsg] = useState<string>("")

  const { mutate: signAndExecute } = useSignAndExecuteTransaction()

  // Compute the two guardian risk classes from real on-chain position data
  const liqWarning  = computeLiquidationRisk(protocolPositions)
  const concWarning = computeConcentrationRisk(protocolPositions)

  // Highest risk level across both classes
  const levelOrder: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 }
  const worstLevel = levelOrder[liqWarning.level] >= levelOrder[concWarning.level]
    ? liqWarning.level
    : concWarning.level

  function handleConfirm() {
    if (phase === "signing") return  // double-click guard: one tx in flight at a time
    let tx: Transaction
    try {
      tx = intent.buildTx()
    } catch (e: any) {
      setErrMsg(e?.message ?? "Failed to build transaction")
      setPhase("error")
      return
    }

    setPhase("signing")
    onStageChange(3) // DecisionPipeline: Signing Tx

    signAndExecute(
      { transaction: tx },
      {
        onSuccess: (result: any) => {
          const d: string = result?.digest ?? ""
          setDigest(d)
          setPhase("success")
          onStageChange(5) // DecisionPipeline: Confirmed On-Chain
          onSuccess(d)
        },
        onError: (e: any) => {
          setErrMsg(e?.message ?? "Transaction rejected or failed")
          setPhase("error")
          onStageChange(2) // DecisionPipeline: back to AI Decision
        },
      },
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const effectColor = intent.effectOnScore === 0
    ? C.mutedHi
    : intent.effectOnScore > 0
    ? C.danger
    : C.safe

  const effectLabel =
    intent.effectOnScore === 0
      ? "No change"
      : intent.effectOnScore > 0
      ? `+${intent.effectOnScore} (risk increases)`
      : `${intent.effectOnScore} (risk decreases)`

  if (phase === "success" && digest !== null) {
    return (
      <div style={{
        background: C.card,
        border: `1px solid ${C.safe}44`,
        borderRadius: 6,
        padding: "28px 24px",
        textAlign: "center",
      }}>
        <div style={{ fontFamily: MONO, fontSize: 26, color: C.safe, marginBottom: 10 }}>✓</div>
        <div style={{ fontFamily: SANS, fontSize: 14, fontWeight: 600, color: C.safe, marginBottom: 6 }}>
          Confirmed on-chain
        </div>
        <div style={{ fontFamily: SANS, fontSize: 13, color: C.text, marginBottom: 18 }}>
          {intent.action} submitted to Sui Testnet
        </div>
        {digest && (
          <a
            href={`https://suiscan.xyz/testnet/tx/${digest}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex", alignItems: "center", gap: 7,
              fontFamily: MONO, fontSize: 10, color: C.safe,
              textDecoration: "none", letterSpacing: 1,
              padding: "6px 14px",
              border: `1px solid ${C.safe}44`,
              borderRadius: 3,
              background: C.safe + "0e",
            }}
          >
            <span style={{ opacity: 0.65 }}>TX</span>
            <span>{digest.slice(0, 20)}…{digest.slice(-6)}</span>
            <span>↗ Suiscan</span>
          </a>
        )}
        <div style={{ marginTop: 20 }}>
          <button
            onClick={onCancel}
            style={{
              background: C.card, border: `1px solid ${C.border}`,
              borderRadius: 6, padding: "7px 20px",
              fontFamily: SANS, fontSize: 13, fontWeight: 500, color: C.text,
              cursor: "pointer",
            }}
          >Close</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{
      background: C.card,
      border: `1px solid ${worstLevel === "CRITICAL" || worstLevel === "HIGH" ? C.danger + "55" : C.borderHi}`,
      borderRadius: 6,
      overflow: "hidden",
    }}>

      {/* ── Header ────────────────────────────────────────────────────── */}
      <div style={{
        padding: "14px 18px",
        borderBottom: `1px solid ${C.border}`,
        background: C.card,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span style={{ fontFamily: SANS, fontSize: 14, fontWeight: 600, color: C.text }}>
          Action preview
        </span>
        <span style={{
          fontFamily: SANS, fontSize: 12,
          padding: "3px 10px", borderRadius: 20,
          border: `1px solid ${phase === "error" ? C.danger + "55" : C.border}`,
          color: phase === "error" ? C.danger : C.muted,
          background: phase === "error" ? C.danger + "0d" : C.bg,
        }}>
          {phase === "signing" ? "Awaiting wallet…" : phase === "error" ? "Error" : "Preview"}
        </span>
      </div>

      {/* ── Plain-English summary ─────────────────────────────────────── */}
      <div style={{ padding: "16px 18px", borderBottom: `1px solid ${C.border}` }}>
        <Row label="Protocol"            value={intent.protocol} />
        <Row label="Action"              value={intent.action} valueColor={C.accent} />
        {(intent.amount > 0 || intent.asset) && (
          <Row label="Value"
            value={intent.amount > 0 ? `${intent.amount} ${intent.asset}`.trim() : intent.asset || "—"}
          />
        )}
        <Row
          label="Effect on risk score"
          value={effectLabel}
          valueColor={effectColor}
        />
        <Row label="Est. gas"            value={intent.gasEstimate} valueColor={C.mutedHi} />
      </div>

      {/* ── Guardian section ──────────────────────────────────────────── */}
      <div style={{ padding: "14px 18px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{
          fontFamily: SANS, fontSize: 12, color: C.muted, marginBottom: 12,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span>Guardian risk assessment · live mainnet positions</span>
          <span style={{
            fontFamily: SANS, fontSize: 11, padding: "2px 10px", borderRadius: 20,
            border: `1px solid ${LEVEL_COLOR[worstLevel]}44`,
            color: LEVEL_COLOR[worstLevel],
            background: LEVEL_COLOR[worstLevel] + "0d",
          }}>{worstLevel.charAt(0) + worstLevel.slice(1).toLowerCase()}</span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <WarningCard w={liqWarning}  />
          <WarningCard w={concWarning} />
        </div>
      </div>

      {/* ── Error banner ─────────────────────────────────────────────── */}
      {phase === "error" && (
        <div style={{
          margin: "0 18px 0",
          padding: "10px 14px",
          background: C.danger + "0d",
          border: `1px solid ${C.danger}44`,
          borderRadius: 4,
          fontFamily: SANS, fontSize: 12, color: C.danger, lineHeight: 1.5,
          marginTop: 14,
          marginBottom: 0,
        }}>
          {errMsg}
        </div>
      )}

      {/* ── Confirm / Cancel ─────────────────────────────────────────── */}
      <div style={{
        padding: "14px 18px",
        display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
      }}>
        <button
          onClick={onCancel}
          disabled={phase === "signing"}
          style={{
            background: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: 6, padding: "9px 20px",
            fontFamily: SANS, fontSize: 13, fontWeight: 500, color: C.text,
            cursor: phase === "signing" ? "not-allowed" : "pointer",
          }}
        >Cancel</button>

        {/* Risk disclaimer */}
        {worstLevel === "HIGH" || worstLevel === "CRITICAL" ? (
          <span style={{ fontFamily: SANS, fontSize: 11, color: C.danger, flex: 1, textAlign: "center" }}>
            ⚠ High risk detected — review warnings above
          </span>
        ) : (
          <span style={{ fontFamily: SANS, fontSize: 11, color: C.muted, flex: 1, textAlign: "center" }}>
            Nothing signs until you click Confirm
          </span>
        )}

        <button
          onClick={handleConfirm}
          disabled={phase === "signing"}
          style={{
            background: phase === "signing" ? C.border : C.accent,
            border: `1px solid ${phase === "signing" ? C.border : C.accent}`,
            borderRadius: 6, padding: "9px 22px",
            fontFamily: SANS, fontSize: 13, fontWeight: 600,
            color: phase === "signing" ? C.muted : "#fff",
            cursor: phase === "signing" ? "not-allowed" : "pointer",
            transition: "all 0.2s",
          }}
        >
          {phase === "signing" ? "Signing…" : phase === "error" ? "Retry" : "Confirm"}
        </button>
      </div>
    </div>
  )
}
