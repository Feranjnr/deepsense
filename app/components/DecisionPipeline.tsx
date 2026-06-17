"use client"

import { Fragment } from "react"

const MONO = "'IBM Plex Mono','Courier New',monospace"
const SANS = "'IBM Plex Sans',system-ui,sans-serif"

const C = {
  bg:       "#FBFBFA",
  card:     "#FFFFFF",
  border:   "#E4E6EB",
  borderHi: "#D4D8E0",
  accent:   "#1A56DB",
  safe:     "#1D9E75",
  warn:     "#BA7517",
  danger:   "#E24B4A",
  text:     "#16181D",
  muted:    "#5B6470",
  mutedHi:  "#8A929E",
}

const STAGES: { label: string; sublabel: string; icon: string }[] = [
  { label: "Price Drop",         sublabel: "Oracle feed",         icon: "▼" },
  { label: "Risk Recalculated",  sublabel: "Scoring engine",      icon: "◎" },
  { label: "AI Decision",        sublabel: "Action queued",       icon: "⬡" },
  { label: "Signing Tx",         sublabel: "Wallet approval",     icon: "◈" },
  { label: "Confirmed On-Chain", sublabel: "Sui Testnet",         icon: "⛓" },
]

/**
 * stage: -1 = idle, 0–4 = that stage active (prior ones done), 5 = all complete
 * txDigest: shown as a suiscan link when stage === 5
 */
export function DecisionPipeline({
  stage,
  txDigest,
}: {
  stage: number
  txDigest?: string
}) {
  const allDone = stage >= 5

  return (
    <div style={{
      background: C.card,
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      padding: "20px 28px 18px",
      boxShadow: "0 1px 2px rgba(16,24,40,0.04)",
    }}>
      <style>{`
        @keyframes dp-ring {
          0%, 100% { transform: scale(1);   opacity: 0.6; }
          50%       { transform: scale(1.5); opacity: 0;   }
        }
        @keyframes dp-enter {
          from { opacity: 0; transform: scale(0.7) rotate(-15deg); }
          to   { opacity: 1; transform: scale(1)   rotate(0deg);   }
        }
        @keyframes dp-line {
          from { transform: scaleX(0); }
          to   { transform: scaleX(1); }
        }
      `}</style>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div>
          <span style={{ fontFamily: MONO, fontSize: 9, color: C.accent, letterSpacing: 3 }}>
            DECISION PIPELINE
          </span>
          <div style={{ fontFamily: SANS, fontSize: 11, color: C.mutedHi, marginTop: 3 }}>
            AI risk engine → guardian contract · autonomous execution
          </div>
        </div>
        {/* Status chip */}
        <span style={{
          fontFamily: MONO, fontSize: 9, letterSpacing: 2,
          padding: "3px 10px", borderRadius: 2,
          border: `1px solid ${allDone ? C.safe + "55" : stage >= 0 ? C.accent + "55" : C.border}`,
          color: allDone ? C.safe : stage >= 0 ? C.accent : C.muted,
          background: allDone ? C.safe + "0e" : stage >= 0 ? C.accent + "0e" : "transparent",
          transition: "all 0.4s ease",
        }}>
          {allDone ? "CONFIRMED" : stage >= 0 ? "IN PROGRESS" : "IDLE"}
        </span>
      </div>

      {/* Steps + connectors */}
      <div style={{ display: "flex", alignItems: "flex-start" }}>
        {STAGES.map((s, i) => {
          const isDone   = allDone || i < stage
          const isActive = !allDone && i === stage
          const isIdle   = !isDone && !isActive

          const color = isDone ? C.safe : isActive ? C.accent : C.muted
          const nextDone = allDone || i + 1 < stage

          return (
            <Fragment key={i}>
              {/* Step node */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, flex: "0 0 auto", minWidth: 72 }}>
                {/* Circle */}
                <div style={{ position: "relative", width: 40, height: 40 }}>
                  {/* Pulse ring — only when active */}
                  {isActive && (
                    <div style={{
                      position: "absolute",
                      inset: -6,
                      borderRadius: "50%",
                      border: `1.5px solid ${C.accent}`,
                      animation: "dp-ring 1.6s ease-in-out infinite",
                      pointerEvents: "none",
                    }} />
                  )}

                  {/* Main circle */}
                  <div style={{
                    width: 40, height: 40, borderRadius: "50%",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: isDone
                      ? C.safe + "18"
                      : isActive
                        ? C.accent + "14"
                        : C.bg,
                    border: `2px solid ${color}`,
                    transition: "background 0.5s ease, border-color 0.5s ease",
                  }}>
                    <span style={{
                      fontFamily: MONO,
                      fontSize: isDone ? 15 : 13,
                      fontWeight: 700,
                      color,
                      display: "inline-block",
                      transition: "color 0.4s ease",
                      animation: (isDone || isActive) ? "dp-enter 0.35s ease-out" : "none",
                    }}>
                      {isDone ? "✓" : s.icon}
                    </span>
                  </div>
                </div>

                {/* Label */}
                <div style={{ textAlign: "center" }}>
                  <div style={{
                    fontFamily: MONO, fontSize: 9, letterSpacing: 1,
                    color, lineHeight: 1.4,
                    transition: "color 0.4s ease",
                  }}>
                    {s.label.toUpperCase()}
                  </div>
                  <div style={{
                    fontFamily: SANS, fontSize: 10,
                    color: isIdle ? C.muted : C.mutedHi,
                    marginTop: 2, lineHeight: 1.3,
                    transition: "color 0.4s ease",
                  }}>
                    {s.sublabel}
                  </div>
                </div>
              </div>

              {/* Connector line between steps */}
              {i < STAGES.length - 1 && (
                <div style={{
                  flex: 1,
                  height: 2,
                  marginTop: 19,
                  background: C.border,
                  position: "relative",
                  overflow: "hidden",
                  borderRadius: 1,
                }}>
                  {/* Filled portion */}
                  <div style={{
                    position: "absolute", inset: 0,
                    background: C.safe,
                    transformOrigin: "left center",
                    transform: nextDone ? "scaleX(1)" : "scaleX(0)",
                    transition: "transform 0.6s ease",
                    borderRadius: 1,
                  }} />
                </div>
              )}
            </Fragment>
          )
        })}
      </div>

      {/* Tx confirmation row */}
      <div style={{
        marginTop: 20,
        minHeight: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}>
        {allDone && txDigest ? (
          <a
            href={`https://suiscan.xyz/testnet/tx/${txDigest}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontFamily: MONO, fontSize: 10,
              color: C.safe,
              textDecoration: "none",
              letterSpacing: 1,
              display: "flex", alignItems: "center", gap: 6,
              padding: "5px 12px",
              border: `1px solid ${C.safe}44`,
              borderRadius: 3,
              background: C.safe + "0e",
              transition: "background 0.2s",
            }}
          >
            <span style={{ opacity: 0.7 }}>TX</span>
            <span>{txDigest.slice(0, 28)}…</span>
            <span>↗</span>
          </a>
        ) : stage >= 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{
              display: "inline-block", width: 6, height: 6, borderRadius: "50%",
              background: C.accent,
              animation: "pulse 1.4s ease-in-out infinite",
            }} />
            <span style={{ fontFamily: MONO, fontSize: 9, color: C.mutedHi, letterSpacing: 2 }}>
              {STAGES[Math.min(stage, 4)]?.label.toUpperCase()} …
            </span>
          </div>
        ) : (
          <span style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 2 }}>
            AWAITING RISK EVENT
          </span>
        )}
      </div>
    </div>
  )
}
