"use client"

const C = {
  bg: "#FBFBFA", card: "#FFFFFF",
  border: "#E4E6EB",
  blue: "#1A56DB",
  text: "#16181D", muted: "#5B6470",
  danger: "#E24B4A", safe: "#1D9E75", warn: "#BA7517",
}
const MONO = "'IBM Plex Mono','Courier New',monospace"
const SANS = "'IBM Plex Sans',system-ui,sans-serif"

interface LandingProps {
  onLaunch: () => void
}

// ─── PRIMITIVES ────────────────────────────────────────────────────────────────
function NavLink({ children, onClick, href, target, rel }: {
  children: string
  onClick?: () => void
  href?: string
  target?: string
  rel?: string
}) {
  return (
    <a
      href={href ?? "#"}
      target={target}
      rel={rel}
      onClick={onClick ? (e) => { e.preventDefault(); onClick() } : undefined}
      style={{
        fontFamily: SANS, fontSize: 14, color: C.muted,
        textDecoration: "none", cursor: "pointer",
      }}
      onMouseEnter={e => (e.currentTarget.style.color = C.text)}
      onMouseLeave={e => (e.currentTarget.style.color = C.muted)}
    >{children}</a>
  )
}

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" })
}

function PrimaryBtn({ children, onClick, style }: { children: string; onClick?: () => void; style?: React.CSSProperties }) {
  return (
    <button onClick={onClick} style={{
      fontFamily: SANS, fontSize: 15, fontWeight: 600,
      padding: "12px 28px", borderRadius: 6, cursor: "pointer",
      background: C.blue, border: `1px solid ${C.blue}`,
      color: "#fff", ...style,
    }}>{children}</button>
  )
}

function OutlineBtn({ children, onClick }: { children: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} style={{
      fontFamily: SANS, fontSize: 15, fontWeight: 500,
      padding: "12px 28px", borderRadius: 6, cursor: "pointer",
      background: "transparent", border: `1px solid ${C.border}`,
      color: C.text,
    }}>{children}</button>
  )
}

// ─── MOCK SCORE CARD ────────────────────────────────────────────────────────────
function ScoreCard() {
  const positions = [
    { protocol: "Navi", asset: "USDC lend", status: "Healthy", color: C.safe },
    { protocol: "Scallop", asset: "SUI collateral", status: "At risk", color: C.danger },
    { protocol: "DeepBook", asset: "SUI margin", status: "Monitor", color: C.warn },
  ]
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`, borderRadius: 10,
      boxShadow: "0 4px 24px rgba(16,24,40,0.08)",
      overflow: "hidden", maxWidth: 420, width: "100%",
    }}>
      {/* Header */}
      <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.border}` }}>
        <div style={{ fontFamily: MONO, fontSize: 9, color: C.muted, letterSpacing: 3, marginBottom: 10 }}>
          PORTFOLIO RISK SCORE
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 10 }}>
          <span style={{ fontFamily: MONO, fontSize: 52, fontWeight: 700, color: C.danger, lineHeight: 1 }}>72</span>
          <span style={{ fontFamily: MONO, fontSize: 20, color: C.muted }}> /100</span>
        </div>
        {/* Progress bar */}
        <div style={{ height: 6, background: C.border, borderRadius: 3, overflow: "hidden", marginBottom: 12 }}>
          <div style={{ height: "100%", width: "72%", background: C.danger, borderRadius: 3 }} />
        </div>
        {/* Explanation box */}
        <div style={{
          borderLeft: `3px solid ${C.danger}`,
          background: `${C.danger}08`, borderRadius: "0 4px 4px 0",
          padding: "10px 12px 10px 12px",
        }}>
          <div style={{ fontFamily: SANS, fontSize: 12, color: C.text, lineHeight: 1.6 }}>
            SUI collateral at 68% LTV — one 15% price drop triggers liquidation. Consider adding collateral or reducing exposure.
          </div>
        </div>
      </div>
      {/* Position rows */}
      <div>
        {positions.map((p, i) => (
          <div key={i} style={{
            padding: "12px 20px",
            borderBottom: i < positions.length - 1 ? `1px solid ${C.border}` : "none",
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <div>
              <span style={{ fontFamily: SANS, fontSize: 13, color: C.text, fontWeight: 500 }}>{p.protocol}</span>
              <span style={{ fontFamily: SANS, fontSize: 12, color: C.muted, marginLeft: 8 }}>— {p.asset}</span>
            </div>
            <span style={{
              fontFamily: SANS, fontSize: 12, fontWeight: 600, color: p.color,
              background: `${p.color}14`, border: `1px solid ${p.color}44`,
              padding: "3px 10px", borderRadius: 4,
            }}>{p.status}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── FEATURE CARDS ──────────────────────────────────────────────────────────────
const FEATURES = [
  {
    icon: "◈",
    title: "AI risk score",
    desc: "Every position scored 0–100 using live oracle feeds and protocol health data. Updated every 30 seconds.",
  },
  {
    icon: "⚡",
    title: "Crash simulator",
    desc: "Stress-test your portfolio against a 10–80% market crash before it happens. See exact liquidation cascades.",
  },
  {
    icon: "💬",
    title: "AI advisor chat",
    desc: "Ask anything about your positions in plain English. Powered by Llama 3.3 with full portfolio context.",
  },
  {
    icon: "⛓",
    title: "One-click actions",
    desc: "When the AI recommends an action, preview it as a Move transaction and confirm on-chain in one click.",
  },
]

// ─── HOW IT WORKS ───────────────────────────────────────────────────────────────
const STEPS = [
  {
    n: "1",
    title: "Connect wallet",
    desc: "Link your Sui wallet. DeepSense scans Navi, Scallop, DeepBook, and 5 more protocols automatically.",
  },
  {
    n: "2",
    title: "Get score",
    desc: "Receive a live risk score with plain-English explanations of every risk factor in your portfolio.",
  },
  {
    n: "3",
    title: "Ask or simulate",
    desc: "Chat with the AI advisor or run a crash simulation to see exactly what happens to your positions.",
  },
  {
    n: "4",
    title: "Confirm and execute",
    desc: "When you're ready, approve the suggested action. The Move transaction is built and signed in your wallet.",
  },
]

// ─── LANDING PAGE ───────────────────────────────────────────────────────────────
export function Landing({ onLaunch }: LandingProps) {
  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: SANS }}>

      {/* ── TOP BAR ──────────────────────────────────────────────────────────── */}
      <header style={{
        borderBottom: `1px solid ${C.border}`, background: C.card,
        padding: "0 32px", display: "flex", alignItems: "center",
        height: 60, gap: 32,
        position: "sticky", top: 0, zIndex: 100,
      }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 6,
            background: C.blue, display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: MONO, fontSize: 13, fontWeight: 700, color: "#fff", letterSpacing: 1,
          }}>DS</div>
          <span style={{ fontFamily: SANS, fontSize: 16, fontWeight: 700, color: C.text }}>DeepSense</span>
        </div>

        {/* Nav links */}
        <nav style={{ display: "flex", gap: 28, flex: 1 }}>
          <NavLink onClick={() => scrollTo("how-it-works")}>How it works</NavLink>
          <NavLink onClick={() => scrollTo("protocols")}>Protocols</NavLink>
          <NavLink href="https://github.com/Feranjnr/deepsense" target="_blank" rel="noopener noreferrer">Docs</NavLink>
        </nav>

        {/* Launch button */}
        <button onClick={onLaunch} style={{
          fontFamily: SANS, fontSize: 14, fontWeight: 600,
          padding: "8px 20px", borderRadius: 6, cursor: "pointer",
          background: C.blue, border: `1px solid ${C.blue}`,
          color: "#fff", flexShrink: 0,
        }}>Launch app</button>
      </header>

      {/* ── HERO ─────────────────────────────────────────────────────────────── */}
      <section style={{
        padding: "80px 32px 64px",
        maxWidth: 1100, margin: "0 auto",
        display: "grid", gridTemplateColumns: "1fr auto",
        gap: 64, alignItems: "center",
      }}>
        <div>
          {/* Pill */}
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            background: `${C.blue}0f`, border: `1px solid ${C.blue}33`,
            borderRadius: 20, padding: "5px 14px", marginBottom: 24,
          }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: C.blue }} />
            <span style={{ fontFamily: SANS, fontSize: 12, color: C.blue, fontWeight: 500 }}>
              Agentic Web · Sui Overflow 2026
            </span>
          </div>

          {/* H1 */}
          <h1 style={{
            fontFamily: SANS, fontSize: 48, fontWeight: 800, lineHeight: 1.15,
            color: C.text, margin: "0 0 20px", letterSpacing: -0.5,
          }}>
            Your Sui DeFi positions,<br />
            <span style={{ color: C.blue }}>explained and protected</span>
          </h1>

          {/* Subtext */}
          <p style={{
            fontFamily: SANS, fontSize: 18, color: C.muted, lineHeight: 1.6,
            margin: "0 0 36px", maxWidth: 500,
          }}>
            DeepSense watches your on-chain positions, scores your risk in real time, and lets an AI advisor act on your behalf — with your approval.
          </p>

          {/* CTA buttons */}
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            <PrimaryBtn onClick={onLaunch}>Launch app — it's free</PrimaryBtn>
            <OutlineBtn onClick={() => scrollTo("how-it-works")}>See how it works</OutlineBtn>
          </div>
        </div>

        {/* Score card */}
        <ScoreCard />
      </section>

      {/* ── WHAT DEEPSENSE DOES ───────────────────────────────────────────────── */}
      <section style={{ padding: "64px 32px", background: C.card, borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ fontFamily: MONO, fontSize: 10, color: C.blue, letterSpacing: 3, marginBottom: 12 }}>
            WHAT DEEPSENSE DOES
          </div>
          <h2 style={{
            fontFamily: SANS, fontSize: 34, fontWeight: 800, color: C.text,
            margin: "0 0 40px", letterSpacing: -0.3,
          }}>
            Not a dashboard. An advisor that acts.
          </h2>
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 20,
          }}>
            {FEATURES.map((f) => (
              <div key={f.title} style={{
                background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
                padding: "24px 22px",
              }}>
                <div style={{ fontSize: 22, marginBottom: 12 }}>{f.icon}</div>
                <div style={{ fontFamily: SANS, fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 8 }}>
                  {f.title}
                </div>
                <div style={{ fontFamily: SANS, fontSize: 13, color: C.muted, lineHeight: 1.65 }}>
                  {f.desc}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ─────────────────────────────────────────────────────── */}
      <section id="how-it-works" style={{ padding: "72px 32px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ fontFamily: MONO, fontSize: 10, color: C.blue, letterSpacing: 3, marginBottom: 12 }}>
            HOW IT WORKS
          </div>
          <h2 style={{
            fontFamily: SANS, fontSize: 34, fontWeight: 800, color: C.text,
            margin: "0 0 48px", letterSpacing: -0.3,
          }}>
            Four steps to full clarity
          </h2>
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 24,
          }}>
            {STEPS.map((s) => (
              <div key={s.n} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{
                  width: 40, height: 40, borderRadius: "50%",
                  background: `${C.blue}14`, border: `1px solid ${C.blue}44`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: MONO, fontSize: 15, fontWeight: 700, color: C.blue,
                }}>{s.n}</div>
                <div style={{ fontFamily: SANS, fontSize: 16, fontWeight: 700, color: C.text }}>
                  {s.title}
                </div>
                <div style={{ fontFamily: SANS, fontSize: 13, color: C.muted, lineHeight: 1.65 }}>
                  {s.desc}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PROTOCOLS COVERED ────────────────────────────────────────────────── */}
      <section id="protocols" style={{ padding: "72px 32px", background: C.card, borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <h2 style={{
            fontFamily: SANS, fontSize: 28, fontWeight: 700, color: C.text,
            margin: "0 0 12px", letterSpacing: -0.2,
          }}>
            Protocols covered
          </h2>
          <p style={{
            fontFamily: SANS, fontSize: 15, color: C.muted, lineHeight: 1.6,
            margin: "0 0 36px",
          }}>
            DeepSense reads positions across Sui's major DeFi protocols — more being added continuously.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {["Navi Protocol","Scallop","Cetus","SuiLend","Bluefin","DeepBook","Aftermath Finance","Ember"].map(name => (
              <div key={name} style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                background: "#FFFFFF", border: "1px solid #E4E6EB",
                borderRadius: 9999, padding: "8px 16px",
              }}>
                <div style={{ width: 7, height: 7, borderRadius: "50%", background: C.blue, flexShrink: 0 }} />
                <span style={{ fontFamily: SANS, fontSize: 14, color: C.text, fontWeight: 500 }}>{name}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CLOSING BAND ─────────────────────────────────────────────────────── */}
      <section style={{
        background: C.blue, padding: "72px 32px", textAlign: "center",
      }}>
        <h2 style={{
          fontFamily: SANS, fontSize: 36, fontWeight: 800, color: "#fff",
          margin: "0 0 28px", letterSpacing: -0.3,
        }}>
          Know your risk before it knows you
        </h2>
        <PrimaryBtn onClick={onLaunch} style={{
          background: "#fff", color: C.blue, border: "1px solid #fff",
          fontSize: 16, padding: "14px 36px",
        }}>
          Launch DeepSense — free
        </PrimaryBtn>
      </section>

      {/* ── FOOTER ────────────────────────────────────────────────────────────── */}
      <footer style={{
        borderTop: `1px solid ${C.border}`, background: C.card,
        padding: "18px 32px", textAlign: "center",
        fontFamily: SANS, fontSize: 13, color: C.muted,
      }}>
        DeepSense · Built on Sui · Agentic Web Track · Sui Overflow 2026
      </footer>

    </div>
  )
}
