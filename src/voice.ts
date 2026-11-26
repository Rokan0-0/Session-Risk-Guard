import type { HudScreen, MarketTick, SymbolCode } from './types'

export type ParsedIntent =
  | { kind: 'confirm_yes' }
  | { kind: 'confirm_no' }
  | { kind: 'transfer_spot_to_margin'; amountUsd: number }
  | { kind: 'transfer_margin_to_spot'; amountUsd: number }
  | { kind: 'close_50'; symbol?: SymbolCode }
  | { kind: 'move_stop_entry'; symbol?: SymbolCode }
  | {
      kind: 'set_price_alert'
      symbol: SymbolCode
      direction: 'ABOVE' | 'BELOW'
      targetPrice: number
    }
  | { kind: 'switch_screen'; screen: HudScreen }
  | { kind: 'next_position' }
  | { kind: 'prev_position' }
  | { kind: 'snooze_alert' }
  | { kind: 'status_readout' }
  | { kind: 'unknown'; raw: string }

interface SpeechRecognitionAlternativeLike {
  transcript: string
}

interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike
  isFinal: boolean
  length: number
}

interface SpeechRecognitionResultListLike {
  length: number
  [index: number]: SpeechRecognitionResultLike
}

interface SpeechRecognitionEventLike {
  results: SpeechRecognitionResultListLike
}

interface SpeechRecognitionErrorEventLike {
  error: string
}

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null
}

const SYMBOL_ALIASES: Array<{ re: RegExp; symbol: SymbolCode }> = [
  { re: /\b(btc|bitcoin)\b/i, symbol: 'BTCUSDT' },
  { re: /\b(eth|ethereum)\b/i, symbol: 'ETHUSDT' },
  { re: /\b(sol|solana)\b/i, symbol: 'SOLUSDT' },
  { re: /\b(nvda|nvidia)\b/i, symbol: 'NVDA' },
  { re: /\b(spy|s&p|sp500)\b/i, symbol: 'SPY' },
]

function detectSymbol(text: string): SymbolCode | undefined {
  for (const entry of SYMBOL_ALIASES) {
    if (entry.re.test(text)) return entry.symbol
  }
  return undefined
}

function parseNumericToken(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '').toLowerCase()
  const match = cleaned.match(/^(\d+(?:\.\d+)?)(k)?$/)
  if (!match) return null
  const base = Number(match[1])
  if (!Number.isFinite(base) || base <= 0) return null
  return match[2] === 'k' ? base * 1000 : base
}

function extractAmountUsd(text: string, fallback: number): number {
  const match = text.match(/\$?\s*(\d+(?:,\d{3})*(?:\.\d+)?k?)\b/i)
  if (!match) return fallback
  return parseNumericToken(match[1]) ?? fallback
}

export function formatIntentSummary(intent: ParsedIntent): string {
  switch (intent.kind) {
    case 'confirm_yes':
      return 'Intent: Confirm YES'
    case 'confirm_no':
      return 'Intent: Cancel NO'
    case 'transfer_spot_to_margin':
      return `Intent: Move $${intent.amountUsd} Spot -> Margin`
    case 'transfer_margin_to_spot':
      return `Intent: Move $${intent.amountUsd} Margin -> Spot`
    case 'close_50':
      return `Intent: Close 50% ${intent.symbol ?? '(active)'}`
    case 'move_stop_entry':
      return `Intent: Move Stop -> Entry ${intent.symbol ?? '(active)'}`
    case 'set_price_alert':
      return `Intent: Alert ${intent.symbol} ${intent.direction} $${intent.targetPrice}`
    case 'switch_screen':
      return `Intent: Show ${intent.screen} screen`
    case 'next_position':
      return 'Intent: Next Position'
    case 'prev_position':
      return 'Intent: Previous Position'
    case 'snooze_alert':
      return 'Intent: Snooze Alert 5m'
    case 'status_readout':
      return 'Intent: Read Status / PnL'
    case 'unknown':
      return `Unrecognized phrase: "${intent.raw}"`
  }
}

export function parseVoiceCommand(
  transcript: string,
  prices: Record<SymbolCode, MarketTick>,
  activeSymbol: SymbolCode,
): ParsedIntent {
  const text = transcript.trim()
  const lower = text.toLowerCase()
  if (!lower) return { kind: 'unknown', raw: transcript }

  if (/^(yes|yeah|yep|confirm|approve|approved|proceed|ok|okay|do it|execute)\b/.test(lower)) {
    return { kind: 'confirm_yes' }
  }

  if (/^(no|nope|cancel|abort|reject|decline|stop|nevermind|never mind)\b/.test(lower)) {
    return { kind: 'confirm_no' }
  }

  // Spot -> Margin transfer (smart default $500)
  if (
    /\b(margin)\b/.test(lower) &&
    /\b(move|transfer|add|send|top up|top-up|shift|put)\b/.test(lower) &&
    !/\b(to spot|from margin)\b/.test(lower)
  ) {
    return {
      kind: 'transfer_spot_to_margin',
      amountUsd: extractAmountUsd(lower, 500),
    }
  }

  // Margin -> Spot transfer (smart default $500)
  if (
    (/\b(to spot)\b/.test(lower) || /\b(from margin)\b/.test(lower)) &&
    /\b(move|transfer|withdraw|send|shift|pull)\b/.test(lower)
  ) {
    return {
      kind: 'transfer_margin_to_spot',
      amountUsd: extractAmountUsd(lower, 500),
    }
  }

  // Close half / 50%
  if (/\b(close|trim|cut|reduce|sell)\b/.test(lower) && /\b(half|50%?|50 percent|partial)\b/.test(lower)) {
    return {
      kind: 'close_50',
      symbol: detectSymbol(lower),
    }
  }
  if (/^\s*(trim|cut)\s+(btc|bitcoin|eth|ethereum|sol|solana|nvda|nvidia|spy)\b/.test(lower)) {
    return {
      kind: 'close_50',
      symbol: detectSymbol(lower),
    }
  }

  // Move stop to entry / breakeven
  if (
    /\b(breakeven|break even|stop entry|stop to entry|protect profit|protect position)\b/.test(lower) ||
    (/\b(move|set|trail)\b/.test(lower) && /\bstop\b/.test(lower))
  ) {
    return {
      kind: 'move_stop_entry',
      symbol: detectSymbol(lower),
    }
  }

  // Price alert: "alert btc at 96k", "alert eth below 3200", "alert nvda above 145"
  if (/\b(alert|notify|ping|watch)\b/.test(lower)) {
    const symbol = detectSymbol(lower) ?? activeSymbol
    const priceMatch = lower.match(/(?:above|over|below|under|at|@)?\s*\$?\s*(\d+(?:,\d{3})*(?:\.\d+)?k?)\b(?!.*%)/i)
    const numMatch = lower.match(/\b(?:above|over|below|under|at)\s+\$?(\d+(?:,\d{3})*(?:\.\d+)?k?)\b/i) ?? priceMatch
    const parsedPrice = numMatch ? parseNumericToken(numMatch[1]) : null
    if (parsedPrice !== null) {
      const currentPrice = prices[symbol]?.price ?? parsedPrice
      let direction: 'ABOVE' | 'BELOW' = parsedPrice >= currentPrice ? 'ABOVE' : 'BELOW'
      if (/\b(above|over)\b/.test(lower)) direction = 'ABOVE'
      else if (/\b(below|under)\b/.test(lower)) direction = 'BELOW'
      return {
        kind: 'set_price_alert',
        symbol,
        direction,
        targetPrice: parsedPrice,
      }
    }
  }

  if (/\b(overview|portfolio|home)\b/.test(lower)) {
    return { kind: 'switch_screen', screen: 'PORTFOLIO' }
  }

  if (/\b(positions)\b/.test(lower)) {
    return { kind: 'switch_screen', screen: 'POSITIONS' }
  }

  if (/\b(wallet|balances)\b/.test(lower)) {
    return { kind: 'switch_screen', screen: 'WALLET' }
  }

  if (/\b(alerts)\b/.test(lower)) {
    return { kind: 'switch_screen', screen: 'ALERTS' }
  }

  if (/\b(snooze|mute|dismiss|later)\b/.test(lower)) {
    return { kind: 'snooze_alert' }
  }

  if (/\b(prev|previous|back)\b/.test(lower)) {
    return { kind: 'prev_position' }
  }

  if (/\b(next|switch|cycle)\b/.test(lower)) {
    return { kind: 'next_position' }
  }

  if (/\b(status|pnl|summary|readout|balance|position)\b/.test(lower)) {
    return { kind: 'status_readout' }
  }

  return { kind: 'unknown', raw: text }
}

export class VoiceController {
  private recognition: SpeechRecognitionLike | null = null
  private listening = false

  isSpeechSupported(): boolean {
    return getSpeechRecognitionCtor() !== null
  }

  isListening(): boolean {
    return this.listening
  }

  start(
    onTranscript: (transcript: string) => void,
    onStateChange: (listening: boolean, error?: string) => void,
  ): boolean {
    const Ctor = getSpeechRecognitionCtor()
    if (!Ctor) {
      onStateChange(false, 'Browser speech recognition not supported — type a short phrase below.')
      return false
    }

    if (this.listening && this.recognition) {
      this.stop()
      return false
    }

    const rec = new Ctor()
    rec.lang = 'en-US'
    rec.continuous = false
    rec.interimResults = false

    rec.onresult = evt => {
      const idx = evt.results.length - 1
      const transcript = evt.results[idx]?.[0]?.transcript?.trim() ?? ''
      if (transcript) {
        onTranscript(transcript)
      }
    }

    rec.onerror = evt => {
      this.listening = false
      onStateChange(false, `Mic error: ${evt.error}`)
    }

    rec.onend = () => {
      this.listening = false
      onStateChange(false)
    }

    this.recognition = rec
    try {
      rec.start()
      this.listening = true
      onStateChange(true)
      return true
    } catch (err) {
      this.listening = false
      onStateChange(false, err instanceof Error ? err.message : String(err))
      return false
    }
  }

  stop(): void {
    this.listening = false
    try {
      this.recognition?.stop()
    } catch {
      // Ignore stop error if already inactive
    }
  }

  speak(text: string): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
    try {
      window.speechSynthesis.cancel()
      const utter = new SpeechSynthesisUtterance(text)
      utter.rate = 1.08
      utter.pitch = 1.0
      window.speechSynthesis.speak(utter)
    } catch {
      // Ignore TTS failures in headless / restricted environments
    }
  }

  playCue(kind: 'prompt' | 'ok' | 'cancel' | 'alert'): void {
    if (typeof window === 'undefined') return
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    try {
      const ctx = new Ctor()
      const tones =
        kind === 'ok'
          ? [523.25, 659.25]
          : kind === 'alert'
            ? [880, 659.25]
            : kind === 'cancel'
              ? [330, 246.94]
              : [587.33]
      let startAt = ctx.currentTime
      for (const freq of tones) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq, startAt)
        gain.gain.setValueAtTime(0.06, startAt)
        gain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.11)
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.start(startAt)
        osc.stop(startAt + 0.12)
        startAt += 0.11
      }
      window.setTimeout(() => {
        void ctx.close().catch(() => {})
      }, 450)
    } catch {
      // Ignore Web Audio errors when autoplay is blocked or unsupported
    }
  }
}
