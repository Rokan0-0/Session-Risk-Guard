export type VenueId = 'BINANCE' | 'OKX' | 'BYBIT' | 'COINBASE' | 'IBKR'

export type SymbolCode = 'BTCUSDT' | 'ETHUSDT' | 'SOLUSDT' | 'NVDA' | 'SPY'

export type Side = 'LONG' | 'SHORT'

export type AssetClass = 'CRYPTO' | 'STOCK'

export type InputSource = 'GLASSES' | 'RING' | 'VOICE' | 'UI'

export interface Position {
  id: string
  venue: VenueId
  assetClass: AssetClass
  symbol: SymbolCode
  label: string
  side: Side
  size: number
  entryPrice: number
  stopPrice: number
  alertDrawdownPct: number // e.g. -1.8 triggers risk alert
  snoozedUntil: number
}

export interface MarketTick {
  symbol: SymbolCode
  price: number
  change24hPct: number
  updatedAt: number
}

export interface AccountBalances {
  spotUsd: number
  marginUsd: number
  marginHealthPct: number
}

export interface SafetyLimits {
  maxSingleTransferUsd: number
  dailyLossLimitUsd: number
  requireConfirm: boolean
}

export interface PriceAlert {
  id: string
  symbol: SymbolCode
  label: string
  direction: 'ABOVE' | 'BELOW'
  targetPrice: number
  triggered: boolean
  snoozedUntil: number
}

export type PendingActionKind =
  | 'transfer_spot_to_margin'
  | 'transfer_margin_to_spot'
  | 'close_50'
  | 'move_stop_entry'

export interface PendingConfirmation {
  id: string
  kind: PendingActionKind
  promptTitle: string
  detailLine: string
  amountUsd?: number
  positionId?: string
  source: InputSource
  createdAt: number
}

export interface VoiceState {
  listening: boolean
  ttsEnabled: boolean
  lastTranscript: string
  lastParsedSummary: string
  g2MicActive: boolean
}

export interface OrderLog {
  id: string
  timestamp: string
  level: 'info' | 'warn' | 'alert'
  message: string
}

export type RiskStatus = 'ARMED' | 'ALERT' | 'CONFIRM' | 'EXECUTED'

export type HudScreen = 'PORTFOLIO' | 'POSITIONS' | 'WALLET' | 'ALERTS'

export interface ExecutionReceipt {
  ok: boolean
  title: string
  detail: string
  source: InputSource
  expiresAt: number
}

export interface TestnetConfig {
  enabled: boolean
  apiKey: string
  apiSecret: string
}

export interface SessionState {
  connected: boolean
  glassesConnected: boolean
  status: RiskStatus
  activeScreen: HudScreen
  lastInputSource: InputSource
  activeIndex: number
  activeVenueFilter: VenueId | 'ALL'
  alertPositionId: string | null
  activePriceAlertId: string | null
  pendingConfirmation: PendingConfirmation | null
  lastReceipt: ExecutionReceipt | null
  prices: Record<SymbolCode, MarketTick>
  priceOffsets: Record<SymbolCode, number>
  positions: Position[]
  priceAlerts: PriceAlert[]
  balances: AccountBalances
  transferAmountUsd: number
  safety: SafetyLimits
  voice: VoiceState
  realizedPnl: number
  logs: OrderLog[]
  testnet: TestnetConfig
}
