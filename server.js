import express from 'express'
import pkg from 'whatsapp-web.js'
const { Client, LocalAuth, LinkingMethod } = pkg
import qrcode from 'qrcode'
import NodeCache from 'node-cache'

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
const creating = new Set()

// ── Helper: kill existing client ──────────────────────────────
async function killSession(adminId) {
  const sessionKey = `session_${adminId}`
  const existing = sessions.get(sessionKey)
  if (existing?.client) {
    try { await existing.client.destroy() } catch (_) {}
  }
  sessions.del(sessionKey)
  qrCache.del(sessionKey)
}

// ── Core: Create WA Client ────────────────────────────────────
async function createWAClient(adminId, usePairingCode = false, phoneNumber = null) {
  const sessionKey = `session_${adminId}`

  const clientOptions = {
    authStrategy: new LocalAuth({ clientId: adminId, dataPath: '/tmp/wa_auth' }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
      ],
    },
  }

  // Pairing code mode
  if (usePairingCode && phoneNumber) {
    let cleanPhone = phoneNumber.toString().replace(/[^0-9]/g, '')
    if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone
    clientOptions.linkingMethod = new LinkingMethod({ phone: cleanPhone })
  }

  const client = new Client(clientOptions)

  sessions.set(sessionKey, { client, isConnected: false, phone: null, mode: usePairingCode ? 'pairing' : 'qr' })

  // QR event
  client.on('qr', async (qr) => {
    if (!usePairingCode) {
      try {
        const qrBase64 = await qrcode.toDataURL(qr)
        qrCache.set(sessionKey, qrBase64)
        console.log(`[${adminId}] QR generated`)
      } catch (err) {
        console.error(`[${adminId}] QR generation failed:`, err.message)
      }
    }
  })

  // Pairing code event
  client.on('code', (code) => {
    const formatted = code?.replace(/-/g, '').match(/.{1,4}/g)?.join('-') || code
    console.log(`[${adminId}] 📱 Pairing code: ${formatted}`)
    const s = sessions.get(sessionKey) || {}
    sessions.set(sessionKey, { ...s, pairingCode: formatted })
  })

  // Ready event
  client.on('ready', () => {
    const phone = client.info?.wid?.user || 'Unknown'
    sessions.set(sessionKey, { client, isConnected: true, phone, mode: usePairingCode ? 'pairing' : 'qr' })
    qrCache.del(sessionKey)
    console.log(`[${adminId}] ✅ Connected: ${phone}`)
  })

  // Auth failure
  client.on('auth_failure', (msg) => {
    console.error(`[${adminId}] ❌ Auth failed:`, msg)
    sessions.set(sessionKey, { client: null, isConnected: false, phone: null })
  })

  // Disconnected
  client.on('disconnected', async (reason) => {
    console.log(`[${adminId}] ❌ Disconnected: ${reason}`)
    sessions.set(sessionKey, { client: null, isConnected: false, phone: null })
    try { await client.destroy() } catch (_) {}

    if (reason === 'LOGOUT') {
      sessions.del(sessionKey)
      qrCache.del(sessionKey)
    } else {
      console.log(`[${adminId}] Reconnecting in 5s...`)
      setTimeout(() => createWAClient(adminId, usePairingCode, phoneNumber), 5000)
    }
  })

  await client.initialize()
  return client
}

// ── Session: QR Mode ──────────────────────────────────────────
async function createSession(adminId) {
  const sessionKey = `session_${adminId}`

  if (creating.has(adminId)) {
    await new Promise(r => setTimeout(r, 2000))
    return createSession(adminId)
  }
  creating.add(adminId)

  try {
    // Already connected?
    if (sessions.has(sessionKey)) {
      const existing = sessions.get(sessionKey)
      if (existing?.isConnected) return { sessionKey, connected: true, phone: existing.phone }
      if (qrCache.has(sessionKey)) return { sessionKey, qr: qrCache.get(sessionKey) }
    }

    await createWAClient(adminId, false)

    // Wait for QR (up to 30s)
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000))
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

  if (creating.has(adminId)) {
    await new Promise(r => setTimeout(r, 2000))
    return createPairingSession(adminId, phoneNumber)
  }
  creating.add(adminId)

  try {
    // Already connected?
    if (sessions.has(sessionKey)) {
      const existing = sessions.get(sessionKey)
      if (existing?.isConnected) return { sessionKey, connected: true, phone: existing.phone }
      if (existing?.pairingCode) return { sessionKey, pairingCode: existing.pairingCode }
    }

    await createWAClient(adminId, true, phoneNumber)

    // Wait for pairing code (up to 30s)
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000))
      const s = sessions.get(sessionKey)
      if (s?.pairingCode) return { sessionKey, pairingCode: s.pairingCode }
      if (s?.isConnected) return { sessionKey, connected: true, phone: s.phone }
    }

    return { sessionKey, error: 'Pairing code generate nahi hua — /reset karke dobara try karein' }

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
app.get('/pair', async (req, res) => {
  const { adminId, phone } = req.query

  if (!adminId) return res.status(400).json({ error: 'adminId required' })
  if (!phone)   return res.status(400).json({ error: 'phone required (e.g. 919876543210)' })

  const cleanPhone = phone.toString().replace(/[^0-9]/g, '')
  if (cleanPhone.length < 10) {
    return res.status(400).json({ error: 'Valid phone number do (e.g. 919876543210)' })
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
  if (!session?.isConnected || !session.client) {
    return res.status(400).json({ error: 'Session connected nahi hai — pehle QR/Pairing se connect karein' })
  }

  try {
    let phone = to.toString().replace(/[^0-9]/g, '')
    if (!phone.startsWith('91')) phone = '91' + phone
    const chatId = `${phone}@c.us`

    await session.client.sendMessage(chatId, message)
    res.json({ success: true, to: chatId })
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
    await killSession(adminId)
    res.json({ success: true, message: 'Reset ho gaya — ab /qr ya /pair call karein' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── Disconnect Route ──────────────────────────────────────────
app.get('/disconnect', async (req, res) => {
  const { adminId, sessionKey } = req.query
  const id = adminId || sessionKey?.replace('session_', '')

  const key = `session_${id}`
  const session = sessions.get(key)
  if (session?.client) {
    try { await session.client.logout() } catch (_) {}
  }

  await killSession(id)
  res.json({ success: true })
})

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ WA Server running on port ${PORT}`)
  console.log(`📌 Endpoints:`)
  console.log(`   GET  /qr?adminId=xxx                      → QR code`)
  console.log(`   GET  /pair?adminId=xxx&phone=91xxxxxxxxxx  → Pairing code`)
  console.log(`   GET  /status?adminId=xxx                   → Connection status`)
  console.log(`   POST /send  {adminId, to, message}         → Send message`)
  console.log(`   GET  /reset?adminId=xxx                    → Reset session`)
  console.log(`   GET  /disconnect?adminId=xxx               → Logout`)
})