import {
  anchorSymbolDefaults,
  computeMarginHealthPct,
  computePositionMetrics,
  computeProjectedMarginHealthPct,
  computeTotalUnrealizedPnl,
  createDefaultPositions,
  createDefaultPriceAlerts,
  createInitialState,
  getEffectivePrice,
  sendBinanceTestnetOrder,
} from './exchange'
import type { HudAction } from './glasses'
import type {
  HudScreen,
  InputSource,
  MarketTick,
  PendingActionKind,
  Position,
  SessionState,
  SymbolCode,
  VenueId,
} from './types'
import { formatIntentSummary, parseVoiceCommand } from './voice'

export interface RiskGuardEngineOptions {
  now?: () => number
  onSpeak?: (text: string) => void
  sendTestnetOrder?: typeof sendBinanceTestnetOrder
}

function fmtUsd(val: number): string {
  const sign = val >= 0 ? '+' : '-'
  return `${sign}$${Math.abs(val).toFixed(2)}`
}

export class RiskGuardEngine {
  private state: SessionState
  private anchoredSymbols = new Set<SymbolCode>()
  private dailyLossWarned = false
  private readonly now: () => number
  private readonly onSpeak?: (text: string) => void
  private readonly sendTestnetOrder: typeof sendBinanceTestnetOrder

  constructor(options: RiskGuardEngineOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.onSpeak = options.onSpeak
    this.sendTestnetOrder = options.sendTestnetOrder ?? sendBinanceTestnetOrder
    this.state = createInitialState()
  }

  getState(): SessionState {
    return this.state
  }

  private addLog(level: 'info' | 'warn' | 'alert', message: string): void {
    this.state.logs.unshift({
      id: `${this.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date(this.now()).toLocaleTimeString(),
      level,
      message,
    })
    if (this.state.logs.length > 60) this.state.logs.length = 60
  }

  private maybeSpeak(text: string): void {
    if (this.state.voice.ttsEnabled) {
      this.onSpeak?.(text)
    }
  }

  private setReceipt(ok: boolean, title: string, detail: string, source: InputSource, ttlMs = 4000): void {
    this.state.lastReceipt = {
      ok,
      title,
      detail,
      source,
      expiresAt: this.now() + ttlMs,
    }
  }

  getTargetPosition(preferredSymbol?: SymbolCode): Position | undefined {
    if (preferredSymbol) {
      const bySym = this.state.positions.find(p => p.symbol === preferredSymbol && p.size > 0)
      if (bySym) return bySym
    }
    if (this.state.alertPositionId) {
      const alerted = this.state.positions.find(p => p.id === this.state.alertPositionId && p.size > 0)
      if (alerted) return alerted
    }
    return this.state.positions[this.state.activeIndex] ?? this.state.positions.find(p => p.size > 0)
  }

  private refreshDerivedState(): void {
    this.state.balances.marginHealthPct = computeMarginHealthPct(this.state)
    if (this.state.pendingConfirmation) {
      this.state.status = 'CONFIRM'
    } else if (this.state.alertPositionId || this.state.activePriceAlertId) {
      this.state.status = 'ALERT'
    } else if (this.state.status !== 'EXECUTED') {
      this.state.status = 'ARMED'
    }
  }

  expireReceiptIfNeeded(): boolean {
    if (this.state.lastReceipt && this.now() >= this.state.lastReceipt.expiresAt) {
      this.state.lastReceipt = null
      return true
    }
    return false
  }

  setConnected(connected: boolean): void {
    this.state.connected = connected
  }

  setGlassesConnected(connected: boolean): void {
    this.state.glassesConnected = connected
    if (connected) {
      this.addLog('info', 'Even G2 HUD connected via Even Hub Bridge (Ring & Temple ready).')
    }
  }

  setVoiceState(patch: Partial<SessionState['voice']>): void {
    this.state.voice = { ...this.state.voice, ...patch }
  }

  setScreen(screen: HudScreen, source: InputSource = 'UI'): void {
    this.state.lastInputSource = source
    this.state.activeScreen = screen
    this.state.lastReceipt = null
    if (source === 'UI' || source === 'VOICE') {
      this.state.pendingConfirmation = null
      const now = this.now()
      if (this.state.alertPositionId) {
        const pos = this.state.positions.find(p => p.id === this.state.alertPositionId)
        if (pos) pos.snoozedUntil = now + 60 * 1000
        this.state.alertPositionId = null
      }
      if (this.state.activePriceAlertId) {
        const alert = this.state.priceAlerts.find(a => a.id === this.state.activePriceAlertId)
        if (alert) alert.snoozedUntil = now + 60 * 1000
        this.state.activePriceAlertId = null
      }
      this.refreshDerivedState()
    }
  }

  selectPosition(idx: number): void {
    if (idx >= 0 && idx < this.state.positions.length) {
      this.state.activeIndex = idx
      this.state.activeScreen = 'POSITIONS'
      this.state.lastReceipt = null
    }
  }

  selectVenueFilter(venue: VenueId | 'ALL'): void {
    this.state.activeVenueFilter = venue
  }

  setTtsEnabled(enabled: boolean): void {
    this.state.voice.ttsEnabled = enabled
    this.addLog('info', enabled ? 'Voice TTS readout enabled.' : 'Voice TTS readout muted.')
  }

  setRequireConfirm(required: boolean): void {
    this.state.safety.requireConfirm = required
    this.addLog(
      'info',
      required
        ? 'Safety Gate ON: Mandatory Yes/No confirmation before money/order actions.'
        : 'Safety Gate OFF: Instant 1-tap execution enabled.',
    )
  }

  setTestnet(enabled: boolean, apiKey: string, apiSecret: string): void {
    this.state.testnet = { enabled, apiKey, apiSecret }
    this.addLog(
      'info',
      enabled
        ? 'Binance Futures Testnet enabled (keys held in ephemeral memory only).'
        : 'Switched to Paper Exchange mode (ephemeral keys cleared).',
    )
  }

  applyMarketTick(tick: MarketTick, isLiveCrypto: boolean): void {
    this.state.prices[tick.symbol] = tick
    const untouchedForSymbol =
      this.state.realizedPnl === 0 &&
      !this.state.pendingConfirmation &&
      this.state.priceOffsets[tick.symbol] === 0

    if (isLiveCrypto && !this.anchoredSymbols.has(tick.symbol)) {
      this.anchoredSymbols.add(tick.symbol)
      if (untouchedForSymbol) {
        anchorSymbolDefaults(this.state, tick.symbol, tick.price)
        if (this.anchoredSymbols.size === 1) {
          this.addLog('info', `Live Binance feed connected (${tick.symbol} $${tick.price.toLocaleString()}).`)
        }
      }
    }
    this.evaluateRiskAlerts()
    this.evaluatePriceAlerts()
    this.refreshDerivedState()
  }

  evaluateRiskAlerts(): void {
    const now = this.now()
    for (const pos of this.state.positions) {
      if (pos.size <= 0 || pos.snoozedUntil > now) continue
      const mark = getEffectivePrice(this.state, pos.symbol)
      const { pnlPct } = computePositionMetrics(pos, mark)
      if (pnlPct <= pos.alertDrawdownPct) {
        if (this.state.alertPositionId !== pos.id) {
          this.state.alertPositionId = pos.id
          if (!this.state.pendingConfirmation) this.state.status = 'ALERT'
          const msg = `RISK ALERT [${pos.venue}]: ${pos.label} hit ${pnlPct.toFixed(2)}% (guard ${pos.alertDrawdownPct}%).`
          this.addLog('alert', msg)
          this.maybeSpeak(`Risk alert on ${pos.label}. Down ${Math.abs(pnlPct).toFixed(1)} percent.`)
        }
        break
      }
    }

    const totalPnl = computeTotalUnrealizedPnl(this.state) + this.state.realizedPnl
    if (!this.dailyLossWarned && totalPnl <= -this.state.safety.dailyLossLimitUsd) {
      this.dailyLossWarned = true
      this.addLog(
        'alert',
        `DAILY LOSS LIMIT HIT: Session ${fmtUsd(totalPnl)} breached -$${this.state.safety.dailyLossLimitUsd} cap.`,
      )
    }
  }

  evaluatePriceAlerts(): void {
    const now = this.now()
    for (const alert of this.state.priceAlerts) {
      if (alert.triggered || alert.snoozedUntil > now) continue
      const mark = getEffectivePrice(this.state, alert.symbol)
      const crossed =
        alert.direction === 'ABOVE' ? mark >= alert.targetPrice : mark <= alert.targetPrice
      if (crossed) {
        alert.triggered = true
        this.state.activePriceAlertId = alert.id
        if (!this.state.pendingConfirmation) this.state.status = 'ALERT'
        this.addLog('alert', `PRICE ALERT: ${alert.label} triggered @ $${mark.toFixed(2)}.`)
        this.maybeSpeak(`Price alert triggered: ${alert.label}.`)
        return
      }
    }
  }

  requestConfirmation(
    kind: PendingActionKind,
    opts: { amountUsd?: number; positionId?: string; source: InputSource },
  ): void {
    this.state.lastInputSource = opts.source
    this.state.lastReceipt = null
    this.refreshDerivedState()

    if (kind === 'transfer_spot_to_margin') {
      const amountUsd = Math.round(opts.amountUsd ?? 500)
      if (amountUsd <= 0) {
        this.addLog('warn', 'Transfer amount must be positive.')
        this.setReceipt(false, 'SAFETY BLOCKED', 'Transfer amount must be positive.', opts.source)
        return
      }
      if (amountUsd > this.state.safety.maxSingleTransferUsd) {
        const msg = `$${amountUsd} exceeds max cap ($${this.state.safety.maxSingleTransferUsd}).`
        this.addLog('alert', `SAFETY BLOCK: ${msg}`)
        this.setReceipt(false, 'SAFETY BLOCKED', msg, opts.source)
        this.maybeSpeak(`Blocked. Transfer exceeds ${this.state.safety.maxSingleTransferUsd} dollar safety limit.`)
        return
      }
      if (amountUsd > this.state.balances.spotUsd) {
        const msg = `Insufficient Spot ($${Math.round(this.state.balances.spotUsd)}) for $${amountUsd}.`
        this.addLog('warn', msg)
        this.setReceipt(false, 'INSUFFICIENT SPOT', msg, opts.source)
        return
      }

      const currentHealth = this.state.balances.marginHealthPct
      const nextHealth = computeProjectedMarginHealthPct(this.state, amountUsd)
      this.state.pendingConfirmation = {
        id: `conf-${this.now()}`,
        kind,
        promptTitle: `Move $${amountUsd} from Spot to Margin?`,
        detailLine: `Spot $${Math.round(this.state.balances.spotUsd)}->$${Math.round(this.state.balances.spotUsd - amountUsd)} | Health ${currentHealth}%->${nextHealth}%`,
        amountUsd,
        source: opts.source,
        createdAt: this.now(),
      }
    } else if (kind === 'transfer_margin_to_spot') {
      const amountUsd = Math.round(opts.amountUsd ?? 500)
      if (amountUsd <= 0 || amountUsd > this.state.safety.maxSingleTransferUsd) {
        const msg = `$${amountUsd} invalid or exceeds $${this.state.safety.maxSingleTransferUsd} cap.`
        this.addLog('alert', `SAFETY BLOCK: ${msg}`)
        this.setReceipt(false, 'SAFETY BLOCKED', msg, opts.source)
        return
      }
      if (amountUsd > this.state.balances.marginUsd) {
        const msg = `Insufficient Margin ($${Math.round(this.state.balances.marginUsd)}) for $${amountUsd}.`
        this.addLog('warn', msg)
        this.setReceipt(false, 'INSUFFICIENT MARGIN', msg, opts.source)
        return
      }

      const currentHealth = this.state.balances.marginHealthPct
      const nextHealth = computeProjectedMarginHealthPct(this.state, -amountUsd)
      this.state.pendingConfirmation = {
        id: `conf-${this.now()}`,
        kind,
        promptTitle: `Move $${amountUsd} from Margin to Spot?`,
        detailLine: `Mgn $${Math.round(this.state.balances.marginUsd)}->$${Math.round(this.state.balances.marginUsd - amountUsd)} | Health ${currentHealth}%->${nextHealth}%`,
        amountUsd,
        source: opts.source,
        createdAt: this.now(),
      }
    } else if (kind === 'close_50') {
      const pos =
        (opts.positionId ? this.state.positions.find(p => p.id === opts.positionId) : undefined) ??
        this.getTargetPosition()
      if (!pos || pos.size <= 0) {
        this.addLog('warn', 'No open position selected to close.')
        this.setReceipt(false, 'NO OPEN POSITION', 'Select an active position first.', opts.source)
        return
      }
      const mark = getEffectivePrice(this.state, pos.symbol)
      const minStep = pos.assetClass === 'STOCK' || pos.symbol === 'SOLUSDT' ? 0.1 : 0.001
      const decimals = pos.assetClass === 'STOCK' || pos.symbol === 'SOLUSDT' ? 1 : 3
      let closeQty = Number((pos.size * 0.5).toFixed(decimals))
      if (closeQty <= 0 || Number((pos.size - closeQty).toFixed(4)) < minStep) {
        closeQty = pos.size
      }
      const dir = pos.side === 'LONG' ? 1 : -1
      const estPnl = (mark - pos.entryPrice) * closeQty * dir
      const pctStr = closeQty >= pos.size ? '100%' : '50%'

      this.state.pendingConfirmation = {
        id: `conf-${this.now()}`,
        kind,
        promptTitle: `Close ${pctStr} ${pos.label} [${pos.venue}]?`,
        detailLine: `Qty ${closeQty} @ $${mark.toFixed(2)} | Est PnL ${fmtUsd(estPnl)}`,
        positionId: pos.id,
        source: opts.source,
        createdAt: this.now(),
      }
    } else if (kind === 'move_stop_entry') {
      const pos =
        (opts.positionId ? this.state.positions.find(p => p.id === opts.positionId) : undefined) ??
        this.getTargetPosition()
      if (!pos || pos.size <= 0) {
        this.addLog('warn', 'No open position selected for stop move.')
        this.setReceipt(false, 'NO OPEN POSITION', 'Select an active position first.', opts.source)
        return
      }

      this.state.pendingConfirmation = {
        id: `conf-${this.now()}`,
        kind,
        promptTitle: `Move ${pos.label} Stop -> Entry?`,
        detailLine: `Stop $${pos.stopPrice.toFixed(2)} -> $${pos.entryPrice.toFixed(2)} (Breakeven)`,
        positionId: pos.id,
        source: opts.source,
        createdAt: this.now(),
      }
    }

    if (!this.state.safety.requireConfirm && this.state.pendingConfirmation) {
      void this.confirmYes(opts.source)
      return
    }

    if (this.state.pendingConfirmation) {
      this.state.status = 'CONFIRM'
      this.addLog('info', `[${opts.source}] Confirm: ${this.state.pendingConfirmation.promptTitle} (Yes / No)`)
      this.maybeSpeak(`${this.state.pendingConfirmation.promptTitle} Say yes or no.`)
    }
    this.refreshDerivedState()
  }

  async confirmYes(source: InputSource): Promise<void> {
    const pending = this.state.pendingConfirmation
    if (!pending) {
      this.addLog('warn', 'No pending action to confirm.')
      return
    }

    this.state.lastInputSource = source
    this.state.pendingConfirmation = null

    if (pending.kind === 'transfer_spot_to_margin') {
      const amt = pending.amountUsd ?? 500
      this.state.balances.spotUsd -= amt
      this.state.balances.marginUsd += amt
      if (this.state.alertPositionId) {
        const alerted = this.state.positions.find(p => p.id === this.state.alertPositionId)
        if (alerted) alerted.snoozedUntil = this.now() + 5 * 60 * 1000
        this.state.alertPositionId = null
      }
      this.state.status = 'EXECUTED'
      this.refreshDerivedState()
      const detail = `Spot $${Math.round(this.state.balances.spotUsd)} | Margin $${Math.round(this.state.balances.marginUsd)} (${this.state.balances.marginHealthPct}%)`
      this.setReceipt(true, `Moved $${amt} Spot -> Margin`, detail, source)
      this.addLog(
        'info',
        `EXECUTED [${source}]: Moved $${amt} Spot -> Margin (Margin $${this.state.balances.marginUsd.toFixed(0)}, Health ${this.state.balances.marginHealthPct}%).`,
      )
      this.maybeSpeak(`Confirmed. Moved ${amt} dollars to margin. Margin health ${this.state.balances.marginHealthPct} percent.`)
    } else if (pending.kind === 'transfer_margin_to_spot') {
      const amt = pending.amountUsd ?? 500
      this.state.balances.marginUsd -= amt
      this.state.balances.spotUsd += amt
      this.state.status = 'EXECUTED'
      this.refreshDerivedState()
      const detail = `Margin $${Math.round(this.state.balances.marginUsd)} | Spot $${Math.round(this.state.balances.spotUsd)}`
      this.setReceipt(true, `Moved $${amt} Margin -> Spot`, detail, source)
      this.addLog(
        'info',
        `EXECUTED [${source}]: Moved $${amt} Margin -> Spot (Spot $${this.state.balances.spotUsd.toFixed(0)}, Health ${this.state.balances.marginHealthPct}%).`,
      )
      this.maybeSpeak(`Confirmed. Moved ${amt} dollars to spot.`)
    } else if (pending.kind === 'close_50') {
      const pos = this.state.positions.find(p => p.id === pending.positionId) ?? this.getTargetPosition()
      if (pos && pos.size > 0) {
        const mark = getEffectivePrice(this.state, pos.symbol)
        const minStep = pos.assetClass === 'STOCK' || pos.symbol === 'SOLUSDT' ? 0.1 : 0.001
        const decimals = pos.assetClass === 'STOCK' || pos.symbol === 'SOLUSDT' ? 1 : 3
        let closeQty = Number((pos.size * 0.5).toFixed(decimals))
        if (closeQty <= 0 || Number((pos.size - closeQty).toFixed(4)) < minStep) {
          closeQty = pos.size
        }
        const dir = pos.side === 'LONG' ? 1 : -1
        const realized = (mark - pos.entryPrice) * closeQty * dir
        pos.size = Number((pos.size - closeQty).toFixed(4))
        if (pos.size < minStep) pos.size = 0
        this.state.realizedPnl += realized
        if (this.state.alertPositionId === pos.id) this.state.alertPositionId = null
        this.state.activePriceAlertId = null
        this.state.status = 'EXECUTED'
        this.refreshDerivedState()

        const pctStr = pos.size === 0 ? '100%' : '50%'
        this.setReceipt(
          true,
          `Closed ${pctStr} ${pos.label}`,
          `Qty ${closeQty} @ $${mark.toFixed(2)} | Real ${fmtUsd(realized)}`,
          source,
        )
        this.maybeSpeak(
          `Closed ${pos.size === 0 ? 'full' : 'half'} ${pos.label}. Realized ${realized >= 0 ? 'profit' : 'loss'} ${Math.abs(realized).toFixed(0)} dollars.`,
        )

        if (
          pos.venue === 'BINANCE' &&
          this.state.testnet.enabled &&
          this.state.testnet.apiKey &&
          this.state.testnet.apiSecret
        ) {
          const orderSide = pos.side === 'LONG' ? 'SELL' : 'BUY'
          const res = await this.sendTestnetOrder(
            this.state.testnet.apiKey,
            this.state.testnet.apiSecret,
            pos.symbol,
            orderSide,
            closeQty,
          )
          this.addLog(
            res.ok ? 'info' : 'warn',
            `EXECUTED [${source}]: Closed ${pctStr} ${pos.label} (${closeQty}) @ $${mark.toFixed(2)} | Realized ${fmtUsd(realized)} [${res.detail}]`,
          )
        } else {
          this.addLog(
            'info',
            `EXECUTED [${source}]: Closed ${pctStr} ${pos.label} [${pos.venue}] (${closeQty}) @ $${mark.toFixed(2)} | Realized ${fmtUsd(realized)}`,
          )
        }
      }
    } else if (pending.kind === 'move_stop_entry') {
      const pos = this.state.positions.find(p => p.id === pending.positionId) ?? this.getTargetPosition()
      if (pos && pos.size > 0) {
        pos.stopPrice = pos.entryPrice
        pos.snoozedUntil = this.now() + 5 * 60 * 1000
        if (this.state.alertPositionId === pos.id) this.state.alertPositionId = null
        this.state.activePriceAlertId = null
        this.state.status = 'EXECUTED'
        this.refreshDerivedState()
        this.setReceipt(
          true,
          `${pos.label} Stop -> Entry`,
          `Stop moved to $${pos.entryPrice.toFixed(2)} (Breakeven)`,
          source,
        )
        this.addLog(
          'info',
          `EXECUTED [${source}]: Moved ${pos.label} [${pos.venue}] stop-loss to breakeven ($${pos.entryPrice.toFixed(2)}).`,
        )
        this.maybeSpeak(`Moved ${pos.label} stop loss to entry.`)
      }
    }

    this.refreshDerivedState()
  }

  confirmNo(source: InputSource): void {
    this.state.lastInputSource = source
    if (!this.state.pendingConfirmation) {
      this.addLog('info', 'No pending confirmation to cancel.')
      return
    }
    const title = this.state.pendingConfirmation.promptTitle
    this.state.pendingConfirmation = null
    this.state.status = this.state.alertPositionId || this.state.activePriceAlertId ? 'ALERT' : 'ARMED'
    this.setReceipt(false, 'ACTION CANCELLED', title, source, 3000)
    this.addLog('warn', `CANCELLED [${source}]: "${title}" rejected by user.`)
    this.maybeSpeak('Cancelled.')
    this.refreshDerivedState()
  }

  async handleAction(action: HudAction, source: InputSource = 'UI'): Promise<void> {
    this.state.lastInputSource = source

    switch (action) {
      case 'confirm_yes':
        await this.confirmYes(source)
        return
      case 'confirm_no':
        this.confirmNo(source)
        return
      case 'dismiss_receipt':
        this.state.lastReceipt = null
        this.refreshDerivedState()
        return
      case 'prompt_move_500_margin':
        this.requestConfirmation('transfer_spot_to_margin', { amountUsd: 500, source })
        return
      case 'prompt_move_500_spot':
        this.requestConfirmation('transfer_margin_to_spot', { amountUsd: 500, source })
        return
      case 'close_50': {
        const target = this.getTargetPosition()
        this.requestConfirmation('close_50', { positionId: target?.id, source })
        return
      }
      case 'move_stop_entry': {
        const target = this.getTargetPosition()
        this.requestConfirmation('move_stop_entry', { positionId: target?.id, source })
        return
      }
      case 'snooze_alert': {
        const now = this.now()
        if (this.state.alertPositionId) {
          const pos = this.state.positions.find(p => p.id === this.state.alertPositionId)
          if (pos) pos.snoozedUntil = now + 5 * 60 * 1000
          this.state.alertPositionId = null
        }
        if (this.state.activePriceAlertId) {
          const alert = this.state.priceAlerts.find(a => a.id === this.state.activePriceAlertId)
          if (alert) alert.snoozedUntil = now + 5 * 60 * 1000
          this.state.activePriceAlertId = null
        }
        this.state.lastReceipt = null
        this.state.status = 'ARMED'
        this.addLog('warn', `[${source}] Snoozed active alerts for 5 minutes.`)
        this.refreshDerivedState()
        return
      }
      case 'quick_btc_alert':
        this.quickAddBtcAlert(source)
        return
      case 'go_portfolio':
        this.setScreen('PORTFOLIO', source)
        return
      case 'go_positions':
        this.setScreen('POSITIONS', source)
        return
      case 'go_wallet':
        this.setScreen('WALLET', source)
        return
      case 'go_alerts':
        this.setScreen('ALERTS', source)
        return
      case 'next_position':
        this.state.activeIndex = (this.state.activeIndex + 1) % this.state.positions.length
        this.state.activeScreen = 'POSITIONS'
        this.state.lastReceipt = null
        this.refreshDerivedState()
        return
      case 'prev_position':
        this.state.activeIndex =
          (this.state.activeIndex - 1 + this.state.positions.length) % this.state.positions.length
        this.state.activeScreen = 'POSITIONS'
        this.state.lastReceipt = null
        this.refreshDerivedState()
    }
  }

  addPriceAlert(symbol: SymbolCode, direction: 'ABOVE' | 'BELOW', targetPrice: number): void {
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      this.addLog('warn', 'Enter a valid positive target price for the price alert.')
      return
    }
    const shortSym = symbol.replace('USDT', '')
    const arrow = direction === 'ABOVE' ? '>' : '<'
    const priceLabel = targetPrice >= 1000 ? targetPrice.toLocaleString('en-US') : targetPrice.toFixed(2)
    this.state.priceAlerts.unshift({
      id: `pa-${this.now()}-${Math.random().toString(36).slice(2, 5)}`,
      symbol,
      label: `${shortSym} ${arrow} $${priceLabel}`,
      direction,
      targetPrice,
      triggered: false,
      snoozedUntil: 0,
    })
    this.addLog('info', `Added Price Alert: ${shortSym} ${arrow} $${priceLabel}.`)
    this.evaluatePriceAlerts()
    this.refreshDerivedState()
  }

  quickAddBtcAlert(source: InputSource = 'GLASSES'): void {
    const btcMark = getEffectivePrice(this.state, 'BTCUSDT')
    const target = Math.round(btcMark * 1.01)
    this.addPriceAlert('BTCUSDT', 'ABOVE', target)
    this.setReceipt(true, `Added BTC > $${target.toLocaleString('en-US')}`, 'Armed +1% breakout alert', source, 3000)
  }

  handleVoicePhrase(phrase: string, source: InputSource = 'VOICE'): void {
    const activePos = this.getTargetPosition() ?? this.state.positions[0]
    const intent = parseVoiceCommand(phrase, this.state.prices, activePos.symbol)
    this.state.lastInputSource = source
    this.state.voice.lastTranscript = phrase
    this.state.voice.lastParsedSummary = formatIntentSummary(intent)

    switch (intent.kind) {
      case 'confirm_yes':
        void this.confirmYes(source)
        return
      case 'confirm_no':
        this.confirmNo(source)
        return
      case 'transfer_spot_to_margin':
        this.requestConfirmation('transfer_spot_to_margin', { amountUsd: intent.amountUsd, source })
        return
      case 'transfer_margin_to_spot':
        this.requestConfirmation('transfer_margin_to_spot', { amountUsd: intent.amountUsd, source })
        return
      case 'close_50': {
        const target = this.getTargetPosition(intent.symbol)
        this.requestConfirmation('close_50', { positionId: target?.id, source })
        return
      }
      case 'move_stop_entry': {
        const target = this.getTargetPosition(intent.symbol)
        this.requestConfirmation('move_stop_entry', { positionId: target?.id, source })
        return
      }
      case 'set_price_alert':
        this.addPriceAlert(intent.symbol, intent.direction, intent.targetPrice)
        this.setReceipt(
          true,
          `Alert: ${intent.symbol} ${intent.direction} $${intent.targetPrice}`,
          'Price alert armed on HUD',
          source,
          3000,
        )
        this.maybeSpeak(`Alert set for ${intent.symbol} ${intent.direction.toLowerCase()} ${intent.targetPrice}.`)
        return
      case 'switch_screen':
        this.setScreen(intent.screen, source)
        this.addLog('info', `[${source}] Switched HUD to ${intent.screen} screen.`)
        return
      case 'next_position':
        void this.handleAction('next_position', source)
        return
      case 'prev_position':
        void this.handleAction('prev_position', source)
        return
      case 'snooze_alert':
        void this.handleAction('snooze_alert', source)
        return
      case 'status_readout': {
        const totalPnl = computeTotalUnrealizedPnl(this.state) + this.state.realizedPnl
        const readout = `Session PnL ${fmtUsd(totalPnl)}, Margin Health ${this.state.balances.marginHealthPct}%, Spot $${Math.round(this.state.balances.spotUsd)}.`
        this.addLog('info', `STATUS READOUT: ${readout}`)
        this.onSpeak?.(readout)
        return
      }
      case 'unknown':
        this.addLog(
          'warn',
          `Voice phrase not matched: "${intent.raw}". Try "Move 500 to margin", "Close half", or "Alert BTC at 96k".`,
        )
    }
  }

  simulateDip(): void {
    const pos = this.state.positions[this.state.activeIndex] ?? this.state.positions.find(p => p.size > 0)
    if (!pos || pos.size <= 0) return
    pos.snoozedUntil = 0
    this.state.pendingConfirmation = null
    this.state.lastReceipt = null
    this.state.priceOffsets[pos.symbol] = pos.side === 'LONG' ? -0.025 : 0.025
    this.evaluateRiskAlerts()
    this.refreshDerivedState()
  }

  simulatePriceAlert(): void {
    const alert = this.state.priceAlerts.find(a => !a.triggered) ?? this.state.priceAlerts[0]
    if (!alert) return
    alert.triggered = false
    alert.snoozedUntil = 0
    this.state.pendingConfirmation = null
    this.state.lastReceipt = null
    const basePrice = this.state.prices[alert.symbol].price
    const targetWithMargin =
      alert.direction === 'ABOVE' ? alert.targetPrice * 1.004 : alert.targetPrice * 0.996
    this.state.priceOffsets[alert.symbol] = (targetWithMargin - basePrice) / basePrice
    this.evaluatePriceAlerts()
    this.refreshDerivedState()
  }

  resetSession(): void {
    const savedTestnet = this.state.testnet
    const savedPrices = this.state.prices
    const savedConnected = this.state.connected
    const savedGlasses = this.state.glassesConnected
    const savedTts = this.state.voice.ttsEnabled

    this.state = createInitialState()
    this.anchoredSymbols.clear()
    this.dailyLossWarned = false
    this.state.testnet = savedTestnet
    this.state.prices = savedPrices
    this.state.connected = savedConnected
    this.state.glassesConnected = savedGlasses
    this.state.voice.ttsEnabled = savedTts
    this.state.positions = createDefaultPositions(this.state.prices)
    this.state.priceAlerts = createDefaultPriceAlerts(this.state.prices)
    this.state.balances.marginHealthPct = computeMarginHealthPct(this.state)
    this.addLog('info', 'Session reset across all 5 venues anchored to live market prices.')
  }
}
