import express from 'express'
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import qrcode from 'qrcode'
import NodeCache from 'node-cache'
import pino from 'pino'

const app  = express()
const PORT = process.env.PORT || 3000

app.use(express.json())

// ── CORS ────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

// ── Session Store ────────────────────────────────────────────
// sessionKey → { sock, qr, isConnected, phone }
const sessions = new NodeCache({ stdTTL: 0 })
const qrCache  = new NodeCache({ stdTTL: 120 }) // QR 2 min expire

const logger = pino({ level: 'silent' })

// ── Create/Get WA Session ────────────────────────────────────
async function createSession(adminId) {
  const sessionKey = `session_${adminId}`

  // Agar session pehle se chal raha hai
  if (sessions.has(sessionKey)) {
    const existing = sessions.get(sessionKey)
    if (existing.isConnected) return { sessionKey, connected: true, phone: existing.phone }
    if (qrCache.has(sessionKey)) return { sessionKey, qr: qrCache.get(sessionKey) }
  }

  // Auth state — /tmp mein store (Render.com)
  const authFolder = `/tmp/wa_auth_${adminId}`
  const { state, saveCreds } = await useMultiFileAuthState(authFolder)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Chhath Puja Portal', 'Chrome', '1.0'],
    connectTimeoutMs: 60000,
  })

  sessions.set(sessionKey, { sock, isConnected: false, phone: null })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {

    if (qr) {
      // QR base64 image banao
      const qrBase64 = await qrcode.toDataURL(qr)
      qrCache.set(sessionKey, qrBase64)
      console.log(`[${adminId}] QR generated`)
    }

    if (connection === 'open') {
      const phone = sock.user?.id?.split(':')[0] || 'Unknown'
      sessions.set(sessionKey, { sock, isConnected: true, phone })
      qrCache.del(sessionKey)
      console.log(`[${adminId}] Connected: ${phone}`)
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      sessions.set(sessionKey, { sock: null, isConnected: false, phone: null })

      // Logout nahi hua to reconnect karo
      if (reason !== DisconnectReason.loggedOut) {
        console.log(`[${adminId}] Reconnecting...`)
        setTimeout(() => createSession(adminId), 5000)
      } else {
        console.log(`[${adminId}] Logged out`)
        sessions.del(sessionKey)
        qrCache.del(sessionKey)
      }
    }
  })

  // QR aane ka wait karo (5 sec)
  await new Promise(r => setTimeout(r, 5000))

  if (qrCache.has(sessionKey)) {
    return { sessionKey, qr: qrCache.get(sessionKey) }
  }

  const s = sessions.get(sessionKey)
  if (s?.isConnected) return { sessionKey, connected: true, phone: s.phone }

  return { sessionKey, error: 'QR generate nahi hua' }
}

// ── ROUTES ──────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Chhath Puja WA Server Running 🎉' })
})

// GET /qr?adminId=xxx — QR generate karo
app.get('/qr', async (req, res) => {
  const { adminId } = req.query
  if (!adminId) return res.status(400).json({ error: 'adminId required' })

  try {
    const result = await createSession(adminId)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /status?sessionKey=xxx — Connection status check
app.get('/status', (req, res) => {
  const { sessionKey } = req.query
  if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' })

  const session = sessions.get(sessionKey)
  if (!session) return res.json({ connected: false })

  res.json({
    connected: session.isConnected,
    phone: session.phone || null
  })
})

// POST /send — Message bhejo
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
    // Phone number format: 91XXXXXXXXXX@s.whatsapp.net
    let phone = to.toString().replace(/[^0-9]/g, '')
    if (!phone.startsWith('91')) phone = '91' + phone
    const jid = `${phone}@s.whatsapp.net`

    await session.sock.sendMessage(jid, { text: message })
    res.json({ success: true, to: jid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /disconnect?sessionKey=xxx — Logout
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

// ── START ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ WA Server running on port ${PORT}`)
})
