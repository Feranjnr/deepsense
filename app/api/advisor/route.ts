// app/api/advisor/route.ts
// Groq-compatible LLM proxy — DeepSense AI Advisor
export const runtime = "edge"

import { NextRequest } from "next/server"

const GROQ_API = "https://api.groq.com/openai/v1/chat/completions"

export async function POST(req: NextRequest) {
  try {
    const { messages, system, apiKey } = await req.json()
    const finalKey = apiKey || process.env.GROQ_API_KEY
    if (!finalKey) {
      return new Response(JSON.stringify({ error: "Missing apiKey" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      })
    }

    const llmMessages: { role: string; content: string }[] = []
    if (system) {
      llmMessages.push({ role: "system", content: system })
    }
    for (const m of messages) {
      llmMessages.push({ role: m.role, content: m.content || m.text || "" })
    }

    const res = await fetch(GROQ_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${finalKey}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: llmMessages,
        max_tokens: 1000,
        temperature: 0.4,
      }),
    })

    const data = await res.json()
    const reply = data.choices?.[0]?.message?.content || "No response from model."
    return new Response(JSON.stringify({ reply }), {
      headers: { "Content-Type": "application/json" },
    })
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    })
  }
}
