
// @mysten/dapp-kit stubs – real types ship in .mjs only, this satisfies TS
declare module "@mysten/dapp-kit" {
  import { ComponentType, ReactNode } from "react"

  // Core providers
  export interface WalletProviderProps {
    children?: ReactNode
    autoConnect?: boolean
  }
  export const WalletProvider: ComponentType<WalletProviderProps>
  export interface SuiClientProviderProps {
    children?: ReactNode
    defaultNetwork?: string
    networks?: Record<string, { url: string }>
    networkConfig?: any
  }
  export const SuiClientProvider: ComponentType<SuiClientProviderProps>

  // ConnectButton
  export interface ConnectButtonProps {
    children?: ReactNode
    connectText?: string | { default: string; connecting: string }
    style?: any
  }
  export const ConnectButton: ComponentType<ConnectButtonProps>

  // Hooks — type-safe enough for TS compilation:
  export interface Account {
    address: string
    chains: string[]
    publicKey?: { toSuiAddress: () => string }
  }
  export function useCurrentAccount(): Account | null
  export function useWallets(): any[]
  export function useConnectWallet(): any
  export function useDisconnectWallet(): any
  export function useCurrentWallet(): any
  export function useSuiClient(): any
}

// @mysten/sui stubs
declare module "@mysten/sui" {
  // provisionally empty — all typing done via any at runtime
}

// @tanstack/react-query stubs (re-exported in Providers)
declare module "@tanstack/react-query" {
  export class QueryClient {
    constructor()
  }
  export interface QueryClientProviderProps { children: ReactNode; client: QueryClient }
  export const QueryClientProvider: ComponentType<QueryClientProviderProps>
}
