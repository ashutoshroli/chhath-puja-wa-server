import express from 'express'
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
const sessions = new NodeCache({ stdTTL: 0 })
const qrCache  = new NodeCache({ stdTTL: 120 })

// Silent logger — avoids pino private field issues on Render
const logger = pino({ level: 'silent' })

// ── Create/Get WA Session ─────────────────────────────────────
async function createSession(adminId) {
  const sessionKey = `session_${adminId}`

  if (sessions.has(sessionKey)) {
    const existing = sessions.get(sessionKey)
    if (existing.isConnected) return { sessionKey, connected: true, phone: existing.phone }
    if (qrCache.has(sessionKey)) return { sessionKey, qr: qrCache.get(sessionKey) }
  }

  const authFolder = `/tmp/wa_auth_${adminId}`
  const { state, saveCreds } = await useMultiFileAuthState(authFolder)
  const { version } = await fetchLatestBaileysVersion()

  // ✅ KEY FIX: use makeCacheableSignalKeyStore to avoid #context private field clash
  const msgRetryCounterCache = new NodeCache()

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    browser: ['Chhath Puja Portal', 'Chrome', '1.0'],
    connectTimeoutMs: 60_000,
    msgRetryCounterCache,
    // ✅ Disable features that trigger #context issues on Node 20
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: jid => jid.includes('broadcast'),
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
      console.log(`[${adminId}] Connected: ${phone}`)
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      sessions.set(sessionKey, { sock: null, isConnected: false, phone: null })

      if (statusCode !== DisconnectReason.loggedOut) {
        console.log(`[${adminId}] Reconnecting... (reason: ${statusCode})`)
        setTimeout(() => createSession(adminId), 5000)
      } else {
        console.log(`[${adminId}] Logged out`)
        sessions.del(sessionKey)
        qrCache.del(sessionKey)
      }
    }
  })

  // Wait for QR to appear
  await new Promise(r => setTimeout(r, 5000))

  if (qrCache.has(sessionKey)) {
    return { sessionKey, qr: qrCache.get(sessionKey) }
  }

  const s = sessions.get(sessionKey)
  if (s?.isConnected) return { sessionKey, connected: true, phone: s.phone }

  return { sessionKey, error: 'QR generate nahi hua — please retry /qr endpoint' }
}

// ── ROUTES ───────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Chhath Puja WA Server 🎉',
    sessions: sessions.keys().length,
    uptime: `${Math.floor(process.uptime())}s`,
  })
})

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

app.get('/status', (req, res) => {
  const { sessionKey } = req.query
  if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' })

  const session = sessions.get(sessionKey)
  if (!session) return res.json({ connected: false })

  res.json({ connected: session.isConnected, phone: session.phone || null })
})

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
    res.json({ success: true, to: jid })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

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