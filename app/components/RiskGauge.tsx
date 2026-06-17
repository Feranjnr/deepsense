"use client"

import { useEffect, useRef, useState } from "react"

const MONO = "'IBM Plex Mono','Courier New',monospace"
const SANS = "'IBM Plex Sans',system-ui,sans-serif"

// Band boundaries match scoreToLevel() in useRiskEngine.ts
const BANDS = [
  { max: 30,  color: "#1D9E75" }, // LOW      — green
  { max: 60,  color: "#BA7517" }, // MEDIUM   — amber
  { max: 85,  color: "#E2820F" }, // HIGH     — orange
  { max: 100, color: "#E24B4A" }, // CRITICAL — red
]

function gaugeColor(score: number): string {
  return BANDS.find(b => score <= b.max)?.color ?? "#E24B4A"
}

// SVG geometry
const R = 90
const CX = 110
const CY = 115
const CIRCUMFERENCE = 2 * Math.PI * R
const START_DEG = 135
const SWEEP_DEG = 270
const TRACK_ARC = (SWEEP_DEG / 360) * CIRCUMFERENCE
// Negative offset so the arc starts at START_DEG
const DASH_OFFSET = -(START_DEG / 360) * CIRCUMFERENCE

interface Props {
  score: number
  level: string
}

export function RiskGauge({ score, level }: Props) {
  const [displayScore, setDisplayScore] = useState(0)
  const animRef = useRef<number | null>(null)
  const prevScoreRef = useRef(0)

  useEffect(() => {
    const from = prevScoreRef.current
    const to = Math.round(score)
    const duration = 900
    const startTime = performance.now()

    const step = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1)
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplayScore(Math.round(from + (to - from) * eased))
      if (t < 1) {
        animRef.current = requestAnimationFrame(step)
      } else {
        prevScoreRef.current = to
      }
    }

    if (animRef.current !== null) cancelAnimationFrame(animRef.current)
    animRef.current = requestAnimationFrame(step)

    return () => {
      if (animRef.current !== null) cancelAnimationFrame(animRef.current)
    }
  }, [score])

  const color = gaugeColor(score)
  const filledArc = (Math.max(0, Math.min(100, score)) / 100) * TRACK_ARC

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      marginBottom: 28,
    }}>
      {/* label above */}
      <div style={{
        fontFamily: MONO,
        fontSize: 9,
        color: "#5B6470",
        letterSpacing: 4,
        marginBottom: 6,
        textTransform: "uppercase",
      }}>
        Risk Score
      </div>

      <svg width={220} height={220} viewBox="0 0 220 230" style={{ overflow: "visible" }}>
        {/* Track (light gray) */}
        <circle
          cx={CX} cy={CY} r={R}
          fill="none"
          stroke="#E4E6EB"
          strokeWidth={12}
          strokeDasharray={`${TRACK_ARC} ${CIRCUMFERENCE - TRACK_ARC}`}
          strokeDashoffset={DASH_OFFSET}
          strokeLinecap="round"
        />

        {/* Filled arc — animates via CSS transition */}
        <circle
          cx={CX} cy={CY} r={R}
          fill="none"
          stroke={color}
          strokeWidth={12}
          strokeDasharray={`${filledArc} ${CIRCUMFERENCE - filledArc}`}
          strokeDashoffset={DASH_OFFSET}
          strokeLinecap="round"
          style={{
            transition: "stroke-dasharray 0.9s cubic-bezier(0.4,0,0.2,1), stroke 0.5s ease",
          }}
        />

        {/* Score number */}
        <text
          x={CX}
          y={CY - 8}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={color}
          fontFamily={MONO}
          fontSize={54}
          fontWeight={700}
          style={{ transition: "fill 0.5s ease" }}
        >
          {displayScore}
        </text>

        {/* Level word — muted gray */}
        <text
          x={CX}
          y={CY + 36}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="#5B6470"
          fontFamily={MONO}
          fontSize={11}
          fontWeight={400}
          letterSpacing={3}
          style={{ transition: "fill 0.5s ease" }}
        >
          {level || "—"}
        </text>
      </svg>

      {/* Band legend */}
      <div style={{
        display: "flex",
        gap: 16,
        marginTop: -4,
      }}>
        {BANDS.map(b => (
          <div key={b.max} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{
              display: "inline-block",
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: b.color,
              opacity: score <= b.max ? 1 : 0.25,
            }} />
            <span style={{
              fontFamily: MONO,
              fontSize: 9,
              color: score <= b.max ? b.color : "#5B6470",
              letterSpacing: 1,
              transition: "color 0.4s ease",
            }}>
              {b.max <= 30 ? "LOW" : b.max <= 60 ? "MED" : b.max <= 85 ? "HIGH" : "CRIT"}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
