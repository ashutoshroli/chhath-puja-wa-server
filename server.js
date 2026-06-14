import express from 'express'
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode'
import NodeCache from 'node-cache'
import pino from 'pino'
import { mkdirSync } from 'fs'

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
const sessions = new NodeCache({ stdTTL: 0 })
const qrCache  = new NodeCache({ stdTTL: 180 }) // QR 3 min valid
const logger   = pino({ level: 'silent' })

// ── Create WA Session ─────────────────────────────────────────
async function createSession(adminId) {
  const sessionKey = `session_${adminId}`

  // Check existing session
  if (sessions.has(sessionKey)) {
    const existing = sessions.get(sessionKey)
    if (existing?.isConnected) {
      return { sessionKey, connected: true, phone: existing.phone }
    }
  }

  // Check cached QR
  if (qrCache.has(sessionKey)) {
    return { sessionKey, qr: qrCache.get(sessionKey) }
  }

  // Create auth folder
  const authFolder = `/tmp/wa_${adminId}`
  try { mkdirSync(authFolder, { recursive: true }) } catch (_) {}

  const { state, saveCreds } = await useMultiFileAuthState(authFolder)
  const { version }          = await fetchLatestBaileysVersion()

  return new Promise((resolve) => {
    let resolved = false
    let timeoutId

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Chhath Puja', 'Chrome', '3.0'],
      connectTimeoutMs: 30000,
      defaultQueryTimeoutMs: 30000,
    })

    sessions.set(sessionKey, { sock, isConnected: false, phone: null })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {

      if (qr && !resolved) {
        try {
          const qrBase64 = await qrcode.toDataURL(qr)
          qrCache.set(sessionKey, qrBase64)
          sessions.set(sessionKey, { sock, isConnected: false, phone: null })
          clearTimeout(timeoutId)
          resolved = true
          resolve({ sessionKey, qr: qrBase64 })
        } catch (e) {
          console.error('QR error:', e.message)
        }
      }

      if (connection === 'open') {
        const phone = sock.user?.id?.split(':')[0] || 'Unknown'
        sessions.set(sessionKey, { sock, isConnected: true, phone })
        qrCache.del(sessionKey)
        console.log(`✅ Connected: ${adminId} → ${phone}`)
        if (!resolved) { resolved = true; resolve({ sessionKey, connected: true, phone }) }
      }

      if (connection === 'close') {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
        sessions.set(sessionKey, { sock: null, isConnected: false, phone: null })

        if (reason !== DisconnectReason.loggedOut) {
          console.log(`🔄 Reconnecting: ${adminId}`)
          setTimeout(() => createSession(adminId), 3000)
        } else {
          sessions.del(sessionKey)
          qrCache.del(sessionKey)
        }
      }
    })

    // Timeout 25 seconds — agar QR nahi aaya
    timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true
        // Check again if QR cached
        if (qrCache.has(sessionKey)) {
          resolve({ sessionKey, qr: qrCache.get(sessionKey) })
        } else {
          resolve({ sessionKey, error: 'QR timeout — dobara try karein' })
        }
      }
    }, 25000)
  })
}

// ── ROUTES ───────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Chhath Puja WA Server 🎉',
    sessions: sessions.keys().length,
    uptime: Math.floor(process.uptime()) + 's'
  })
})

// GET /qr?adminId=xxx
app.get('/qr', async (req, res) => {
  const { adminId } = req.query
  if (!adminId) return res.status(400).json({ error: 'adminId required' })

  try {
    console.log(`📱 QR request: ${adminId}`)
    const result = await createSession(adminId)
    res.json(result)
  } catch (err) {
    console.error('QR error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /status?sessionKey=xxx
app.get('/status', (req, res) => {
  const { sessionKey } = req.query
  if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' })

  const session = sessions.get(sessionKey)
  if (!session) return res.json({ connected: false })

  res.json({ connected: session.isConnected || false, phone: session.phone || null })
})

// POST /send
app.post('/send', async (req, res) => {
  const { sessionKey, to, message } = req.body
  if (!sessionKey || !to || !message) {
    return res.status(400).json({ error: 'sessionKey, to, message required' })
  }

  const session = sessions.get(sessionKey)
  if (!session?.isConnected || !session.sock) {
    return res.status(400).json({ error: 'Session connected nahi hai' })
  }

  try {
    let phone = to.toString().replace(/[^0-9]/g, '')
    if (!phone.startsWith('91')) phone = '91' + phone
    const jid = `${phone}@s.whatsapp.net`

    await session.sock.sendMessage(jid, { text: message })
    console.log(`✉️ Sent to ${jid}`)
    res.json({ success: true, to: jid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /disconnect?sessionKey=xxx
app.get('/disconnect', async (req, res) => {
  const { sessionKey } = req.query
  const session = sessions.get(sessionKey)
  if (session?.sock) {
    try { await session.sock.logout() } catch (_) {}
  }
  sessions.del(sessionKey)
  qrCache.del(sessionKey)
  res.json({ success: true })
})

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ WA Server running on port ${PORT}`)
})
