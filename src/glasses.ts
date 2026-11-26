import {
  CreateStartUpPageContainer,
  EvenAppBridge,
  EventSourceType,
  ListContainerProperty,
  ListItemContainerProperty,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import {
  computePositionMetrics,
  computeTotalUnrealizedPnl,
  getEffectivePrice,
} from './exchange'
import type { InputSource, PriceAlert, SessionState } from './types'

export type HudAction =
  | 'confirm_yes'
  | 'confirm_no'
  | 'dismiss_receipt'
  | 'prompt_move_500_margin'
  | 'prompt_move_500_spot'
  | 'close_50'
  | 'move_stop_entry'
  | 'next_position'
  | 'prev_position'
  | 'snooze_alert'
  | 'quick_btc_alert'
  | 'go_portfolio'
  | 'go_positions'
  | 'go_wallet'
  | 'go_alerts'

export type HudMode =
  | 'confirm'
  | 'receipt'
  | 'alert'
  | 'portfolio'
  | 'positions'
  | 'wallet'
  | 'alerts'

export interface HudModel {
  mode: HudMode
  headerText: string
  bodyText: string
  actionItems: string[]
}

function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function fmtUsd(val: number): string {
  const sign = val >= 0 ? '+' : '-'
  return `${sign}$${Math.abs(val).toFixed(2)}`
}

function fmtPrice(val: number): string {
  return val >= 1000
    ? val.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : val.toFixed(2)
}

function clampLine(text: string, max = 56): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`
}

export function renderHealthBar(pct: number, width = 8): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 200) * width)))
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`
}

function formatAlertSummaryLine(alert: PriceAlert | undefined, now: number): string {
  if (!alert) return '(Empty alert slot)'
  const tag = alert.triggered ? '[HIT]' : alert.snoozedUntil > now ? '[Zzz]' : '[ARM]'
  return `${tag} ${alert.label}`
}

export function formatHudModel(state: SessionState): HudModel {
  const totalPnl = computeTotalUnrealizedPnl(state) + state.realizedPnl

  // Priority 1: Pending Yes/No confirmation overlay
  if (state.pendingConfirmation) {
    const p = state.pendingConfirmation
    const headerText = clampLine(
      `CONFIRM ACTION | PnL ${fmtUsd(totalPnl)} | Mgn ${state.balances.marginHealthPct}%`,
    )
    const bodyText = [
      clampLine(`>> ${p.promptTitle}`),
      clampLine(p.detailLine),
      clampLine('Tap Ring/Glasses or say "Yes" / "No"'),
    ].join('\n')
    return {
      mode: 'confirm',
      headerText,
      bodyText,
      actionItems: ['YES - Confirm & Execute', 'NO - Cancel'],
    }
  }

  // Priority 2: Transient execution/block receipt overlay
  if (state.lastReceipt) {
    const r = state.lastReceipt
    const headerText = clampLine(
      r.ok
        ? `OK - EXECUTED [${r.source}] | Mgn ${state.balances.marginHealthPct}%`
        : `BLOCKED - NOTICE [${r.source}]`,
    )
    const bodyText = [
      clampLine(`${r.ok ? '[OK]' : '[X]'} ${r.title}`),
      clampLine(r.detail),
      clampLine('Tap Done or auto-closes in 4s...'),
    ].join('\n')
    return {
      mode: 'receipt',
      headerText,
      bodyText,
      actionItems: ['Done - Continue'],
    }
  }

  // Priority 3a: Drawdown risk alert overlay
  const alertPos = state.alertPositionId
    ? state.positions.find(p => p.id === state.alertPositionId && p.size > 0)
    : undefined

  if (alertPos) {
    const mark = getEffectivePrice(state, alertPos.symbol)
    const { pnlUsd, pnlPct } = computePositionMetrics(alertPos, mark)
    return {
      mode: 'alert',
      headerText: clampLine(
        `RISK ALERT [${alertPos.venue}] | PnL ${fmtUsd(totalPnl)} | Mgn ${state.balances.marginHealthPct}%`,
      ),
      bodyText: [
        clampLine(`!! ${alertPos.label} ${pnlPct.toFixed(2)}% (${fmtUsd(pnlUsd)}) !!`),
        clampLine(
          `Mark ${fmtPrice(mark)} (${alertPos.alertDrawdownPct}%) | ${renderHealthBar(state.balances.marginHealthPct)} ${state.balances.marginHealthPct}%`,
        ),
        clampLine('1-Tap: Move $500 Margin or Close 50%'),
      ].join('\n'),
      actionItems: ['Move $500 Spot -> Margin', 'Close 50% Market', 'Snooze Alert 5m'],
    }
  }

  // Priority 3b: Price alert overlay
  const priceAlert = state.activePriceAlertId
    ? state.priceAlerts.find(a => a.id === state.activePriceAlertId)
    : undefined

  if (priceAlert) {
    const mark = getEffectivePrice(state, priceAlert.symbol)
    return {
      mode: 'alert',
      headerText: clampLine(
        `PRICE ALERT | PnL ${fmtUsd(totalPnl)} | Mgn ${state.balances.marginHealthPct}%`,
      ),
      bodyText: [
        clampLine(`>> PRICE HIT: ${priceAlert.label}`),
        clampLine(`Mark $${fmtPrice(mark)} crossed $${fmtPrice(priceAlert.targetPrice)}`),
        clampLine('Tap action or say "Close half" / "Snooze"'),
      ].join('\n'),
      actionItems: ['Move Stop -> Entry', 'Close 50% Market', 'Snooze Alert 5m'],
    }
  }

  // Screen 1: Portfolio Overview (Default)
  if (state.activeScreen === 'PORTFOLIO') {
    const openCount = state.positions.filter(p => p.size > 0).length
    const armedAlerts = state.priceAlerts.filter(a => !a.triggered).length
    const btc = fmtPrice(getEffectivePrice(state, 'BTCUSDT'))
    const eth = fmtPrice(getEffectivePrice(state, 'ETHUSDT'))
    const nvda = fmtPrice(getEffectivePrice(state, 'NVDA'))
    return {
      mode: 'portfolio',
      headerText: clampLine(`RISK [${state.status}] | PnL ${fmtUsd(totalPnl)} | 5 VENUES`),
      bodyText: [
        clampLine(
          `Spot $${Math.round(state.balances.spotUsd)} | Mgn $${Math.round(state.balances.marginUsd)} ${renderHealthBar(state.balances.marginHealthPct)} ${state.balances.marginHealthPct}%`,
        ),
        clampLine(`BTC ${btc} | ETH ${eth} | NVDA ${nvda}`),
        clampLine(
          `Open: ${openCount}/${state.positions.length} | Alerts: ${armedAlerts} | Voice:${state.voice.listening ? 'ON' : 'Ready'}`,
        ),
      ].join('\n'),
      actionItems: ['Positions (5 Venues)', 'Move $500 Spot -> Margin', 'Wallet & Safety'],
    }
  }

  // Screen 3: Wallet & Safety Guardrails
  if (state.activeScreen === 'WALLET') {
    return {
      mode: 'wallet',
      headerText: clampLine(
        `WALLET & SAFETY | ${renderHealthBar(state.balances.marginHealthPct)} ${state.balances.marginHealthPct}%`,
      ),
      bodyText: [
        clampLine(
          `Spot $${Math.round(state.balances.spotUsd)} | Mgn $${Math.round(state.balances.marginUsd)} | Cap $${state.safety.maxSingleTransferUsd}`,
        ),
        clampLine(
          `Session ${fmtUsd(totalPnl)} | Daily Loss Cap -$${state.safety.dailyLossLimitUsd}`,
        ),
        clampLine(
          `Yes/No Gate: ${state.safety.requireConfirm ? 'ON' : 'OFF'} | Input: ${state.lastInputSource}`,
        ),
      ].join('\n'),
      actionItems: ['Move $500 Spot -> Margin', 'Move $500 Margin -> Spot', 'Price Alerts'],
    }
  }

  // Screen 4: Price Alerts
  if (state.activeScreen === 'ALERTS') {
    const now = Date.now()
    const armedCount = state.priceAlerts.filter(a => !a.triggered).length
    const btcMark = fmtPrice(getEffectivePrice(state, 'BTCUSDT'))
    return {
      mode: 'alerts',
      headerText: clampLine(`PRICE ALERTS (${armedCount} ARMED) | BTC ${btcMark}`),
      bodyText: [
        clampLine(formatAlertSummaryLine(state.priceAlerts[0], now)),
        clampLine(formatAlertSummaryLine(state.priceAlerts[1], now)),
        clampLine('Voice: "Alert BTC at 96k" | Tap Quick Alert'),
      ].join('\n'),
      actionItems: ['Quick Alert: BTC +1%', 'Back to Overview', 'Open Positions'],
    }
  }

  // Screen 2: Positions Detail
  const activePos = state.positions[state.activeIndex] ?? state.positions[0]
  const totalCount = Math.max(1, state.positions.length)
  const idxStr = `${state.activeIndex + 1}/${totalCount}`
  const headerText = clampLine(
    `POS ${idxStr} [${activePos?.venue ?? 'ALL'}] | PnL ${fmtUsd(totalPnl)} | Mgn ${state.balances.marginHealthPct}%`,
  )

  if (!activePos || activePos.size <= 0) {
    return {
      mode: 'positions',
      headerText,
      bodyText: [
        clampLine(`[${activePos?.venue ?? '-'}] ${activePos?.label ?? '-'} is FLAT`),
        clampLine(
          `Spot $${Math.round(state.balances.spotUsd)} | Mgn $${Math.round(state.balances.marginUsd)} | Real ${fmtUsd(state.realizedPnl)}`,
        ),
        clampLine('Ring Scroll: Cycle | Tap Next or Overview'),
      ].join('\n'),
      actionItems: ['Move $500 Spot -> Margin', `Next Position (${idxStr})`, 'Back to Overview'],
    }
  }

  const mark = getEffectivePrice(state, activePos.symbol)
  const { pnlUsd, pnlPct } = computePositionMetrics(activePos, mark)
  const nextIdx = (state.activeIndex + 1) % totalCount
  const nextPos = state.positions[nextIdx]

  return {
    mode: 'positions',
    headerText,
    bodyText: [
      clampLine(
        `${activePos.label} ${activePos.side} ${activePos.size} @ ${fmtPrice(activePos.entryPrice)} (${fmtPrice(mark)})`,
      ),
      clampLine(
        `PnL ${fmtUsd(pnlUsd)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%) | Stop ${fmtPrice(activePos.stopPrice)}`,
      ),
      clampLine(`Guard ${activePos.alertDrawdownPct}% | Next: ${nextPos.venue} ${nextPos.label}`),
    ].join('\n'),
    actionItems: [
      'Close 50% Market',
      'Move Stop -> Entry',
      `Next Position (${idxStr})`,
      'Back to Overview',
    ],
  }
}

export function resolveHudListAction(state: SessionState, idx: number): HudAction {
  const model = formatHudModel(state)

  if (model.mode === 'confirm') {
    return idx === 0 ? 'confirm_yes' : 'confirm_no'
  }
  if (model.mode === 'receipt') {
    return 'dismiss_receipt'
  }
  if (model.mode === 'alert') {
    if (state.alertPositionId) {
      if (idx === 0) return 'prompt_move_500_margin'
      if (idx === 1) return 'close_50'
      return 'snooze_alert'
    }
    if (idx === 0) return 'move_stop_entry'
    if (idx === 1) return 'close_50'
    return 'snooze_alert'
  }
  if (model.mode === 'portfolio') {
    if (idx === 0) return 'go_positions'
    if (idx === 1) return 'prompt_move_500_margin'
    return 'go_wallet'
  }
  if (model.mode === 'wallet') {
    if (idx === 0) return 'prompt_move_500_margin'
    if (idx === 1) return 'prompt_move_500_spot'
    return 'go_alerts'
  }
  if (model.mode === 'alerts') {
    if (idx === 0) return 'quick_btc_alert'
    if (idx === 1) return 'go_portfolio'
    return 'go_positions'
  }

  // positions mode
  const activePos = state.positions[state.activeIndex] ?? state.positions[0]
  if (!activePos || activePos.size <= 0) {
    if (idx === 0) return 'prompt_move_500_margin'
    if (idx === 1) return 'next_position'
    return 'go_portfolio'
  }
  if (idx === 0) return 'close_50'
  if (idx === 1) return 'move_stop_entry'
  if (idx === 2) return 'next_position'
  return 'go_portfolio'
}

export class GlassesHud {
  private bridge: EvenAppBridge | null = null
  private pageReady = false
  private currentMode: HudMode = 'portfolio'
  private lastActionsKey = ''
  private lastHeader = ''
  private lastBody = ''
  private unsubscribe: (() => void) | null = null
  private rendering = false
  private pendingState: SessionState | null = null
  private lastTextUpgradeAt = 0
  private throttleTimer: number | null = null

  async init(
    getState: () => SessionState,
    onAction: (action: HudAction, source: InputSource) => void,
    onBridgeConnected: (connected: boolean) => void,
    onAudioData?: (pcm: Uint8Array) => void,
  ): Promise<void> {
    // Non-blocking bridge wait: works both in evenhub-simulator and standalone browser
    try {
      const bridge = await Promise.race([
        waitForEvenAppBridge(),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 6000)),
      ])
      if (!bridge) {
        onBridgeConnected(false)
        return
      }

      this.bridge = bridge
      onBridgeConnected(true)

      const model = formatHudModel(getState())
      this.currentMode = model.mode
      this.lastActionsKey = model.actionItems.join('|')
      this.lastHeader = model.headerText
      this.lastBody = model.bodyText

      const result = await bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({
          containerTotalNum: 3,
          textObject: [
            this.buildHeaderContainer(model.headerText),
            this.buildBodyContainer(model.bodyText),
          ],
          listObject: [this.buildActionList(model.actionItems)],
        }),
      )

      this.pageReady = result === 0
      console.info('[G2 HUD] Startup container result:', result)

      this.unsubscribe = bridge.onEvenHubEvent(event => {
        if (event.audioEvent?.audioPcm) {
          onAudioData?.(event.audioEvent.audioPcm)
          return
        }

        const sysType = eventTypeOf(event.sysEvent)
        const textType = eventTypeOf(event.textEvent)
        const listType = eventTypeOf(event.listEvent)
        const source: InputSource =
          event.sysEvent?.eventSource === EventSourceType.TOUCH_EVENT_FROM_RING
            ? 'RING'
            : 'GLASSES'

        console.info('[G2 Event]', {
          source,
          listType,
          listIdx: event.listEvent?.currentSelectItemIndex,
          listName: event.listEvent?.currentSelectItemName,
          sysType,
          textType,
        })

        if (
          sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
          textType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
          listType === OsEventTypeList.DOUBLE_CLICK_EVENT
        ) {
          bridge.shutDownPageContainer(1)
          return
        }

        if (
          sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
          sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
        ) {
          this.unsubscribe?.()
          return
        }

        if (event.listEvent && listType === OsEventTypeList.CLICK_EVENT) {
          const snapshot = getState()
          let idx = event.listEvent.currentSelectItemIndex
          if (idx === undefined || idx === null) {
            const name = event.listEvent.currentSelectItemName
            const items = formatHudModel(snapshot).actionItems
            const matchedIdx = name ? items.indexOf(name) : -1
            idx = matchedIdx >= 0 ? matchedIdx : 0
          }
          onAction(resolveHudListAction(snapshot, idx), source)
          return
        }

        // Ring / Temple scroll or fallback tap when not consumed by listEvent
        if (!event.listEvent) {
          if (
            sysType === OsEventTypeList.SCROLL_TOP_EVENT ||
            textType === OsEventTypeList.SCROLL_TOP_EVENT
          ) {
            onAction('prev_position', source)
            return
          }
          if (
            sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
            textType === OsEventTypeList.SCROLL_BOTTOM_EVENT
          ) {
            onAction('next_position', source)
            return
          }
          if (sysType === OsEventTypeList.CLICK_EVENT) {
            const snapshot = getState()
            if (snapshot.pendingConfirmation) {
              onAction('confirm_yes', source)
            } else if (snapshot.lastReceipt) {
              onAction('dismiss_receipt', source)
            } else {
              onAction('next_position', source)
            }
          }
        }
      })
    } catch (err) {
      console.warn('[G2 HUD] Init error:', err)
      onBridgeConnected(false)
    }
  }

  async setAudioCapture(open: boolean): Promise<boolean> {
    if (!this.bridge) return false
    try {
      return await this.bridge.audioControl(open)
    } catch {
      return false
    }
  }

  async render(state: SessionState): Promise<void> {
    if (!this.bridge || !this.pageReady) return
    this.pendingState = state
    if (this.rendering) return
    await this.flushRender()
  }

  private async flushRender(): Promise<void> {
    if (!this.bridge || !this.pageReady || this.rendering) return

    while (this.pendingState) {
      const nextState = this.pendingState
      const model = formatHudModel(nextState)
      const actionsKey = model.actionItems.join('|')
      const needsRebuild = model.mode !== this.currentMode || actionsKey !== this.lastActionsKey

      if (needsRebuild) {
        this.pendingState = null
        if (this.throttleTimer !== null) {
          window.clearTimeout(this.throttleTimer)
          this.throttleTimer = null
        }
        this.rendering = true
        try {
          const ok = await this.bridge.rebuildPageContainer(
            new RebuildPageContainer({
              containerTotalNum: 3,
              textObject: [
                this.buildHeaderContainer(model.headerText),
                this.buildBodyContainer(model.bodyText),
              ],
              listObject: [this.buildActionList(model.actionItems)],
            }),
          )
          if (ok !== false) {
            this.currentMode = model.mode
            this.lastActionsKey = actionsKey
            this.lastHeader = model.headerText
            this.lastBody = model.bodyText
            this.lastTextUpgradeAt = Date.now()
          }
        } catch (err) {
          console.warn('[G2 HUD] rebuildPageContainer failed:', err)
        } finally {
          this.rendering = false
        }
        continue
      }

      const headerChanged = model.headerText !== this.lastHeader
      const bodyChanged = model.bodyText !== this.lastBody
      if (!headerChanged && !bodyChanged) {
        this.pendingState = null
        break
      }

      const elapsed = Date.now() - this.lastTextUpgradeAt
      if (elapsed < 350) {
        if (this.throttleTimer === null) {
          this.throttleTimer = window.setTimeout(() => {
            this.throttleTimer = null
            if (!this.rendering && this.pendingState) {
              void this.flushRender()
            }
          }, 350 - elapsed)
        }
        break
      }

      this.pendingState = null
      this.rendering = true
      try {
        if (headerChanged) {
          const ok = await this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({
              containerID: 1,
              containerName: 'hud-header',
              content: model.headerText,
            }),
          )
          if (ok !== false) this.lastHeader = model.headerText
        }
        if (bodyChanged) {
          const ok = await this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({
              containerID: 2,
              containerName: 'hud-body',
              content: model.bodyText,
            }),
          )
          if (ok !== false) this.lastBody = model.bodyText
        }
        this.lastTextUpgradeAt = Date.now()
      } catch (err) {
        console.warn('[G2 HUD] textContainerUpgrade failed:', err)
      } finally {
        this.rendering = false
      }
    }
  }

  private buildHeaderContainer(content: string): TextContainerProperty {
    return new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 44,
      borderWidth: 1,
      borderColor: 5,
      paddingLength: 6,
      containerID: 1,
      containerName: 'hud-header',
      content,
      isEventCapture: 0,
    })
  }

  private buildBodyContainer(content: string): TextContainerProperty {
    return new TextContainerProperty({
      xPosition: 0,
      yPosition: 48,
      width: 576,
      height: 116,
      borderWidth: 1,
      borderColor: 5,
      paddingLength: 8,
      containerID: 2,
      containerName: 'hud-body',
      content,
      isEventCapture: 0,
    })
  }

  private buildActionList(items: string[]): ListContainerProperty {
    return new ListContainerProperty({
      xPosition: 0,
      yPosition: 168,
      width: 576,
      height: 120,
      borderWidth: 1,
      borderColor: 5,
      paddingLength: 6,
      containerID: 3,
      containerName: 'hud-actions',
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length,
        itemWidth: 552,
        isItemSelectBorderEn: 1,
        itemName: items,
      }),
    })
  }
}
