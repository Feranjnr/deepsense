export const runtime = "edge"

const SYSTEM = `You are a DeFi intent parser for the Navi Protocol on Sui.
Extract the user's action and return ONLY valid JSON with these exact fields:
{
  "action": "supply" | "borrow" | "withdraw" | "repay" | "unknown",
  "asset": "SUI" | "USDC" | "USDT" | "WETH" | "WBTC" | "CETUS" | "DEEP" | "NAVX" | "BLUE" | "WAL" | "WSOL" | "BUCK",
  "amount": <positive number>,
  "protocol": "navi",
  "reason": "<one sentence describing the action>"
}

Rules:
- action must be one of: supply, borrow, withdraw, repay. Use "unknown" if unclear.
- asset must be one of the listed tokens. Use "SUI" if unclear but a token is needed.
- amount must be a positive number. If unclear or missing, use 0 and set action to "unknown".
- reason is a human-readable description of what the transaction will do.
- Return ONLY the JSON object, no explanation.

Examples:
"supply 10 SUI to Navi" → {"action":"supply","asset":"SUI","amount":10,"protocol":"navi","reason":"Supply 10 SUI as collateral to Navi Finance"}
"borrow 50 USDC" → {"action":"borrow","asset":"USDC","amount":50,"protocol":"navi","reason":"Borrow 50 USDC from Navi Finance against your collateral"}
"withdraw 5 WAL" → {"action":"withdraw","asset":"WAL","amount":5,"protocol":"navi","reason":"Withdraw 5 WAL from your Navi supply position"}
"repay my USDC debt" → {"action":"unknown","asset":"USDC","amount":0,"protocol":"navi","reason":"Amount not specified — please include how much to repay"}`

export async function POST(req: Request) {
  const groqKey = process.env.GROQ_API_KEY
  if (!groqKey) {
    return Response.json({ action: "unknown", asset: "", amount: 0, protocol: "navi", reason: "", error: "GROQ_API_KEY not configured" })
  }

  let input = "", riskScore = 0, riskLevel = "LOW"
  try {
    const body = await req.json()
    input = body.input ?? ""
    riskScore = body.riskScore ?? 0
    riskLevel = body.riskLevel ?? "LOW"
  } catch {
    return Response.json({ action: "unknown", error: "Invalid request body" })
  }

  if (!input.trim()) {
    return Response.json({ action: "unknown", error: "Empty input" })
  }

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Current market risk: ${riskScore}/100 (${riskLevel}). User intent: "${input}"` },
        ],
        response_format: { type: "json_object" },
        max_tokens: 200,
        temperature: 0,
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      return Response.json({ action: "unknown", error: `Groq API error: ${err.slice(0, 120)}` })
    }

    const data = await res.json()
    const text: string = data.choices?.[0]?.message?.content ?? "{}"
    const parsed = JSON.parse(text)

    // Validate required fields
    if (!["supply","borrow","withdraw","repay","unknown"].includes(parsed.action)) {
      parsed.action = "unknown"
    }
    if (typeof parsed.amount !== "number" || parsed.amount < 0) {
      parsed.amount = 0
      parsed.action = "unknown"
    }

    return Response.json(parsed)
  } catch (e: any) {
    return Response.json({ action: "unknown", error: e?.message ?? "Parse failed" })
  }
}
