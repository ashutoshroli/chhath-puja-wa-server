import express from 'express'
import fs from 'fs'
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode'
import NodeCache from 'node-cache'
import pino from 'pino'

const app  = express()
const PORT = process.env.PORT || 3000

app.use(express.json())

// ── CORS ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

// ── Session Store ─────────────────────────────────────────────
const sessions = new NodeCache({ stdTTL: 0, useClones: false })
const qrCache  = new NodeCache({ stdTTL: 120 })

// Silent logger
const logger = pino({ level: 'silent' })

// ── Helper: clear auth folder ─────────────────────────────────
function clearAuth(adminId) {
  const authFolder = `/tmp/wa_auth_${adminId}`
  if (fs.existsSync(authFolder)) {
    fs.rmSync(authFolder, { recursive: true, force: true })
    console.log(`[${adminId}] Auth folder cleared`)
  }
}

// ── Helper: kill existing socket ──────────────────────────────
function killSession(adminId) {
  const sessionKey = `session_${adminId}`
  const existing = sessions.get(sessionKey)
  if (existing?.sock) {
    try { existing.sock.end() } catch (_) {}
    try { existing.sock.ws?.close() } catch (_) {}
  }
  sessions.del(sessionKey)
  qrCache.del(sessionKey)
}

// ── Create/Get WA Session ─────────────────────────────────────
async function createSession(adminId) {
  const sessionKey  = `session_${adminId}`
  const authFolder  = `/tmp/wa_auth_${adminId}`

  // ✅ FIX 1: If auth folder missing but session cached → ghost session, clear it
  if (!fs.existsSync(authFolder) && sessions.has(sessionKey)) {
    console.log(`[${adminId}] Ghost session detected, clearing...`)
    killSession(adminId)
  }

  // Return existing live session
  if (sessions.has(sessionKey)) {
    const existing = sessions.get(sessionKey)
    if (existing?.isConnected) return { sessionKey, connected: true, phone: existing.phone }
    if (qrCache.has(sessionKey)) return { sessionKey, qr: qrCache.get(sessionKey) }
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder)
  const { version }          = await fetchLatestBaileysVersion()
  const msgRetryCounterCache = new NodeCache()

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    // ✅ FIX 2: Use standard browser string
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 30_000,
    msgRetryCounterCache,
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: jid => jid.includes('broadcast'),
    // ✅ FIX 3: Retry on connection failure
    retryRequestDelayMs: 2000,
    maxMsgRetryCount: 3,
  })

  sessions.set(sessionKey, { sock, isConnected: false, phone: null })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {

    if (qr) {
      try {
        const qrBase64 = await qrcode.toDataURL(qr)
        qrCache.set(sessionKey, qrBase64)
        console.log(`[${adminId}] QR generated`)
      } catch (err) {
        console.error(`[${adminId}] QR generation failed:`, err.message)
      }
    }

    if (connection === 'open') {
      const phone = sock.user?.id?.split(':')[0] || 'Unknown'
      sessions.set(sessionKey, { sock, isConnected: true, phone })
      qrCache.del(sessionKey)
      console.log(`[${adminId}] ✅ Connected: ${phone}`)
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log(`[${adminId}] ❌ Disconnected. Code: ${statusCode}`)

      sessions.set(sessionKey, { sock: null, isConnected: false, phone: null })

      if (statusCode === DisconnectReason.loggedOut) {
        console.log(`[${adminId}] Logged out — clearing auth`)
        clearAuth(adminId)
        sessions.del(sessionKey)
        qrCache.del(sessionKey)
      } else if (
        statusCode === DisconnectReason.connectionClosed ||
        statusCode === DisconnectReason.connectionLost ||
        statusCode === DisconnectReason.timedOut ||
        statusCode === 408 ||
        statusCode === 503
      ) {
        // ✅ FIX 4: Auto-reconnect on network issues
        console.log(`[${adminId}] Reconnecting in 5s...`)
        setTimeout(() => createSession(adminId), 5000)
      } else if (statusCode === DisconnectReason.badSession) {
        // ✅ FIX 5: Bad session → wipe auth and restart fresh
        console.log(`[${adminId}] Bad session — wiping auth and restarting`)
        clearAuth(adminId)
        sessions.del(sessionKey)
        qrCache.del(sessionKey)
        setTimeout(() => createSession(adminId), 3000)
      } else {
        console.log(`[${adminId}] Unknown disconnect code: ${statusCode}, reconnecting...`)
        setTimeout(() => createSession(adminId), 8000)
      }
    }
  })

  // Wait for QR to appear (up to 10s)
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000))
    if (qrCache.has(sessionKey)) break
    const s = sessions.get(sessionKey)
    if (s?.isConnected) return { sessionKey, connected: true, phone: s.phone }
  }

  if (qrCache.has(sessionKey)) {
    return { sessionKey, qr: qrCache.get(sessionKey) }
  }

  const s = sessions.get(sessionKey)
  if (s?.isConnected) return { sessionKey, connected: true, phone: s.phone }

  return { sessionKey, error: 'QR generate nahi hua — /reset karke dobara try karein' }
}

// ── ROUTES ────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({
    status:   'ok',
    message:  'Chhath Puja WA Server 🎉',
    sessions: sessions.keys().length,
    uptime:   `${Math.floor(process.uptime())}s`,
  })
})

// Get QR
app.get('/qr', async (req, res) => {
  const { adminId } = req.query
  if (!adminId) return res.status(400).json({ error: 'adminId required' })

  try {
    const result = await createSession(adminId)
    res.json(result)
  } catch (err) {
    console.error('[/qr error]', err)
    res.status(500).json({ error: err.message })
  }
})

// Status check
app.get('/status', (req, res) => {
  const { adminId, sessionKey } = req.query
  const key = adminId ? `session_${adminId}` : sessionKey

  if (!key) return res.status(400).json({ error: 'adminId or sessionKey required' })

  const session = sessions.get(key)
  if (!session) return res.json({ connected: false })

  res.json({ connected: session.isConnected, phone: session.phone || null })
})

// Send message
app.post('/send', async (req, res) => {
  const { sessionKey, adminId, to, message } = req.body
  const key = sessionKey || (adminId ? `session_${adminId}` : null)

  if (!key || !to || !message) {
    return res.status(400).json({ error: 'sessionKey/adminId, to, message required' })
  }

  const session = sessions.get(key)
  if (!session?.isConnected || !session.sock) {
    return res.status(400).json({ error: 'Session connected nahi hai — pehle QR scan karein' })
  }

  try {
    let phone = to.toString().replace(/[^0-9]/g, '')
    if (!phone.startsWith('91')) phone = '91' + phone
    const jid = `${phone}@s.whatsapp.net`

    await session.sock.sendMessage(jid, { text: message })
    res.json({ success: true, to: jid })
  } catch (err) {
    console.error('[/send error]', err)
    res.status(500).json({ error: err.message })
  }
})

// ✅ NEW: Reset session (fixes "Couldn't link device")
app.get('/reset', async (req, res) => {
  const { adminId } = req.query
  if (!adminId) return res.status(400).json({ error: 'adminId required' })

  try {
    killSession(adminId)
    clearAuth(adminId)
    res.json({ success: true, message: 'Reset ho gaya — ab /qr call karein' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Disconnect (logout)
app.get('/disconnect', async (req, res) => {
  const { adminId, sessionKey } = req.query
  const id  = adminId || sessionKey?.replace('session_', '')
  const key = adminId ? `session_${adminId}` : sessionKey

  const session = sessions.get(key)
  if (session?.sock) {
    try { await session.sock.logout() } catch (_) {}
  }

  killSession(id)
  clearAuth(id)

  res.json({ success: true })
})

// ── START ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ WA Server running on port ${PORT}`)
})