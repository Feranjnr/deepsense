"use client"

import { type ReactNode, useMemo } from "react"
import { SuiClientProvider, WalletProvider, createNetworkConfig } from "@mysten/dapp-kit"
import { getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "https://fullnode.mainnet.sui.io"
const { networkConfig } = createNetworkConfig({
  testnet: { url: RPC },
  mainnet: { url: getJsonRpcFullnodeUrl("mainnet") },
})

export default function Providers({ children }: { children: ReactNode }) {
  const queryClient = useMemo(() => new QueryClient(), [])
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork="mainnet">
        <WalletProvider autoConnect>{children}</WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  )
}
