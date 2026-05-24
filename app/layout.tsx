import type { ReactNode } from "react"
import "./globals.css"
import "@mysten/dapp-kit/dist/index.css"
import Providers from "./Providers"

export const metadata = {
  title: "DeepSense — AI DeFi Risk Dashboard",
  description: "AI-powered Sui DeFi risk advisor. Portfolio stress-testing, DeepBook orderbook, and intelligent liquidation analysis.",
  themeColor: "#03080f",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
