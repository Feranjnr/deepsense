# DeepSense

**AI-powered DeFi risk guardian for Sui — monitors your on-chain positions in real time, scores market risk, and dispatches autonomous actions through a deployed Move contract.**

---

## What it does

DeepSense combines a live risk-scoring engine with an on-chain AI guardian contract to protect Sui DeFi positions from correlated market crashes and stablecoin de-pegs.

The **risk engine** runs in the browser, pulling prices from CoinGecko and Pyth Network every polling cycle. It scores four risk dimensions — price crash severity, intra-session volatility clustering, cross-asset correlation (SUI + ETH declining together), and stablecoin de-peg — into a single 0–100 score with a band: LOW / MEDIUM / HIGH / CRITICAL.

The **RiskGuardian Move contract** sits on Sui Testnet as a shared object. When the risk score diverges from the on-chain value by ≥ 10 points, the dashboard prompts the agent wallet to call `update_risk_score`. When the score exceeds 90, it calls `pause_protocol`. Every action is an immutable on-chain transaction — auditable forever.

The **AI Advisor** (Groq / Llama 3.3-70B) receives a grounded system prompt built from the live risk score, active risk factors, the user's detected on-chain positions across 8 Sui DeFi protocols, and the current guardian policy state. It gives portfolio-specific advice rather than generic responses.

---

## AI agent + Move contract safety model

```
Browser risk engine
  │  scores 0–100, builds reasons[]
  ▼
Agent wallet (user-held)
  │  signs update_risk_score / pause_protocol
  ▼
RiskGuardian shared object (Sui Testnet)
  │  enforces action budget (max_actions cap)
  │  records every action in on-chain events
  ▼
Admin (AdminCap holder)
  │  can: adjust parameters, revoke agent, resume protocol
  │  cannot: bypass the action budget check
  └─ override always requires a signed transaction — no backdoor
```

The agent wallet can only call functions the Move contract allows. The `AdminCap` is a separate owned object; whoever holds it can adjust parameters or revoke the agent entirely via `admin_adjust_parameters` and `revoke_agent`. All overrides are on-chain and permanent — there is no off-chain master key or privileged API.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16.2.6 (Turbopack, App Router) · React 19 |
| Sui integration | `@mysten/dapp-kit` v1 · `@mysten/sui` v2 |
| Prices | CoinGecko REST · Pyth Network Hermes (BTC, ETH, SUI) |
| On-chain positions | Custom scanner across 8 protocols: Navi, Cetus, Turbos, FlowX, Aftermath, Bluefin, DeepBook, Suilend |
| AI advisor | Groq API · `llama-3.3-70b-versatile` · edge runtime |
| Smart contract | Move on Sui Testnet |
| Fonts | IBM Plex Mono · IBM Plex Sans |

---

## Deployed testnet contracts

From `app/config/contracts.ts`:

| Object | ID |
|---|---|
| Package | `0xfa8f2cc06832e8ea02b2c92cf83a72815feb7a5433918ba1aeb275425dce14bd` |
| RiskPolicy (shared) | `0x3ee09dcedb3a71366640368320ed4c586299a9b7dd0ace7246727b1a0994c726` |
| AdminCap (owned) | `0xb052d42d2fd1f725609b431db0ab93dbbdd8a4f5cda7d13fc58c6cdf1d1e7896` |
| Network | Sui Testnet |
| Module | `risk_guardian` |

View on Sui Explorer: `https://suiscan.xyz/testnet/object/<POLICY_ID>`

---

## Run locally

**Prerequisites:** Node.js 18+, a Sui-compatible browser wallet (Sui Wallet, Slush, etc.)

```bash
# 1. Install dependencies
npm install

# 2. Set environment variables
cp .env.local.example .env.local   # then fill in GROQ_API_KEY

# 3. Start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Connect your Sui Testnet wallet to unlock the Guardian and position scanner.

**Environment variables:**

| Variable | Purpose |
|---|---|
| `GROQ_API_KEY` | Groq API key for the AI Advisor (get one free at console.groq.com) |

Without `GROQ_API_KEY` the app runs fully — only the AI chat tab shows a configuration prompt.

**Production build:**

```bash
npm run build
npm start
```

---

## Key files

```
app/
  page.tsx                  — main app shell, all tabs, risk engine wiring
  components/
    RiskGauge.tsx           — animated SVG circular gauge (0–100)
    DecisionPipeline.tsx    — 5-stage pipeline stepper (price drop → on-chain confirm)
  hooks/
    useRiskEngine.ts        — scoring engine (CoinGecko + Pyth → risk score)
    useRiskGuardian.ts      — reads on-chain PolicyState every 10s
    useProtocolPositions.ts — scans 8 Sui DeFi protocols for user positions
    usePythPrices.ts        — Pyth Hermes price feed
    useCoinGeckoPrices.ts   — CoinGecko price + 24h change feed
  config/
    contracts.ts            — deployed contract addresses
  api/
    advisor/route.ts        — edge function: proxies to Groq with enriched system prompt
```
