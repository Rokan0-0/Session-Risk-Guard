import { RiskGuardEngine } from './engine'
import { connectBinanceStream, startSimulatedStockFeed } from './exchange'
import { GlassesHud } from './glasses'
import { CompanionUi } from './ui'
import { VoiceController } from './voice'

const hud = new GlassesHud()
const voiceCtrl = new VoiceController()
const engine = new RiskGuardEngine({
  onSpeak: text => voiceCtrl.speak(text),
  onCue: kind => voiceCtrl.playCue(kind),
})

const appRoot = document.getElementById('app')!

function syncAll(): void {
  const state = engine.getState()
  ui.render(state)
  void hud.render(state)
}

const ui = new CompanionUi(appRoot, {
  onAction: (action, source) => {
    void engine.handleAction(action, source).then(syncAll)
  },
  onPromptSpotToMargin: amountUsd => {
    engine.requestConfirmation('transfer_spot_to_margin', { amountUsd, source: 'UI' })
    syncAll()
  },
  onPromptMarginToSpot: amountUsd => {
    engine.requestConfirmation('transfer_margin_to_spot', { amountUsd, source: 'UI' })
    syncAll()
  },
  onSetTransferAmount: amountUsd => {
    engine.setTransferAmount(amountUsd, 'UI')
    syncAll()
  },
  onSelectScreen: screen => {
    engine.setScreen(screen, 'UI')
    syncAll()
  },
  onSimulateDip: () => {
    engine.simulateDip()
    syncAll()
  },
  onSimulatePriceAlert: () => {
    engine.simulatePriceAlert()
    syncAll()
  },
  onResetSession: () => {
    engine.resetSession()
    syncAll()
  },
  onSelectPosition: idx => {
    engine.selectPosition(idx)
    syncAll()
  },
  onSelectVenueFilter: venue => {
    engine.selectVenueFilter(venue)
    syncAll()
  },
  onRunVoicePhrase: phrase => {
    engine.handleVoicePhrase(phrase, 'VOICE')
    syncAll()
  },
  onToggleMic: () => {
    if (voiceCtrl.isListening()) {
      voiceCtrl.stop()
      engine.setVoiceState({ listening: false, g2MicActive: false })
      void hud.setAudioCapture(false)
      syncAll()
      return
    }
    void hud.setAudioCapture(true).then(ok => {
      engine.setVoiceState({ g2MicActive: ok })
      syncAll()
    })
    voiceCtrl.start(
      transcript => {
        engine.handleVoicePhrase(transcript, 'VOICE')
        syncAll()
      },
      (listening, err) => {
        if (!listening) {
          void hud.setAudioCapture(false)
        }
        engine.setVoiceState({
          listening,
          g2MicActive: listening ? engine.getState().voice.g2MicActive : false,
          ...(err ? { lastParsedSummary: err } : {}),
        })
        syncAll()
      },
    )
    syncAll()
  },
  onToggleTts: enabled => {
    engine.setTtsEnabled(enabled)
    syncAll()
  },
  onToggleRequireConfirm: required => {
    engine.setRequireConfirm(required)
    syncAll()
  },
  onAddPriceAlert: (symbol, direction, targetPrice) => {
    engine.addPriceAlert(symbol, direction, targetPrice)
    syncAll()
  },
  onSaveTestnet: (enabled, apiKey, apiSecret) => {
    engine.setTestnet(enabled, apiKey, apiSecret)
    syncAll()
  },
})

// Initial render
syncAll()

// Auto-dismiss transient G2 receipt overlays after 4 seconds
window.setInterval(() => {
  if (engine.expireReceiptIfNeeded()) {
    syncAll()
  }
}, 500)

// Connect Even G2 HUD bridge
void hud.init(
  () => engine.getState(),
  (action, source) => {
    void engine.handleAction(action, source).then(syncAll)
  },
  connected => {
    engine.setGlassesConnected(connected)
    syncAll()
  },
)

// Connect live Binance WebSocket (Crypto)
connectBinanceStream(
  tick => {
    engine.applyMarketTick(tick, true)
    syncAll()
  },
  connected => {
    engine.setConnected(connected)
    syncAll()
  },
)

// Start live-simulated stock ticks (IBKR NVDA / SPY)
startSimulatedStockFeed(
  () => engine.getState().prices,
  tick => {
    engine.applyMarketTick(tick, false)
    syncAll()
  },
)
