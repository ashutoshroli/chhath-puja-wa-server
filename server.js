import express from 'express'
import fs from 'fs'
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
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
const creating = new Set() // ✅ Race condition fix

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

// ── Core: Create WA Socket ────────────────────────────────────
async function createWASocket(adminId, usePairingCode = false, phoneNumber = null) {
  const sessionKey  = `session_${adminId}`
  const authFolder  = `/tmp/wa_auth_${adminId}`

  const { state, saveCreds } = await useMultiFileAuthState(authFolder)
  const { version, isLatest } = await fetchLatestBaileysVersion()
  console.log(`[${adminId}] WA v${version.join('.')}, isLatest: ${isLatest}`)

  const msgRetryCounterCache = new NodeCache()

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    // ✅ QR mode mein printQRInTerminal true, pairing mein false
    printQRInTerminal: !usePairingCode,
    browser: Browsers.ubuntu('Chrome'), // ✅ Fixed browser string
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 30_000,
    msgRetryCounterCache,
    generateHighQualityLinkPreview: false,
    shouldIgnoreJid: jid => jid.includes('broadcast'),
    retryRequestDelayMs: 2000,
    maxMsgRetryCount: 3,
    // ✅ Pairing code ke liye mobile: false zaroori hai
    mobile: false,
  })

  sessions.set(sessionKey, { sock, isConnected: false, phone: null, mode: usePairingCode ? 'pairing' : 'qr' })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr, isNewLogin }) => {

    // ✅ isNewLogin handle karo
    if (isNewLogin) {
      console.log(`[${adminId}] New login — saving creds`)
      await saveCreds()
    }

    // QR mode
    if (qr && !usePairingCode) {
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
      sessions.set(sessionKey, { sock, isConnected: true, phone, mode: usePairingCode ? 'pairing' : 'qr' })
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
        console.log(`[${adminId}] Network issue — reconnecting in 5s...`)
        setTimeout(() => createWASocket(adminId, usePairingCode, phoneNumber), 5000)
      } else if (statusCode === DisconnectReason.badSession) {
        console.log(`[${adminId}] Bad session — wiping auth and restarting`)
        clearAuth(adminId)
        sessions.del(sessionKey)
        qrCache.del(sessionKey)
        setTimeout(() => createWASocket(adminId, usePairingCode, phoneNumber), 3000)
      } else {
        console.log(`[${adminId}] Unknown disconnect (${statusCode}) — reconnecting in 8s`)
        setTimeout(() => createWASocket(adminId, usePairingCode, phoneNumber), 8000)
      }
    }
  })

  return sock
}

// ── Session: QR Mode ──────────────────────────────────────────
async function createSession(adminId) {
  const sessionKey = `session_${adminId}`

  // Race condition guard
  if (creating.has(adminId)) {
    await new Promise(r => setTimeout(r, 2000))
    return createSession(adminId)
  }
  creating.add(adminId)

  try {
    const authFolder = `/tmp/wa_auth_${adminId}`

    // Ghost session check
    if (!fs.existsSync(authFolder) && sessions.has(sessionKey)) {
      console.log(`[${adminId}] Ghost session detected, clearing...`)
      killSession(adminId)
    }

    // Already connected?
    if (sessions.has(sessionKey)) {
      const existing = sessions.get(sessionKey)
      if (existing?.isConnected) return { sessionKey, connected: true, phone: existing.phone }
      if (qrCache.has(sessionKey)) return { sessionKey, qr: qrCache.get(sessionKey) }
    }

    await createWASocket(adminId, false)

    // Wait for QR (up to 10s)
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 3000))
      if (qrCache.has(sessionKey)) break
      const s = sessions.get(sessionKey)
      if (s?.isConnected) return { sessionKey, connected: true, phone: s.phone }
    }

    if (qrCache.has(sessionKey)) return { sessionKey, qr: qrCache.get(sessionKey) }

    const s = sessions.get(sessionKey)
    if (s?.isConnected) return { sessionKey, connected: true, phone: s.phone }

    return { sessionKey, error: 'QR generate nahi hua — /reset karke dobara try karein' }

  } finally {
    creating.delete(adminId)
  }
}

// ── Session: Pairing Code Mode ────────────────────────────────
async function createPairingSession(adminId, phoneNumber) {
  const sessionKey = `session_${adminId}`

  // Race condition guard
  if (creating.has(adminId)) {
    await new Promise(r => setTimeout(r, 2000))
    return createPairingSession(adminId, phoneNumber)
  }
  creating.add(adminId)

  try {
    const authFolder = `/tmp/wa_auth_${adminId}`

    // Ghost session check
    if (!fs.existsSync(authFolder) && sessions.has(sessionKey)) {
      killSession(adminId)
    }

    // Already connected?
    if (sessions.has(sessionKey)) {
      const existing = sessions.get(sessionKey)
      if (existing?.isConnected) return { sessionKey, connected: true, phone: existing.phone }
      if (existing?.pairingCode) return { sessionKey, pairingCode: existing.pairingCode }
    }

    const sock = await createWASocket(adminId, true, phoneNumber)

    // ✅ Phone number format karo: sirf digits, country code ke saath
    let cleanPhone = phoneNumber.toString().replace(/[^0-9]/g, '')
    if (!cleanPhone.startsWith('91')) cleanPhone = '91' + cleanPhone

    // Pairing code request (socket open hone ke baad)
    let pairingCode = null

    // Wait for socket to be ready (up to 5s)
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 3000))
      try {
        pairingCode = await sock.requestPairingCode(cleanPhone)
        break
      } catch (err) {
        console.log(`[${adminId}] Pairing code attempt ${i + 1} failed: ${err.message}`)
        if (i === 4) throw new Error('Pairing code generate nahi hua — number check karein')
      }
    }

    // Format: XXXX-XXXX
    const formatted = pairingCode?.replace(/-/g, '').match(/.{1,4}/g)?.join('-') || pairingCode
    // Store in session
    const s = sessions.get(sessionKey) || {}
    sessions.set(sessionKey, { ...s, pairingCode: formatted })

    console.log(`[${adminId}] 📱 Pairing code: ${formatted}`)
    return { sessionKey, pairingCode: formatted }

  } finally {
    creating.delete(adminId)
  }
}

// ── ROUTES ────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({
    status:   'ok',
    message:  'WA Multi-Session Server 🚀',
    sessions: sessions.keys().length,
    uptime:   `${Math.floor(process.uptime())}s`,
  })
})

// ── QR Route ──────────────────────────────────────────────────
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

// ── Pairing Code Route ────────────────────────────────────────
// GET /pair?adminId=abc&phone=919876543210
app.get('/pair', async (req, res) => {
  const { adminId, phone } = req.query

  if (!adminId) return res.status(400).json({ error: 'adminId required' })
  if (!phone)   return res.status(400).json({ error: 'phone required (e.g. 919876543210)' })

  // Phone validate karo
  const cleanPhone = phone.toString().replace(/[^0-9]/g, '')
  if (cleanPhone.length < 10) {
    return res.status(400).json({ error: 'Valid phone number do (country code ke saath, e.g. 919876543210)' })
  }

  try {
    const result = await createPairingSession(adminId, cleanPhone)
    res.json(result)
  } catch (err) {
    console.error('[/pair error]', err)
    res.status(500).json({ error: err.message })
  }
})

// ── Status Route ──────────────────────────────────────────────
app.get('/status', (req, res) => {
  const { adminId, sessionKey } = req.query
  const key = adminId ? `session_${adminId}` : sessionKey

  if (!key) return res.status(400).json({ error: 'adminId or sessionKey required' })

  const session = sessions.get(key)
  if (!session) return res.json({ connected: false })

  res.json({
    connected: session.isConnected,
    phone:     session.phone || null,
    mode:      session.mode  || null,
  })
})

// ── Send Message Route ────────────────────────────────────────
app.post('/send', async (req, res) => {
  const { sessionKey, adminId, to, message } = req.body
  const key = sessionKey || (adminId ? `session_${adminId}` : null)

  if (!key || !to || !message) {
    return res.status(400).json({ error: 'sessionKey/adminId, to, message required' })
  }

  const session = sessions.get(key)
  if (!session?.isConnected || !session.sock) {
    return res.status(400).json({ error: 'Session connected nahi hai — pehle QR/Pairing se connect karein' })
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

// ── Reset Route ───────────────────────────────────────────────
app.get('/reset', async (req, res) => {
  const { adminId } = req.query
  if (!adminId) return res.status(400).json({ error: 'adminId required' })

  try {
    killSession(adminId)
    clearAuth(adminId)
    res.json({ success: true, message: 'Reset ho gaya — ab /qr ya /pair call karein' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Disconnect Route ──────────────────────────────────────────
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

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ WA Server running on port ${PORT}`)
  console.log(`📌 Endpoints:`)
  console.log(`   GET  /qr?adminId=xxx                     → QR code`)
  console.log(`   GET  /pair?adminId=xxx&phone=91xxxxxxxxxx → Pairing code`)
  console.log(`   GET  /status?adminId=xxx                  → Connection status`)
  console.log(`   POST /send  {adminId, to, message}        → Send message`)
  console.log(`   GET  /reset?adminId=xxx                   → Reset session`)
  console.log(`   GET  /disconnect?adminId=xxx              → Logout`)
})
