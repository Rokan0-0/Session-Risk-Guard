import {
  computePositionMetrics,
  computeTotalUnrealizedPnl,
  getEffectivePrice,
} from './exchange'
import { formatHudModel, resolveHudListAction, type HudAction } from './glasses'
import type { HudScreen, InputSource, SessionState, SymbolCode, VenueId } from './types'

export interface UiHandlers {
  onAction: (action: HudAction, source: InputSource) => void
  onPromptSpotToMargin: (amountUsd: number) => void
  onPromptMarginToSpot: (amountUsd: number) => void
  onSetTransferAmount: (amountUsd: number) => void
  onSelectScreen: (screen: HudScreen) => void
  onSimulateDip: () => void
  onSimulatePriceAlert: () => void
  onResetSession: () => void
  onSelectPosition: (index: number) => void
  onSelectVenueFilter: (venue: VenueId | 'ALL') => void
  onRunVoicePhrase: (phrase: string) => void
  onToggleMic: () => void
  onToggleTts: (enabled: boolean) => void
  onToggleRequireConfirm: (required: boolean) => void
  onAddPriceAlert: (symbol: SymbolCode, direction: 'ABOVE' | 'BELOW', targetPrice: number) => void
  onSaveTestnet: (enabled: boolean, apiKey: string, apiSecret: string) => void
}

function fmtUsd(val: number): string {
  const sign = val >= 0 ? '+' : '-'
  return `${sign}$${Math.abs(val).toFixed(2)}`
}

function fmtPrice(val: number): string {
  return val >= 1000
    ? val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : val.toFixed(2)
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const VENUES: Array<VenueId | 'ALL'> = ['ALL', 'BINANCE', 'OKX', 'BYBIT', 'COINBASE', 'IBKR']

const HUD_SCREENS: Array<{ id: HudScreen; label: string }> = [
  { id: 'PORTFOLIO', label: 'Overview' },
  { id: 'POSITIONS', label: 'Positions' },
  { id: 'WALLET', label: 'Wallet' },
  { id: 'ALERTS', label: 'Alerts' },
]

const QUICK_PHRASES = [
  'Move $500 to margin',
  'Move $500 to spot',
  'Close half',
  'Alert BTC at 96k',
  'Wallet',
  'Yes',
  'No',
]

export class CompanionUi {
  private root: HTMLElement
  private handlers: UiHandlers
  private wired = false
  private lastState: SessionState | null = null
  private lastHudHeader = ''
  private lastHudBody = ''
  private lastHudActionsHtml = ''
  private lastTickersHtml = ''
  private lastPriceAlertsHtml = ''
  private lastLogsHtml = ''
  private lastPositionsKey = ''
  private lastTransferAmt = 500

  constructor(root: HTMLElement, handlers: UiHandlers) {
    this.root = root
    this.handlers = handlers
  }

  render(state: SessionState): void {
    this.lastState = state

    const unrealized = computeTotalUnrealizedPnl(state)
    const totalPnl = unrealized + state.realizedPnl
    const totalClass = totalPnl >= 0 ? 'pnl-pos' : 'pnl-neg'
    const badgeClass =
      state.status === 'ALERT'
        ? 'badge alert'
        : state.status === 'CONFIRM'
          ? 'badge confirm'
          : 'badge'

    const hudModel = formatHudModel(state)

    const symbols: SymbolCode[] = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'NVDA', 'SPY']
    const tickersHtml = symbols
      .map(sym => {
        const t = state.prices[sym]
        const eff = getEffectivePrice(state, sym)
        const chgClass = t.change24hPct >= 0 ? 'pnl-pos' : 'pnl-neg'
        const chgSign = t.change24hPct >= 0 ? '+' : ''
        const label = sym.endsWith('USDT') ? sym.replace('USDT', '/USDT') : `${sym} (Stock)`
        return `
          <div class="ticker-row">
            <strong>${label}</strong>
            <span>$${fmtPrice(eff)}</span>
            <span class="${chgClass}">${chgSign}${t.change24hPct.toFixed(2)}%</span>
          </div>`
      })
      .join('')

    const filteredPositions = state.positions
      .map((pos, idx) => ({ pos, idx }))
      .filter(({ pos }) => state.activeVenueFilter === 'ALL' || pos.venue === state.activeVenueFilter)

    const positionsKey = `${state.activeVenueFilter}:${filteredPositions.map(p => `${p.idx}:${p.pos.id}`).join(',')}`

    const buildPositionsHtml = () =>
      filteredPositions
        .map(({ pos, idx }) => {
          const mark = getEffectivePrice(state, pos.symbol)
          const { pnlUsd, pnlPct } = computePositionMetrics(pos, mark)
          const isActive = idx === state.activeIndex
          const isAlerted = state.alertPositionId === pos.id
          const cardCls = `pos-card ${isActive ? 'active' : ''} ${isAlerted ? 'alerted' : ''}`
          const pnlCls = pnlUsd >= 0 ? 'pnl-pos' : 'pnl-neg'
          return `
            <div class="${cardCls}" data-pos-idx="${idx}">
              <div class="pos-top">
                <span data-pos-title><span class="venue-tag">${pos.venue}</span>${pos.label} · ${pos.side} ${pos.size > 0 ? pos.size : 'CLOSED'}</span>
                <span data-pos-pnl class="${pnlCls}">${pos.size > 0 ? `${fmtUsd(pnlUsd)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)` : 'FLAT'}</span>
              </div>
              <div class="pos-meta">
                <span data-pos-meta-left>Entry: $${fmtPrice(pos.entryPrice)} · Mark: $${fmtPrice(mark)}</span>
                <span data-pos-meta-right>Stop: $${fmtPrice(pos.stopPrice)} · Guard: ${pos.alertDrawdownPct}%</span>
              </div>
            </div>`
        })
        .join('')

    const hudActionsHtml = hudModel.actionItems
      .map((item, idx) => {
        const cls = idx === 0 ? 'g2-action-btn primary-opt' : 'g2-action-btn'
        return `<button type="button" class="${cls}" data-hud-idx="${idx}">${idx + 1}. ${escapeHtml(item)}</button>`
      })
      .join('')

    const now = Date.now()
    const priceAlertsHtml = state.priceAlerts
      .map(a => {
        const statusText = a.triggered
          ? 'TRIGGERED'
          : a.snoozedUntil > now
            ? 'SNOOZED'
            : 'ARMED'
        const cls = a.triggered ? 'alert-row hit' : 'alert-row'
        return `
          <div class="${cls}">
            <strong>${escapeHtml(a.label)}</strong>
            <span>${statusText}</span>
          </div>`
      })
      .join('')

    const logsHtml = state.logs
      .slice(0, 24)
      .map(l => `<div class="log-item ${l.level}">[${l.timestamp}] ${escapeHtml(l.message)}</div>`)
      .join('')

    if (!this.wired) {
      const screenTabsHtml = HUD_SCREENS.map(s => {
        const cls = s.id === state.activeScreen ? 'chip active-tab' : 'chip'
        return `<button type="button" class="${cls}" data-screen="${s.id}">${s.label}</button>`
      }).join('')

      const venueTabsHtml = VENUES.map(v => {
        const cls = v === state.activeVenueFilter ? 'chip active-tab' : 'chip'
        return `<button type="button" class="${cls}" data-venue="${v}">${v}</button>`
      }).join('')

      const quickChipsHtml = QUICK_PHRASES.map(
        p => `<button type="button" class="chip" data-phrase="${escapeHtml(p)}">"${escapeHtml(p)}"</button>`,
      ).join('')

      const initialPositionsHtml = buildPositionsHtml()

      this.root.innerHTML = `
        <div class="header">
          <div class="title-wrap">
            <h1>
              Session Risk Guard
              <span id="ui-status-badge" class="${badgeClass}">${state.status}</span>
            </h1>
            <div id="ui-conn-sub" class="sub"></div>
          </div>
          <div style="text-align:right">
            <div style="font-size:11px;color:var(--muted)">SESSION PNL</div>
            <div id="ui-total-pnl" class="${totalClass}" style="font-size:20px;font-weight:700;font-variant-numeric:tabular-nums"></div>
          </div>
        </div>

        <div class="grid">
          <div class="card">
            <h2>
              <span>Even G2 576×288 Monochrome HUD</span>
              <span id="ui-last-source" class="sub">Input: ${state.lastInputSource}</span>
            </h2>
            <div id="ui-screen-tabs" class="controls" style="margin-bottom:8px">${screenTabsHtml}</div>
            <div class="g2-shell">
              <div class="g2-screen">
                <div id="ui-hud-header" class="g2-box g2-header"></div>
                <div id="ui-hud-body" class="g2-box g2-body"></div>
                <div id="ui-hud-actions" class="g2-box g2-actions"></div>
              </div>
            </div>
            <div class="sub" style="margin-top:8px">
              4 screens (Overview, Positions, Wallet, Alerts) + priority overlays (Confirm, Receipt, Alert).
            </div>
          </div>

          <div class="card">
            <h2>
              <span>Short-Phrase Voice &amp; Quick Commands</span>
              <label class="inline-check" style="text-transform:none;letter-spacing:0;font-weight:500">
                <input id="chk-tts" type="checkbox" />
                Voice Readout (TTS)
              </label>
            </h2>
            <div class="voice-row">
              <button id="btn-mic" type="button" class="primary">Mic Command</button>
              <input id="inp-voice" type="text" placeholder='Say or type: "Move 500 to margin", "Close half", "Yes"' />
              <button id="btn-voice-run" type="button">Run</button>
            </div>
            <div id="ui-quick-chips" class="controls" style="margin-bottom:8px">${quickChipsHtml}</div>
            <div id="ui-voice-summary" class="sub"></div>
          </div>
        </div>

        <div class="grid">
          <div class="card">
            <h2>Wallet Balances &amp; Safety Guardrails</h2>
            <div class="stat-grid">
              <div class="stat-pill">
                <div class="stat-label">Spot Balance</div>
                <div id="ui-spot-usd" class="stat-val">$4,250</div>
              </div>
              <div class="stat-pill">
                <div class="stat-label">Margin Collateral</div>
                <div id="ui-margin-usd" class="stat-val">$1,800</div>
              </div>
              <div class="stat-pill">
                <div class="stat-label">Margin Health</div>
                <div id="ui-margin-health" class="stat-val pnl-pos">165%</div>
              </div>
            </div>
            <div class="transfer-bar">
              <div id="ui-amt-presets" class="controls">
                <button type="button" class="chip" data-amt="250">$250</button>
                <button type="button" class="chip active-tab" data-amt="500">$500</button>
                <button type="button" class="chip" data-amt="750">$750</button>
                <button type="button" class="chip" data-amt="1000">$1,000</button>
              </div>
              <div class="transfer-custom">
                <input id="inp-transfer-amt" type="number" min="1" step="50" value="${state.transferAmountUsd}" placeholder="Custom $" />
                <button id="btn-amt-to-margin" type="button" class="primary">Spot → Margin</button>
                <button id="btn-amt-to-spot" type="button">Margin → Spot</button>
              </div>
            </div>
            <div class="safety-bar">
              <span>Max Transfer Cap: <strong>$${state.safety.maxSingleTransferUsd}</strong> · Daily Loss Limit: <strong>-$${state.safety.dailyLossLimitUsd}</strong></span>
              <label class="inline-check">
                <input id="chk-require-confirm" type="checkbox" checked />
                Require Yes/No Confirm
              </label>
            </div>
          </div>

          <div class="card">
            <h2>Demo &amp; Quick Controls</h2>
            <div class="controls">
              <button id="btn-prompt-500" type="button" class="primary">Move $500 Spot→Margin? (Yes/No)</button>
              <button id="btn-prompt-spot" type="button">Move $500 Margin→Spot? (Yes/No)</button>
              <button id="btn-dip" type="button" class="danger">Trigger -2.5% Flash Dip</button>
              <button id="btn-sim-alert" type="button" class="amber">Trigger Price Alert</button>
              <button id="btn-close50" type="button">Close 50% (Active)</button>
              <button id="btn-stop" type="button">Move Stop → Entry</button>
              <button id="btn-reset" type="button">Reset Session</button>
            </div>
            <div class="sub" style="margin-top:8px">
              Demo flow: Tap <strong>Trigger -2.5% Flash Dip</strong> or <strong>Move $500 Spot→Margin?</strong>, then confirm <strong>YES</strong> on the G2 HUD or say <em>"Yes"</em>.
            </div>
          </div>
        </div>

        <div class="grid">
          <div class="card">
            <h2>Live Market Feed (Binance WS + Stocks)</h2>
            <div id="ui-tickers">${tickersHtml}</div>
          </div>

          <div class="card">
            <h2>Price Alerts</h2>
            <div id="ui-price-alerts">${priceAlertsHtml}</div>
            <div class="alert-form">
              <select id="sel-alert-sym">
                <option value="BTCUSDT">BTCUSDT</option>
                <option value="ETHUSDT">ETHUSDT</option>
                <option value="SOLUSDT">SOLUSDT</option>
                <option value="NVDA">NVDA</option>
                <option value="SPY">SPY</option>
              </select>
              <select id="sel-alert-dir">
                <option value="ABOVE">Above</option>
                <option value="BELOW">Below</option>
              </select>
              <input id="inp-alert-price" type="number" step="0.01" placeholder="Target $" />
              <button id="btn-add-alert" type="button" class="primary">Add</button>
            </div>
          </div>
        </div>

        <div class="card">
          <h2>
            <span>Multi-Venue Open Positions (Realized: <span id="ui-realized"></span>)</span>
            <span id="ui-venue-tabs" class="controls">${venueTabsHtml}</span>
          </h2>
          <div id="ui-positions">${initialPositionsHtml}</div>
        </div>

        <div class="card">
          <h2>Binance Futures Testnet (Optional · Ephemeral RAM Keys Only)</h2>
          <div class="sub">Keys are never written to localStorage. Leave blank to run Paper Exchange across all 5 venues.</div>
          <div class="testnet-row">
            <input id="inp-key" type="text" placeholder="Testnet API Key" value="${escapeHtml(state.testnet.apiKey)}" />
            <input id="inp-secret" type="password" placeholder="Testnet API Secret" value="${escapeHtml(state.testnet.apiSecret)}" />
            <button id="btn-testnet" type="button">Enable Testnet</button>
            <button id="btn-testnet-clear" type="button">Clear Keys</button>
          </div>
        </div>

        <div class="card">
          <h2>Execution, Confirmation &amp; Risk Log</h2>
          <div id="ui-logs" class="log-list">${logsHtml}</div>
        </div>
      `

      this.lastTickersHtml = tickersHtml
      this.lastPriceAlertsHtml = priceAlertsHtml
      this.lastLogsHtml = logsHtml
      this.lastPositionsKey = positionsKey
      this.wireStaticEvents()
      this.wired = true
    }

    const badgeEl = this.root.querySelector('#ui-status-badge')
    if (badgeEl) {
      badgeEl.className = badgeClass
      badgeEl.textContent = state.status
    }

    const subEl = this.root.querySelector('#ui-conn-sub')
    if (subEl) {
      const feedStr = state.connected ? 'Binance WS: LIVE' : 'Binance WS: Reconnecting...'
      const g2Str = state.glassesConnected ? 'Even G2 HUD: CONNECTED' : 'Even G2 HUD: Browser Mirror'
      const modeStr = state.testnet.enabled ? 'Binance Testnet' : 'Paper + Live Prices'
      subEl.textContent = `${feedStr} · ${g2Str} · ${modeStr}`
    }

    const srcEl = this.root.querySelector('#ui-last-source')
    if (srcEl) {
      srcEl.textContent = `Last Input: ${state.lastInputSource}`
    }

    const pnlEl = this.root.querySelector('#ui-total-pnl')
    if (pnlEl) {
      pnlEl.className = totalClass
      pnlEl.textContent = fmtUsd(totalPnl)
    }

    // Update HUD screen tabs class without replacing DOM nodes
    const screenButtons = this.root.querySelectorAll('#ui-screen-tabs button[data-screen]')
    for (const btn of screenButtons) {
      const screen = (btn as HTMLElement).dataset.screen
      btn.classList.toggle('active-tab', screen === state.activeScreen)
    }

    if (hudModel.headerText !== this.lastHudHeader) {
      this.lastHudHeader = hudModel.headerText
      const hudHeaderEl = this.root.querySelector('#ui-hud-header')
      if (hudHeaderEl) hudHeaderEl.textContent = hudModel.headerText
    }

    if (hudModel.bodyText !== this.lastHudBody) {
      this.lastHudBody = hudModel.bodyText
      const hudBodyEl = this.root.querySelector('#ui-hud-body')
      if (hudBodyEl) hudBodyEl.textContent = hudModel.bodyText
    }

    if (hudActionsHtml !== this.lastHudActionsHtml) {
      this.lastHudActionsHtml = hudActionsHtml
      const hudActionsEl = this.root.querySelector('#ui-hud-actions')
      if (hudActionsEl) hudActionsEl.innerHTML = hudActionsHtml
    }

    const micBtn = this.root.querySelector('#btn-mic')
    if (micBtn) {
      micBtn.textContent = state.voice.listening ? 'Listening... (Stop)' : 'Mic Command'
      micBtn.className = state.voice.listening ? 'danger' : 'primary'
    }

    const ttsCheck = this.root.querySelector('#chk-tts') as HTMLInputElement | null
    if (ttsCheck) ttsCheck.checked = state.voice.ttsEnabled

    const confirmCheck = this.root.querySelector('#chk-require-confirm') as HTMLInputElement | null
    if (confirmCheck) confirmCheck.checked = state.safety.requireConfirm

    const voiceSummaryEl = this.root.querySelector('#ui-voice-summary')
    if (voiceSummaryEl) {
      const transcriptPart = state.voice.lastTranscript ? `Heard: "${state.voice.lastTranscript}" → ` : ''
      voiceSummaryEl.textContent = `${transcriptPart}${state.voice.lastParsedSummary}`
    }

    const spotEl = this.root.querySelector('#ui-spot-usd')
    if (spotEl) spotEl.textContent = `$${state.balances.spotUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

    const marginEl = this.root.querySelector('#ui-margin-usd')
    if (marginEl) marginEl.textContent = `$${state.balances.marginUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

    const healthEl = this.root.querySelector('#ui-margin-health')
    if (healthEl) {
      healthEl.textContent = `${state.balances.marginHealthPct}%`
      healthEl.className =
        state.balances.marginHealthPct < 120
          ? 'stat-val pnl-neg'
          : state.balances.marginHealthPct < 150
            ? 'stat-val pnl-warn'
            : 'stat-val pnl-pos'
    }

    const amtButtons = this.root.querySelectorAll('#ui-amt-presets button[data-amt]')
    for (const btn of amtButtons) {
      const val = Number((btn as HTMLElement).dataset.amt)
      btn.classList.toggle('active-tab', val === state.transferAmountUsd)
    }

    const transferInp = this.root.querySelector('#inp-transfer-amt') as HTMLInputElement | null
    if (transferInp && state.transferAmountUsd !== this.lastTransferAmt) {
      this.lastTransferAmt = state.transferAmountUsd
      if (document.activeElement !== transferInp) {
        transferInp.value = String(state.transferAmountUsd)
      }
    }

    const promptMarginBtn = this.root.querySelector('#btn-prompt-500')
    if (promptMarginBtn) {
      promptMarginBtn.textContent = `Move $${Math.round(state.transferAmountUsd)} Spot→Margin? (Yes/No)`
    }
    const promptSpotBtn = this.root.querySelector('#btn-prompt-spot')
    if (promptSpotBtn) {
      promptSpotBtn.textContent = `Move $${Math.round(state.transferAmountUsd)} Margin→Spot? (Yes/No)`
    }

    const realEl = this.root.querySelector('#ui-realized')
    if (realEl) realEl.textContent = fmtUsd(state.realizedPnl)

    if (tickersHtml !== this.lastTickersHtml) {
      this.lastTickersHtml = tickersHtml
      const tickersEl = this.root.querySelector('#ui-tickers')
      if (tickersEl) tickersEl.innerHTML = tickersHtml
    }

    if (priceAlertsHtml !== this.lastPriceAlertsHtml) {
      this.lastPriceAlertsHtml = priceAlertsHtml
      const alertsEl = this.root.querySelector('#ui-price-alerts')
      if (alertsEl) alertsEl.innerHTML = priceAlertsHtml
    }

    // Update venue tabs class without replacing DOM nodes
    const venueButtons = this.root.querySelectorAll('#ui-venue-tabs button[data-venue]')
    for (const btn of venueButtons) {
      const venue = (btn as HTMLElement).dataset.venue
      btn.classList.toggle('active-tab', venue === state.activeVenueFilter)
    }

    // Update position cards in place unless filter/list structure changed
    const posEl = this.root.querySelector('#ui-positions')
    if (posEl) {
      if (positionsKey !== this.lastPositionsKey) {
        this.lastPositionsKey = positionsKey
        posEl.innerHTML = buildPositionsHtml()
      } else {
        for (const { pos, idx } of filteredPositions) {
          const card = posEl.querySelector(`.pos-card[data-pos-idx="${idx}"]`)
          if (!card) continue
          const mark = getEffectivePrice(state, pos.symbol)
          const { pnlUsd, pnlPct } = computePositionMetrics(pos, mark)
          const isActive = idx === state.activeIndex
          const isAlerted = state.alertPositionId === pos.id
          card.className = `pos-card ${isActive ? 'active' : ''} ${isAlerted ? 'alerted' : ''}`

          const titleEl = card.querySelector('[data-pos-title]')
          if (titleEl) {
            titleEl.innerHTML = `<span class="venue-tag">${pos.venue}</span>${pos.label} · ${pos.side} ${pos.size > 0 ? pos.size : 'CLOSED'}`
          }

          const pnlSpan = card.querySelector('[data-pos-pnl]')
          if (pnlSpan) {
            pnlSpan.className = pnlUsd >= 0 ? 'pnl-pos' : 'pnl-neg'
            pnlSpan.textContent =
              pos.size > 0
                ? `${fmtUsd(pnlUsd)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`
                : 'FLAT'
          }

          const metaLeft = card.querySelector('[data-pos-meta-left]')
          if (metaLeft) {
            metaLeft.textContent = `Entry: $${fmtPrice(pos.entryPrice)} · Mark: $${fmtPrice(mark)}`
          }

          const metaRight = card.querySelector('[data-pos-meta-right]')
          if (metaRight) {
            metaRight.textContent = `Stop: $${fmtPrice(pos.stopPrice)} · Guard: ${pos.alertDrawdownPct}%`
          }
        }
      }
    }

    if (logsHtml !== this.lastLogsHtml) {
      this.lastLogsHtml = logsHtml
      const logsEl = this.root.querySelector('#ui-logs')
      if (logsEl) logsEl.innerHTML = logsHtml
    }
  }

  private wireStaticEvents(): void {
    this.root.querySelector('#btn-prompt-500')?.addEventListener('click', () => {
      this.handlers.onPromptSpotToMargin(this.lastState?.transferAmountUsd ?? 500)
    })
    this.root.querySelector('#btn-prompt-spot')?.addEventListener('click', () => {
      this.handlers.onPromptMarginToSpot(this.lastState?.transferAmountUsd ?? 500)
    })
    const transferInp = this.root.querySelector('#inp-transfer-amt') as HTMLInputElement | null
    this.root.querySelector('#ui-amt-presets')?.addEventListener('click', evt => {
      const btn = (evt.target as HTMLElement).closest('button[data-amt]') as HTMLButtonElement | null
      const amt = Number(btn?.dataset.amt)
      if (Number.isFinite(amt) && amt > 0) {
        if (transferInp) transferInp.value = String(amt)
        this.handlers.onSetTransferAmount(amt)
      }
    })
    this.root.querySelector('#btn-amt-to-margin')?.addEventListener('click', () => {
      const amt = Number(transferInp?.value ?? 500)
      this.handlers.onPromptSpotToMargin(amt)
    })
    this.root.querySelector('#btn-amt-to-spot')?.addEventListener('click', () => {
      const amt = Number(transferInp?.value ?? 500)
      this.handlers.onPromptMarginToSpot(amt)
    })
    this.root.querySelector('#ui-screen-tabs')?.addEventListener('click', evt => {
      const btn = (evt.target as HTMLElement).closest('button[data-screen]') as HTMLButtonElement | null
      const screen = btn?.dataset.screen as HudScreen | undefined
      if (screen) this.handlers.onSelectScreen(screen)
    })
    this.root.querySelector('#btn-dip')?.addEventListener('click', () => this.handlers.onSimulateDip())
    this.root.querySelector('#btn-sim-alert')?.addEventListener('click', () => this.handlers.onSimulatePriceAlert())
    this.root.querySelector('#btn-close50')?.addEventListener('click', () => this.handlers.onAction('close_50', 'UI'))
    this.root.querySelector('#btn-stop')?.addEventListener('click', () => this.handlers.onAction('move_stop_entry', 'UI'))
    this.root.querySelector('#btn-reset')?.addEventListener('click', () => this.handlers.onResetSession())

    this.root.querySelector('#btn-mic')?.addEventListener('click', () => this.handlers.onToggleMic())

    const voiceInput = this.root.querySelector('#inp-voice') as HTMLInputElement | null
    const runVoice = () => {
      const phrase = voiceInput?.value.trim() ?? ''
      if (!phrase) return
      this.handlers.onRunVoicePhrase(phrase)
      if (voiceInput) voiceInput.value = ''
    }
    this.root.querySelector('#btn-voice-run')?.addEventListener('click', runVoice)
    voiceInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') runVoice()
    })

    this.root.querySelector('#ui-quick-chips')?.addEventListener('click', evt => {
      const btn = (evt.target as HTMLElement).closest('button[data-phrase]') as HTMLButtonElement | null
      const phrase = btn?.dataset.phrase
      if (phrase) this.handlers.onRunVoicePhrase(phrase)
    })

    this.root.querySelector('#chk-tts')?.addEventListener('change', evt => {
      this.handlers.onToggleTts((evt.target as HTMLInputElement).checked)
    })

    this.root.querySelector('#chk-require-confirm')?.addEventListener('change', evt => {
      this.handlers.onToggleRequireConfirm((evt.target as HTMLInputElement).checked)
    })

    this.root.querySelector('#btn-add-alert')?.addEventListener('click', () => {
      const sym = (this.root.querySelector('#sel-alert-sym') as HTMLSelectElement).value as SymbolCode
      const dir = (this.root.querySelector('#sel-alert-dir') as HTMLSelectElement).value as 'ABOVE' | 'BELOW'
      const priceVal = Number((this.root.querySelector('#inp-alert-price') as HTMLInputElement).value)
      this.handlers.onAddPriceAlert(sym, dir, priceVal)
    })

    this.root.querySelector('#ui-venue-tabs')?.addEventListener('click', evt => {
      const btn = (evt.target as HTMLElement).closest('button[data-venue]') as HTMLButtonElement | null
      const venue = btn?.dataset.venue as VenueId | 'ALL' | undefined
      if (venue) this.handlers.onSelectVenueFilter(venue)
    })

    this.root.querySelector('#ui-positions')?.addEventListener('click', evt => {
      const card = (evt.target as HTMLElement).closest('[data-pos-idx]') as HTMLElement | null
      if (!card) return
      const idx = Number(card.dataset.posIdx)
      if (Number.isInteger(idx)) this.handlers.onSelectPosition(idx)
    })

    this.root.querySelector('#ui-hud-actions')?.addEventListener('click', evt => {
      const btn = (evt.target as HTMLElement).closest('button[data-hud-idx]') as HTMLButtonElement | null
      if (!btn || !this.lastState) return
      const idx = Number(btn.dataset.hudIdx)
      this.handlers.onAction(resolveHudListAction(this.lastState, idx), 'GLASSES')
    })

    this.root.querySelector('#btn-testnet')?.addEventListener('click', () => {
      const key = (this.root.querySelector('#inp-key') as HTMLInputElement).value.trim()
      const secret = (this.root.querySelector('#inp-secret') as HTMLInputElement).value.trim()
      this.handlers.onSaveTestnet(Boolean(key && secret), key, secret)
    })

    this.root.querySelector('#btn-testnet-clear')?.addEventListener('click', () => {
      const keyInp = this.root.querySelector('#inp-key') as HTMLInputElement | null
      const secInp = this.root.querySelector('#inp-secret') as HTMLInputElement | null
      if (keyInp) keyInp.value = ''
      if (secInp) secInp.value = ''
      this.handlers.onSaveTestnet(false, '', '')
    })
  }
}
