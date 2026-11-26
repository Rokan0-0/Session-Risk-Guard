import type { MarketTick, Position, PriceAlert, SessionState, SymbolCode } from './types'

const BINANCE_WS =
  'wss://stream.binance.com:9443/stream?streams=btcusdt@miniTicker/ethusdt@miniTicker/solusdt@miniTicker'

const INITIAL_PRICES: Record<SymbolCode, MarketTick> = {
  BTCUSDT: { symbol: 'BTCUSDT', price: 94500, change24hPct: 1.42, updatedAt: Date.now() },
  ETHUSDT: { symbol: 'ETHUSDT', price: 3320, change24hPct: -0.85, updatedAt: Date.now() },
  SOLUSDT: { symbol: 'SOLUSDT', price: 238.5, change24hPct: 3.15, updatedAt: Date.now() },
  NVDA: { symbol: 'NVDA', price: 142.5, change24hPct: 1.85, updatedAt: Date.now() },
  SPY: { symbol: 'SPY', price: 598.2, change24hPct: 0.44, updatedAt: Date.now() },
}

export function createDefaultPositions(prices: Record<SymbolCode, MarketTick>): Position[] {
  const btc = prices.BTCUSDT.price
  const eth = prices.ETHUSDT.price
  const sol = prices.SOLUSDT.price
  const nvda = prices.NVDA.price

  return [
    {
      id: 'pos-btc',
      venue: 'BINANCE',
      assetClass: 'CRYPTO',
      symbol: 'BTCUSDT',
      label: 'BTC-PERP',
      side: 'LONG',
      size: 0.25,
      entryPrice: Number((btc * 0.996).toFixed(2)),
      stopPrice: Number((btc * 0.975).toFixed(2)),
      alertDrawdownPct: -1.8,
      snoozedUntil: 0,
    },
    {
      id: 'pos-eth',
      venue: 'BYBIT',
      assetClass: 'CRYPTO',
      symbol: 'ETHUSDT',
      label: 'ETH-PERP',
      side: 'LONG',
      size: 4.0,
      entryPrice: Number((eth * 1.003).toFixed(2)),
      stopPrice: Number((eth * 0.98).toFixed(2)),
      alertDrawdownPct: -1.8,
      snoozedUntil: 0,
    },
    {
      id: 'pos-sol',
      venue: 'OKX',
      assetClass: 'CRYPTO',
      symbol: 'SOLUSDT',
      label: 'SOL-PERP',
      side: 'SHORT',
      size: 35,
      entryPrice: Number((sol * 1.005).toFixed(2)),
      stopPrice: Number((sol * 1.028).toFixed(2)),
      alertDrawdownPct: -1.8,
      snoozedUntil: 0,
    },
    {
      id: 'pos-coin',
      venue: 'COINBASE',
      assetClass: 'CRYPTO',
      symbol: 'BTCUSDT',
      label: 'BTC-USD',
      side: 'LONG',
      size: 0.1,
      entryPrice: Number((btc * 0.992).toFixed(2)),
      stopPrice: Number((btc * 0.968).toFixed(2)),
      alertDrawdownPct: -2.0,
      snoozedUntil: 0,
    },
    {
      id: 'pos-nvda',
      venue: 'IBKR',
      assetClass: 'STOCK',
      symbol: 'NVDA',
      label: 'NVDA',
      side: 'LONG',
      size: 40,
      entryPrice: Number((nvda * 0.994).toFixed(2)),
      stopPrice: Number((nvda * 0.97).toFixed(2)),
      alertDrawdownPct: -1.8,
      snoozedUntil: 0,
    },
  ]
}

export function createDefaultPriceAlerts(prices: Record<SymbolCode, MarketTick>): PriceAlert[] {
  const btcTarget = Math.round(prices.BTCUSDT.price * 1.015)
  const nvdaTarget = Number((prices.NVDA.price * 0.985).toFixed(2))

  return [
    {
      id: 'pa-btc-up',
      symbol: 'BTCUSDT',
      label: `BTC > $${btcTarget.toLocaleString('en-US')}`,
      direction: 'ABOVE',
      targetPrice: btcTarget,
      triggered: false,
      snoozedUntil: 0,
    },
    {
      id: 'pa-nvda-dn',
      symbol: 'NVDA',
      label: `NVDA < $${nvdaTarget.toFixed(2)}`,
      direction: 'BELOW',
      targetPrice: nvdaTarget,
      triggered: false,
      snoozedUntil: 0,
    },
  ]
}

export function anchorSymbolDefaults(state: SessionState, symbol: SymbolCode, livePrice: number): void {
  const templatePositions = createDefaultPositions(state.prices)
  for (const pos of state.positions) {
    if (pos.symbol !== symbol) continue
    const tpl = templatePositions.find(p => p.id === pos.id)
    if (!tpl) continue
    pos.entryPrice = tpl.entryPrice
    pos.stopPrice = tpl.stopPrice
  }
  if (symbol === 'BTCUSDT') {
    const btcTarget = Math.round(livePrice * 1.015)
    const defAlert = state.priceAlerts.find(a => a.id === 'pa-btc-up')
    if (defAlert && !defAlert.triggered) {
      defAlert.targetPrice = btcTarget
      defAlert.label = `BTC > $${btcTarget.toLocaleString('en-US')}`
    }
  }
}

export function computePositionMetrics(pos: Position, markPrice: number) {
  const dir = pos.side === 'LONG' ? 1 : -1
  const pnlUsd = (markPrice - pos.entryPrice) * pos.size * dir
  const notional = pos.entryPrice * pos.size
  const pnlPct = notional > 0 ? (pnlUsd / notional) * 100 : 0
  return { pnlUsd, pnlPct, notional }
}

export function getEffectivePrice(state: SessionState, symbol: SymbolCode): number {
  const base = state.prices[symbol].price
  const offset = state.priceOffsets[symbol] ?? 0
  return Math.max(0.01, base * (1 + offset))
}

export function computeTotalUnrealizedPnl(state: SessionState): number {
  return state.positions.reduce((sum, pos) => {
    if (pos.size <= 0) return sum
    const mark = getEffectivePrice(state, pos.symbol)
    return sum + computePositionMetrics(pos, mark).pnlUsd
  }, 0)
}

export function computeTotalOpenNotional(state: SessionState): number {
  return state.positions.reduce((sum, pos) => {
    if (pos.size <= 0) return sum
    const mark = getEffectivePrice(state, pos.symbol)
    return sum + mark * pos.size
  }, 0)
}

export function computeMarginHealthPct(state: SessionState): number {
  return computeProjectedMarginHealthPct(state, 0)
}

export function computeProjectedMarginHealthPct(state: SessionState, deltaMarginUsd: number): number {
  const totalNotional = computeTotalOpenNotional(state)
  if (totalNotional <= 0) return 999
  const unrealized = computeTotalUnrealizedPnl(state)
  const equity = Math.max(0, state.balances.marginUsd + deltaMarginUsd + unrealized)
  // 3.4% blended maintenance margin requirement across active book
  const maintenanceReq = Math.max(400, totalNotional * 0.034)
  return Math.min(999, Math.round((equity / maintenanceReq) * 100))
}

async function signHmacSha256(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function sendBinanceTestnetOrder(
  apiKey: string,
  apiSecret: string,
  symbol: SymbolCode,
  side: 'BUY' | 'SELL',
  quantity: number,
): Promise<{ ok: boolean; detail: string }> {
  if (symbol === 'NVDA' || symbol === 'SPY') {
    return { ok: false, detail: 'Paper/IBKR equity symbol — not routed to Binance Futures' }
  }
  try {
    const timestamp = Date.now()
    const qty = quantity.toFixed(symbol === 'BTCUSDT' ? 3 : symbol === 'ETHUSDT' ? 2 : 0)
    const query = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${timestamp}`
    const signature = await signHmacSha256(apiSecret, query)
    const url = `https://testnet.binancefuture.com/fapi/v1/order?${query}&signature=${signature}`

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': apiKey },
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, detail: `Testnet ${res.status}: ${body?.msg ?? 'Order rejected'}` }
    }
    return { ok: true, detail: `Testnet orderId #${body.orderId ?? 'OK'}` }
  } catch (err) {
    return { ok: false, detail: `Testnet network/CORS: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export function createInitialState(): SessionState {
  const prices = structuredClone(INITIAL_PRICES)
  const state: SessionState = {
    connected: false,
    glassesConnected: false,
    status: 'ARMED',
    activeScreen: 'PORTFOLIO',
    lastInputSource: 'UI',
    activeIndex: 0,
    activeVenueFilter: 'ALL',
    alertPositionId: null,
    activePriceAlertId: null,
    pendingConfirmation: null,
    lastReceipt: null,
    prices,
    priceOffsets: { BTCUSDT: 0, ETHUSDT: 0, SOLUSDT: 0, NVDA: 0, SPY: 0 },
    positions: createDefaultPositions(prices),
    priceAlerts: createDefaultPriceAlerts(prices),
    balances: {
      spotUsd: 4250,
      marginUsd: 1800,
      marginHealthPct: 165,
    },
    safety: {
      maxSingleTransferUsd: 1000,
      dailyLossLimitUsd: 1500,
      requireConfirm: true,
    },
    voice: {
      listening: false,
      ttsEnabled: false,
      lastTranscript: '',
      lastParsedSummary: 'Ready — say "Move 500 to margin", "Close half", or "Alert BTC at 96k"',
      g2MicActive: false,
    },
    realizedPnl: 0,
    logs: [
      {
        id: 'init-1',
        timestamp: new Date().toLocaleTimeString(),
        level: 'info',
        message: 'Session Risk Guard armed across Binance, Bybit, OKX, Coinbase & IBKR.',
      },
    ],
    testnet: {
      enabled: false,
      apiKey: '',
      apiSecret: '',
    },
  }
  state.balances.marginHealthPct = computeMarginHealthPct(state)
  return state
}

export function connectBinanceStream(
  onTick: (tick: MarketTick) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  let ws: WebSocket | null = null
  let closedByCaller = false
  let retryTimer: number | null = null

  const connect = () => {
    if (closedByCaller) return
    ws = new WebSocket(BINANCE_WS)

    ws.onopen = () => onStatus(true)

    ws.onmessage = evt => {
      try {
        const msg = JSON.parse(evt.data as string)
        const d = msg?.data
        if (!d?.s || !d?.c) return
        const symbol = String(d.s).toUpperCase() as SymbolCode
        if (symbol !== 'BTCUSDT' && symbol !== 'ETHUSDT' && symbol !== 'SOLUSDT') return
        const price = Number(d.c)
        const open = Number(d.o)
        const change24hPct = open > 0 ? ((price - open) / open) * 100 : 0
        onTick({ symbol, price, change24hPct, updatedAt: Date.now() })
      } catch {
        // Ignore malformed frame
      }
    }

    ws.onclose = () => {
      onStatus(false)
      if (!closedByCaller) {
        retryTimer = window.setTimeout(connect, 2500)
      }
    }

    ws.onerror = () => {
      ws?.close()
    }
  }

  connect()

  return () => {
    closedByCaller = true
    if (retryTimer !== null) clearTimeout(retryTimer)
    ws?.close()
  }
}

export function startSimulatedStockFeed(
  getPrices: () => Record<SymbolCode, MarketTick>,
  onTick: (tick: MarketTick) => void,
): () => void {
  const stockSymbols: Array<{ symbol: 'NVDA' | 'SPY'; anchor: number; vol: number }> = [
    { symbol: 'NVDA', anchor: INITIAL_PRICES.NVDA.price, vol: 0.0014 },
    { symbol: 'SPY', anchor: INITIAL_PRICES.SPY.price, vol: 0.0005 },
  ]

  const timer = window.setInterval(() => {
    const prices = getPrices()
    for (const item of stockSymbols) {
      const prev = prices[item.symbol]
      const drift = (Math.random() - 0.49) * item.vol
      const nextPrice = Number(Math.max(1, prev.price * (1 + drift)).toFixed(2))
      const change24hPct = ((nextPrice - item.anchor) / item.anchor) * 100 + 1.0
      onTick({
        symbol: item.symbol,
        price: nextPrice,
        change24hPct: Number(change24hPct.toFixed(2)),
        updatedAt: Date.now(),
      })
    }
  }, 1800)

  return () => window.clearInterval(timer)
}
