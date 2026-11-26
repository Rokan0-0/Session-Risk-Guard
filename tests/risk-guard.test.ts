import assert from 'node:assert/strict'
import test from 'node:test'
import { RiskGuardEngine } from '../src/engine'
import { formatHudModel, resolveHudListAction } from '../src/glasses'
import type { SessionState } from '../src/types'
import { parseVoiceCommand } from '../src/voice'

function assertHudInvariants(state: SessionState, label: string): void {
  const model = formatHudModel(state)
  const printableAscii = /^[\x20-\x7E\n]*$/
  assert.ok(!model.headerText.includes('\n'), `${label}: header must be single line`)
  assert.ok(model.headerText.length > 0 && model.headerText.length <= 56, `${label}: header length ${model.headerText.length} > 56`)
  assert.match(model.headerText, printableAscii, `${label}: header must be printable ASCII`)

  const bodyLines = model.bodyText.split('\n')
  assert.ok(bodyLines.length >= 1 && bodyLines.length <= 3, `${label}: body has ${bodyLines.length} lines (expected 1..3)`)
  for (const line of bodyLines) {
    assert.ok(line.length <= 56, `${label}: body line exceeds 56 chars (${line.length}): "${line}"`)
    assert.match(line, printableAscii, `${label}: body line must be printable ASCII`)
  }

  assert.ok(model.actionItems.length >= 1 && model.actionItems.length <= 4, `${label}: actions count ${model.actionItems.length} out of 1..4`)
  for (let i = 0; i < model.actionItems.length; i++) {
    assert.match(model.actionItems[i], printableAscii, `${label}: action item ${i} must be printable ASCII`)
    const resolved = resolveHudListAction(state, i)
    assert.equal(typeof resolved, 'string', `${label}: resolveHudListAction(${i}) must return string`)
  }
}

test('Confirm Flow: Move $500 Spot -> Margin (YES executes & NO cancels)', async () => {
  let clock = 1_000_000
  const engine = new RiskGuardEngine({ now: () => clock })
  const s0 = engine.getState()
  const initialHealth = s0.balances.marginHealthPct
  assert.equal(s0.balances.spotUsd, 4250)
  assert.equal(s0.balances.marginUsd, 1800)

  // Trigger Spot -> Margin confirmation
  await engine.handleAction('prompt_move_500_margin', 'UI')
  const sConfirm = engine.getState()
  assert.equal(sConfirm.status, 'CONFIRM')
  assert.equal(sConfirm.pendingConfirmation?.promptTitle, 'Move $500 from Spot to Margin?')
  assert.equal(formatHudModel(sConfirm).mode, 'confirm')
  assert.deepEqual(formatHudModel(sConfirm).actionItems, ['YES - Confirm & Execute', 'NO - Cancel'])
  assertHudInvariants(sConfirm, 'confirm-spot-to-margin')

  // Confirm YES via Glasses
  await engine.handleAction(resolveHudListAction(sConfirm, 0), 'GLASSES')
  const sAfterYes = engine.getState()
  assert.equal(sAfterYes.pendingConfirmation, null)
  assert.equal(sAfterYes.balances.spotUsd, 3750)
  assert.equal(sAfterYes.balances.marginUsd, 2300)
  assert.ok(sAfterYes.balances.marginHealthPct > initialHealth)
  assert.equal(sAfterYes.status, 'EXECUTED')
  assert.equal(sAfterYes.lastReceipt?.ok, true)
  assert.equal(sAfterYes.lastReceipt?.title, 'Moved $500 Spot -> Margin')
  assert.equal(formatHudModel(sAfterYes).mode, 'receipt')
  assertHudInvariants(sAfterYes, 'receipt-after-yes')

  // Trigger again and cancel NO via Ring
  await engine.handleAction('prompt_move_500_margin', 'UI')
  await engine.handleAction(resolveHudListAction(engine.getState(), 1), 'RING')
  const sAfterNo = engine.getState()
  assert.equal(sAfterNo.pendingConfirmation, null)
  assert.equal(sAfterNo.balances.spotUsd, 3750)
  assert.equal(sAfterNo.balances.marginUsd, 2300)
  assert.equal(sAfterNo.lastReceipt?.ok, false)
  assert.equal(sAfterNo.lastReceipt?.title, 'ACTION CANCELLED')
  assert.ok(sAfterNo.logs[0].message.includes('CANCELLED [RING]'))
})

test('Confirm Flow: Move $500 Margin -> Spot (YES and NO)', async () => {
  const engine = new RiskGuardEngine()
  await engine.handleAction('go_wallet', 'GLASSES')
  assert.equal(formatHudModel(engine.getState()).mode, 'wallet')

  await engine.handleAction('prompt_move_500_spot', 'GLASSES')
  assert.equal(engine.getState().pendingConfirmation?.promptTitle, 'Move $500 from Margin to Spot?')

  await engine.handleAction('confirm_yes', 'GLASSES')
  assert.equal(engine.getState().balances.marginUsd, 1300)
  assert.equal(engine.getState().balances.spotUsd, 4750)

  await engine.handleAction('prompt_move_500_spot', 'GLASSES')
  await engine.handleAction('confirm_no', 'GLASSES')
  assert.equal(engine.getState().balances.marginUsd, 1300)
  assert.equal(engine.getState().balances.spotUsd, 4750)
})

test('Confirm Flow: Close 50% Market + Testnet routing + close to FLAT + Move Stop', async () => {
  const testnetCalls: Array<{ symbol: string; side: string; qty: number }> = []
  const engine = new RiskGuardEngine({
    sendTestnetOrder: async (_k, _s, symbol, side, qty) => {
      testnetCalls.push({ symbol, side, qty })
      return { ok: true, detail: 'Testnet #42' }
    },
  })

  engine.setTestnet(true, 'test-key', 'test-secret')

  // 1. BINANCE BTC-PERP (index 0, size 0.25) -> close 50% -> calls Testnet
  engine.selectPosition(0)
  await engine.handleAction('close_50', 'GLASSES')
  assert.equal(engine.getState().status, 'CONFIRM')
  assert.ok(engine.getState().pendingConfirmation?.promptTitle.includes('Close 50% BTC-PERP [BINANCE]?'))

  await engine.handleAction('confirm_yes', 'GLASSES')
  assert.equal(engine.getState().positions[0].size, 0.125)
  assert.equal(testnetCalls.length, 1)
  assert.deepEqual(testnetCalls[0], { symbol: 'BTCUSDT', side: 'SELL', qty: 0.125 })

  // 2. IBKR NVDA (index 4, size 40) -> close 50% -> must NOT call Binance Testnet
  engine.selectPosition(4)
  await engine.handleAction('close_50', 'UI')
  await engine.handleAction('confirm_yes', 'UI')
  assert.equal(engine.getState().positions[4].size, 20)
  assert.equal(testnetCalls.length, 1)

  // 3. Cancel NO leaves size untouched
  await engine.handleAction('close_50', 'UI')
  await engine.handleAction('confirm_no', 'UI')
  assert.equal(engine.getState().positions[4].size, 20)

  // 4. Tiny remaining position closes cleanly to 0 (FLAT)
  engine.getState().positions[4].size = 0.1
  await engine.handleAction('close_50', 'GLASSES')
  await engine.handleAction('confirm_yes', 'GLASSES')
  assert.equal(engine.getState().positions[4].size, 0)
  await engine.handleAction('dismiss_receipt', 'GLASSES')
  assertHudInvariants(engine.getState(), 'positions-flat')

  // 5. Move Stop -> Entry on ETH-PERP (index 1)
  engine.selectPosition(1)
  const eth = engine.getState().positions[1]
  await engine.handleAction('move_stop_entry', 'RING')
  await engine.handleAction('confirm_yes', 'RING')
  assert.equal(eth.stopPrice, eth.entryPrice)
  assert.ok(eth.snoozedUntil > Date.now())
})

test('Safety Guardrails: Transfer cap, zero/negative, insufficient balance, Daily Loss Limit, bypass gate', async () => {
  const engine = new RiskGuardEngine()

  // Over $1,000 single transfer cap
  engine.requestConfirmation('transfer_spot_to_margin', { amountUsd: 2000, source: 'VOICE' })
  assert.equal(engine.getState().pendingConfirmation, null)
  assert.equal(engine.getState().lastReceipt?.ok, false)
  assert.equal(engine.getState().lastReceipt?.title, 'SAFETY BLOCKED')
  assert.equal(engine.getState().balances.spotUsd, 4250)

  // Zero / negative blocked
  engine.requestConfirmation('transfer_spot_to_margin', { amountUsd: 0, source: 'UI' })
  assert.equal(engine.getState().lastReceipt?.title, 'SAFETY BLOCKED')

  // Drain Spot down to $250 via 4 valid $1,000 transfers, then check insufficient balance
  for (let i = 0; i < 4; i++) {
    engine.requestConfirmation('transfer_spot_to_margin', { amountUsd: 1000, source: 'UI' })
    await engine.confirmYes('UI')
  }
  assert.equal(engine.getState().balances.spotUsd, 250)
  engine.requestConfirmation('transfer_spot_to_margin', { amountUsd: 500, source: 'UI' })
  assert.equal(engine.getState().lastReceipt?.title, 'INSUFFICIENT SPOT')

  // Margin -> Spot insufficient balance check
  engine.getState().balances.marginUsd = 200
  engine.requestConfirmation('transfer_margin_to_spot', { amountUsd: 500, source: 'UI' })
  assert.equal(engine.getState().lastReceipt?.title, 'INSUFFICIENT MARGIN')

  // Daily loss limit warning on severe BTC crash
  const crashTick = { ...engine.getState().prices.BTCUSDT, price: 82000 }
  engine.applyMarketTick(crashTick, false)
  assert.ok(engine.getState().logs.some(l => l.message.includes('DAILY LOSS LIMIT HIT')))

  // Disable requireConfirm -> instant execution without pendingConfirmation
  engine.resetSession()
  engine.setRequireConfirm(false)
  engine.requestConfirmation('transfer_spot_to_margin', { amountUsd: 500, source: 'UI' })
  assert.equal(engine.getState().pendingConfirmation, null)
  assert.equal(engine.getState().balances.spotUsd, 3750)
  assert.equal(engine.getState().balances.marginUsd, 2300)
})

test('Alerts Lifecycle: Flash dip alert + Margin top-up resolution & Price alert trigger/snooze', async () => {
  let clock = 5_000_000
  const engine = new RiskGuardEngine({ now: () => clock })

  // 1. Flash dip triggers drawdown alert
  engine.simulateDip()
  assert.equal(engine.getState().status, 'ALERT')
  assert.equal(engine.getState().alertPositionId, 'pos-btc')
  assert.equal(formatHudModel(engine.getState()).mode, 'alert')
  assertHudInvariants(engine.getState(), 'drawdown-alert')

  // 2. Top action on drawdown alert: Move $500 Spot -> Margin -> YES resolves alert cleanly
  await engine.handleAction(resolveHudListAction(engine.getState(), 0), 'GLASSES')
  assert.equal(engine.getState().status, 'CONFIRM')
  await engine.handleAction('confirm_yes', 'GLASSES')
  assert.equal(engine.getState().alertPositionId, null)
  assert.equal(engine.getState().balances.marginUsd, 2300)

  // Next tick does NOT re-trigger alert immediately because position was snoozed
  engine.applyMarketTick(engine.getState().prices.BTCUSDT, false)
  assert.equal(engine.getState().alertPositionId, null)

  // 3. Price alert simulation & snooze
  engine.simulatePriceAlert()
  assert.equal(engine.getState().status, 'ALERT')
  assert.ok(engine.getState().activePriceAlertId !== null)
  assert.equal(formatHudModel(engine.getState()).mode, 'alert')
  assertHudInvariants(engine.getState(), 'price-alert')

  await engine.handleAction(resolveHudListAction(engine.getState(), 2), 'RING')
  assert.equal(engine.getState().activePriceAlertId, null)
  assert.equal(engine.getState().status, 'ARMED')

  // 4. Custom price alert triggers on live ETH tick
  engine.addPriceAlert('ETHUSDT', 'ABOVE', 3500)
  assert.equal(engine.getState().activePriceAlertId, null)
  engine.applyMarketTick({ symbol: 'ETHUSDT', price: 3505, change24hPct: 5.5, updatedAt: clock }, true)
  assert.equal(engine.getState().status, 'ALERT')
  assert.ok(engine.getState().activePriceAlertId !== null)
})

test('Voice Intent Parser & E2E Voice Commands', async () => {
  const spoken: string[] = []
  const engine = new RiskGuardEngine({ onSpeak: text => spoken.push(text) })
  const prices = engine.getState().prices

  assert.deepEqual(parseVoiceCommand('Move $500 to margin', prices, 'BTCUSDT'), {
    kind: 'transfer_spot_to_margin',
    amountUsd: 500,
  })
  assert.deepEqual(parseVoiceCommand('Top up margin', prices, 'BTCUSDT'), {
    kind: 'transfer_spot_to_margin',
    amountUsd: 500,
  })
  assert.deepEqual(parseVoiceCommand('Move 300 from margin to spot', prices, 'BTCUSDT'), {
    kind: 'transfer_margin_to_spot',
    amountUsd: 300,
  })
  assert.deepEqual(parseVoiceCommand('Close half', prices, 'BTCUSDT'), {
    kind: 'close_50',
    symbol: undefined,
  })
  assert.deepEqual(parseVoiceCommand('Trim NVDA', prices, 'BTCUSDT'), {
    kind: 'close_50',
    symbol: 'NVDA',
  })
  assert.deepEqual(parseVoiceCommand('Move stop to entry', prices, 'BTCUSDT'), {
    kind: 'move_stop_entry',
    symbol: undefined,
  })
  assert.deepEqual(parseVoiceCommand('Alert BTC at 96k', prices, 'BTCUSDT'), {
    kind: 'set_price_alert',
    symbol: 'BTCUSDT',
    direction: 'ABOVE',
    targetPrice: 96000,
  })
  assert.deepEqual(parseVoiceCommand('Alert ETH below 3200', prices, 'BTCUSDT'), {
    kind: 'set_price_alert',
    symbol: 'ETHUSDT',
    direction: 'BELOW',
    targetPrice: 3200,
  })
  assert.deepEqual(parseVoiceCommand('Yes', prices, 'BTCUSDT'), { kind: 'confirm_yes' })
  assert.deepEqual(parseVoiceCommand('No', prices, 'BTCUSDT'), { kind: 'confirm_no' })
  assert.deepEqual(parseVoiceCommand('Snooze', prices, 'BTCUSDT'), { kind: 'snooze_alert' })
  assert.deepEqual(parseVoiceCommand('Next', prices, 'BTCUSDT'), { kind: 'next_position' })
  assert.deepEqual(parseVoiceCommand('Previous', prices, 'BTCUSDT'), { kind: 'prev_position' })
  assert.deepEqual(parseVoiceCommand('Overview', prices, 'BTCUSDT'), { kind: 'switch_screen', screen: 'PORTFOLIO' })
  assert.deepEqual(parseVoiceCommand('Positions', prices, 'BTCUSDT'), { kind: 'switch_screen', screen: 'POSITIONS' })
  assert.deepEqual(parseVoiceCommand('Wallet', prices, 'BTCUSDT'), { kind: 'switch_screen', screen: 'WALLET' })
  assert.deepEqual(parseVoiceCommand('Alerts', prices, 'BTCUSDT'), { kind: 'switch_screen', screen: 'ALERTS' })
  assert.deepEqual(parseVoiceCommand('Status', prices, 'BTCUSDT'), { kind: 'status_readout' })
  assert.equal(parseVoiceCommand('banana waffle', prices, 'BTCUSDT').kind, 'unknown')

  // E2E Voice: Move 500 to margin -> Yes
  engine.handleVoicePhrase('Move 500 to margin', 'VOICE')
  assert.equal(engine.getState().status, 'CONFIRM')
  engine.handleVoicePhrase('Yes', 'VOICE')
  assert.equal(engine.getState().balances.spotUsd, 3750)
  assert.equal(engine.getState().balances.marginUsd, 2300)
  assert.equal(engine.getState().lastInputSource, 'VOICE')

  // Voice status readout calls onSpeak
  engine.handleVoicePhrase('Status', 'VOICE')
  assert.ok(spoken.some(s => s.includes('Session PnL') && s.includes('Margin Health')))
})

test('576x288 G2 HUD Multi-Screen Cycle, Receipt Auto-Expiry & Live Anchor Guard', async () => {
  let clock = 10_000
  const engine = new RiskGuardEngine({ now: () => clock })

  // Screen 1: Portfolio Overview
  assert.equal(formatHudModel(engine.getState()).mode, 'portfolio')
  assertHudInvariants(engine.getState(), 'screen-portfolio')

  // Navigate to Positions via item 0
  await engine.handleAction(resolveHudListAction(engine.getState(), 0), 'GLASSES')
  assert.equal(engine.getState().activeScreen, 'POSITIONS')
  assert.equal(formatHudModel(engine.getState()).mode, 'positions')
  assertHudInvariants(engine.getState(), 'screen-positions')

  // Ring scroll cycles positions
  await engine.handleAction('next_position', 'RING')
  assert.equal(engine.getState().activeIndex, 1)
  await engine.handleAction('prev_position', 'RING')
  assert.equal(engine.getState().activeIndex, 0)

  // Back to Overview via item 3
  await engine.handleAction(resolveHudListAction(engine.getState(), 3), 'GLASSES')
  assert.equal(engine.getState().activeScreen, 'PORTFOLIO')

  // Navigate to Wallet via item 2
  await engine.handleAction(resolveHudListAction(engine.getState(), 2), 'GLASSES')
  assert.equal(engine.getState().activeScreen, 'WALLET')
  assert.equal(formatHudModel(engine.getState()).mode, 'wallet')
  assertHudInvariants(engine.getState(), 'screen-wallet')

  // Navigate to Alerts via item 2
  await engine.handleAction(resolveHudListAction(engine.getState(), 2), 'GLASSES')
  assert.equal(engine.getState().activeScreen, 'ALERTS')
  assert.equal(formatHudModel(engine.getState()).mode, 'alerts')
  assertHudInvariants(engine.getState(), 'screen-alerts')

  // Quick BTC Alert creates receipt that expires after TTL
  const initialAlerts = engine.getState().priceAlerts.length
  await engine.handleAction(resolveHudListAction(engine.getState(), 0), 'GLASSES')
  assert.equal(engine.getState().priceAlerts.length, initialAlerts + 1)
  assert.equal(formatHudModel(engine.getState()).mode, 'receipt')
  assert.equal(engine.expireReceiptIfNeeded(), false)
  clock += 3001
  assert.equal(engine.expireReceiptIfNeeded(), true)
  assert.equal(formatHudModel(engine.getState()).mode, 'alerts')

  // Live tick re-anchoring does NOT clobber active trades
  engine.selectPosition(0)
  await engine.handleAction('close_50', 'UI')
  await engine.handleAction('confirm_yes', 'UI')
  const halvedSize = engine.getState().positions[0].size
  engine.applyMarketTick({ symbol: 'BTCUSDT', price: 97000, change24hPct: 2.5, updatedAt: clock }, true)
  assert.equal(engine.getState().positions[0].size, halvedSize)
})

test('Per-symbol live anchoring prevents bogus startup alert when ETH arrives before BTC', () => {
  const engine = new RiskGuardEngine()
  // Live ETH arrives first at a drastically different price than fallback $3320
  engine.applyMarketTick({ symbol: 'ETHUSDT', price: 1696, change24hPct: -1.1, updatedAt: 1000 }, true)
  engine.applyMarketTick({ symbol: 'SOLUSDT', price: 95, change24hPct: 0.4, updatedAt: 1001 }, true)
  engine.applyMarketTick({ symbol: 'BTCUSDT', price: 68500, change24hPct: 0.9, updatedAt: 1002 }, true)

  const s = engine.getState()
  assert.equal(s.status, 'ARMED')
  assert.equal(s.alertPositionId, null)
  assert.equal(formatHudModel(s).mode, 'portfolio')
})
