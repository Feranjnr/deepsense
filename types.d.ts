
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

  export interface SuiJsonRpcClientOptions {
    url: string
    network: string
  }

  export interface SuiObjectResponse {
    data?: {
      content?: {
        dataType: string
        fields: Record<string, unknown>
        type?: string
      } | null
    } | null
  }

  export interface SuiEventId {
    txDigest: string
    eventSeq: string
  }

  export interface SuiEvent {
    id: SuiEventId
    type: string
    parsedJson: unknown
    timestampMs?: string | null
    packageId: string
    transactionModule: string
    sender: string
  }

  export interface PaginatedEvents {
    data: SuiEvent[]
    nextCursor?: SuiEventId | null
    hasNextPage: boolean
  }

  export interface SuiObjectDataOptions {
    showBcs?: boolean
    showContent?: boolean
    showDisplay?: boolean
    showOwner?: boolean
    showPreviousTransaction?: boolean
    showStorageRebate?: boolean
    showType?: boolean
  }

  export interface SuiObjectData {
    objectId: string
    version: string
    digest: string
    type?: string | null
    content?: {
      dataType: string
      fields: Record<string, unknown>
      type?: string
    } | null
  }

  export interface SuiObjectResponse {
    data?: SuiObjectData | null
    error?: unknown
  }

  export interface PaginatedObjectsResponse {
    data: SuiObjectResponse[]
    hasNextPage: boolean
    nextCursor?: string | null
  }

  export class SuiJsonRpcClient {
    constructor(options: SuiJsonRpcClientOptions)
    getObject(params: {
      id: string
      options?: { showContent?: boolean; showType?: boolean } | null
    }): Promise<SuiObjectResponse>
    queryEvents(params: {
      query: { MoveModule?: { package: string; module: string }; MoveEventType?: string }
      cursor?: SuiEventId | null
      limit?: number | null
      order?: "ascending" | "descending" | null
    }): Promise<PaginatedEvents>
    getOwnedObjects(params: {
      owner: string
      cursor?: string | null
      limit?: number | null
      filter?: unknown
      options?: SuiObjectDataOptions | null
    }): Promise<PaginatedObjectsResponse>
  }
}

declare module "@mysten/sui/transactions" {
  export class Transaction {
    moveCall(params: {
      target: string
      arguments?: any[]
      typeArguments?: string[]
    }): any
    object(id: string): any
    get pure(): {
      u64(val: number): any
      address(addr: string): any
      bool(val: boolean): any
    }
  }
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
