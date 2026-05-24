
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

  // ConnectModal
  export interface ConnectModalProps {
    open?: boolean
    onOpenChange?: (open: boolean) => void
    trigger?: ReactNode
  }
  export const ConnectModal: ComponentType<ConnectModalProps>

  // Network config helper
  export function createNetworkConfig(config: Record<string, { url: string }>): any

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
  export function useSuiClientContext(): any
  export function useAccounts(): Account[]
  export function useSignAndExecuteTransaction(): any
  export function useSignTransaction(): any
}

// @mysten/sui subpath stubs
declare module "@mysten/sui/jsonRpc" {
  export function getJsonRpcFullnodeUrl(network: string): string
}

declare module "@mysten/sui/client" {
  export class SuiClient {
    constructor(options: { url: string })
    getAllBalances(params: { owner: string }): Promise<any[]>
    getCoins(params: { owner: string; coinType?: string }): Promise<any>
    getBalance(params: { owner: string; coinType?: string }): Promise<any>
  }
}

// @tanstack/react-query stubs (re-exported in Providers)
declare module "@tanstack/react-query" {
  import { ComponentType, ReactNode } from "react"
  export class QueryClient {
    constructor()
  }
  export interface QueryClientProviderProps { children: ReactNode; client: QueryClient }
  export const QueryClientProvider: ComponentType<QueryClientProviderProps>
}
