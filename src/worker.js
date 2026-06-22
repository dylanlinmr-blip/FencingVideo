import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'

const app = new Hono()

app.onError((err, c) => {
  console.error('Worker error', err)
  const path = new URL(c.req.url).pathname
  if (path.startsWith('/api') || path.startsWith('/uploads')) {
    return c.json({ error: 'Internal server error' }, 500)
  }
  return new Response('Internal Server Error', { status: 500 })
})

async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS bouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      weapon TEXT NOT NULL CHECK (weapon IN ('foil','sabre','epee')),
      left_name TEXT NOT NULL,
      right_name TEXT NOT NULL,
      video_filename TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      left_score INTEGER DEFAULT 0,
      right_score INTEGER DEFAULT 0,
      owner_key TEXT NOT NULL DEFAULT 'global'
    )`
  ).run()

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS touches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bout_id INTEGER NOT NULL,
      video_time_seconds REAL NOT NULL,
      scorer TEXT NOT NULL CHECK (scorer IN ('left','right','none')),
      row_verdict TEXT,
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bout_id) REFERENCES bouts(id) ON DELETE CASCADE
    )`
  ).run()

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS tip_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bout_id INTEGER NOT NULL,
      fencer TEXT NOT NULL CHECK (fencer IN ('left','right')),
      video_time_seconds REAL NOT NULL,
      x_norm REAL NOT NULL,
      y_norm REAL NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bout_id) REFERENCES bouts(id) ON DELETE CASCADE
    )`
  ).run()

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS fencers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      owner_key TEXT NOT NULL DEFAULT 'global',
      scoped_name TEXT UNIQUE,
      usafencing_member_id TEXT,
      usafencing_profile_url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`
  ).run()

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS usafencing_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fencer_id INTEGER NOT NULL,
      event_name TEXT NOT NULL,
      event_date TEXT,
      score_summary TEXT,
      source_url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (fencer_id) REFERENCES fencers(id) ON DELETE CASCADE
    )`
  ).run()

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS calendar_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      location TEXT,
      notes TEXT,
      owner_key TEXT NOT NULL DEFAULT 'global',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`
  ).run()

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`
  ).run()

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`
  ).run()

  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS bout_shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bout_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      target_user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bout_id) REFERENCES bouts(id) ON DELETE CASCADE,
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (bout_id, target_user_id)
    )`
  ).run()

  await ensureColumn(env, 'bouts', 'owner_key', "owner_key TEXT NOT NULL DEFAULT 'global'")
  await ensureColumn(env, 'fencers', 'owner_key', "owner_key TEXT NOT NULL DEFAULT 'global'")
  await ensureColumn(env, 'fencers', 'scoped_name', 'scoped_name TEXT')
  await ensureColumn(env, 'calendar_blocks', 'owner_key', "owner_key TEXT NOT NULL DEFAULT 'global'")

  await env.DB.prepare("UPDATE fencers SET scoped_name = owner_key || '::' || lower(name) WHERE scoped_name IS NULL OR scoped_name = ''").run()

  await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_fencers_scoped_name ON fencers(scoped_name)').run()
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_bouts_owner_created ON bouts(owner_key, created_at)').run()
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_fencers_owner_name ON fencers(owner_key, name)').run()
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_calendar_blocks_owner_start ON calendar_blocks(owner_key, start_time)').run()
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_touches_bout_time ON touches(bout_id, video_time_seconds)').run()
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tip_marks_bout_time ON tip_marks(bout_id, video_time_seconds)').run()
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_usafencing_results_fencer ON usafencing_results(fencer_id, event_date)').run()
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)').run()
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_sessions_user_expires ON sessions(user_id, expires_at)').run()
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_bout_shares_target ON bout_shares(target_user_id, bout_id)').run()
}

async function recalculateBoutScore(env, boutId) {
  const score = await env.DB.prepare(
    `SELECT
      COALESCE(SUM(CASE WHEN scorer = 'left' THEN 1 ELSE 0 END), 0) AS left_score,
      COALESCE(SUM(CASE WHEN scorer = 'right' THEN 1 ELSE 0 END), 0) AS right_score
    FROM touches
    WHERE bout_id = ?`
  )
    .bind(boutId)
    .first()

  await env.DB.prepare('UPDATE bouts SET left_score = ?, right_score = ? WHERE id = ?')
    .bind(score.left_score ?? 0, score.right_score ?? 0, boutId)
    .run()

  return {
    left_score: score.left_score ?? 0,
    right_score: score.right_score ?? 0,
  }
}

function validateVideoFileInfo(filename, contentType) {
  const allowedMime = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v'])
  const fileName = String(filename || '').toLowerCase()
  const mime = String(contentType || '').toLowerCase()
  const hasAllowedExtension = /\.(mp4|webm|mov|m4v)$/i.test(fileName)
  const hasAllowedMime = mime ? allowedMime.has(mime) : false

  if (!hasAllowedExtension && !hasAllowedMime) {
    return 'Invalid file type. Please upload MP4, WEBM, MOV, or M4V.'
  }

  return null
}

async function ensureColumn(env, table, columnName, columnDefinition) {
  const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all()
  const exists = (info.results || []).some((column) => column.name === columnName)
  if (!exists) {
    await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition}`).run()
  }
}

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(String(input))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase()
}

async function hashPassword(password) {
  const salt = crypto.randomUUID().replace(/-/g, '')
  const hash = await sha256Hex(`${salt}:${String(password)}`)
  return `${salt}:${hash}`
}

async function verifyPassword(password, storedHash) {
  const [salt, expectedHash] = String(storedHash || '').split(':')
  if (!salt || !expectedHash) return false
  const actualHash = await sha256Hex(`${salt}:${String(password)}`)
  return actualHash === expectedHash
}

function makeSessionToken() {
  return `${crypto.randomUUID()}${crypto.randomUUID().replace(/-/g, '')}`
}

async function getAuthContext(c) {
  const fromHeader =
    c.req.header('x-user-id') ||
    c.req.header('x-genspark-user-id') ||
    c.req.header('x-auth-request-user') ||
    c.req.header('cf-access-authenticated-user-email')

  if (fromHeader) {
    return {
      ownerKey: String(fromHeader).trim().toLowerCase(),
      user: null,
    }
  }

  const sessionToken = getCookie(c, 'fv_session')
  if (sessionToken) {
    const session = await c.env.DB.prepare(
      `SELECT s.id, s.user_id, u.email
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND datetime(s.expires_at) > datetime('now')
       LIMIT 1`
    )
      .bind(String(sessionToken))
      .first()

    if (session) {
      return {
        ownerKey: `user:${session.user_id}`,
        user: {
          id: session.user_id,
          email: session.email,
        },
        sessionToken: String(sessionToken),
      }
    }
  }

  let cookieValue = getCookie(c, 'fv_owner_key')
  if (!cookieValue) {
    cookieValue = crypto.randomUUID()
    setCookie(c, 'fv_owner_key', cookieValue, {
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: true,
      maxAge: 60 * 60 * 24 * 365,
    })
  }

  return {
    ownerKey: String(cookieValue).trim().toLowerCase(),
    user: null,
  }
}

async function upsertFencer(env, ownerKey, rawName) {
  const name = String(rawName || '').trim()
  if (!name) return null

  const scopedName = `${ownerKey}::${name.toLowerCase()}`
  await env.DB.prepare('INSERT INTO fencers (name, owner_key, scoped_name) VALUES (?, ?, ?) ON CONFLICT(scoped_name) DO NOTHING')
    .bind(name, ownerKey, scopedName)
    .run()
  return env.DB.prepare('SELECT * FROM fencers WHERE scoped_name = ?').bind(scopedName).first()
}

function stripHtml(input) {
  return String(input || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseUsaFencingEvents(html, scope) {
  const events = []
  const lines = String(html || '').split(/\n+/).map((line) => stripHtml(line)).filter(Boolean)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = line.match(/([A-Za-z]{3}\s\d{1,2},\s\d{4})\s*-\s*([A-Za-z]{3}\s\d{1,2},\s\d{4})\s*\|\s*([^|]+)\|\s*(.+)/)
    if (!match) continue

    const title = lines[index - 1] && lines[index - 1].length < 110 ? lines[index - 1] : `${scope} Event`
    events.push({
      title,
      start_date: match[1],
      end_date: match[2],
      location: match[3].trim(),
      categories: match[4].trim(),
      source: scope,
    })
  }

  return events.slice(0, 40)
}

function parseUsaFencingResults(html, sourceUrl) {
  const rows = [...String(html || '').matchAll(/<tr[\s\S]*?<\/tr>/gi)]
  const results = []

  for (const rowMatch of rows) {
    const cells = [...rowMatch[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => stripHtml(m[1]))
    if (cells.length < 3) continue

    const eventDate = cells[0]
    const eventName = cells[1]
    const scoreSummary = cells.slice(2).join(' • ')

    if (!eventName || !scoreSummary) continue
    results.push({ event_name: eventName, event_date: eventDate, score_summary: scoreSummary, source_url: sourceUrl })
  }

  return results.slice(0, 20)
}

function classifyRowVerdict(verdict) {
  const text = String(verdict || '').toUpperCase()
  if (!text) return 'Unknown'
  if (text.includes('PARRY-RIPOSTE')) return 'Parry-Riposte'
  if (text.includes('REMISE')) return 'Remise'
  if (text.includes('INITIAL ATTACK')) return 'Initial Attack'
  if (text.includes('ATTACK AFTER FAIL')) return 'Attack After Fail'
  if (text.includes('EPEE TOUCH')) return 'Epee Touch'
  if (text.includes('SIMULTANEOUS')) return 'Simultaneous'
  return 'Other'
}

function buildScoutingRecommendations(report) {
  const recommendations = []
  const styleSignals = []

  if (report.win_rate >= 0.65 && report.total_bouts >= 4) {
    styleSignals.push('High-confidence closer in full bouts')
  }

  const attackShare = report.row_style_breakdown.find((item) => item.style === 'Initial Attack')?.share || 0
  const riposteShare = report.row_style_breakdown.find((item) => item.style === 'Parry-Riposte')?.share || 0

  if (attackShare >= 0.35) {
    recommendations.push('Disrupt distance early and force second-intention actions; this fencer scores often off initial attacks.')
  }

  if (riposteShare >= 0.25) {
    recommendations.push('Avoid telegraphed attacks. Use feints and tempo breaks to draw the parry before finishing.')
  }

  if (report.opening_touch_rate >= 0.6) {
    recommendations.push('Start each period with extra discipline—this fencer frequently takes the first touch.')
  } else if (report.opening_touch_rate <= 0.35 && report.total_bouts > 0) {
    recommendations.push('Apply controlled early pressure; they are less likely to secure the opening touch.')
  }

  if (report.average_scored_per_bout > report.average_conceded_per_bout) {
    recommendations.push('Primary threat is sustained scoring volume. Force low-scoring exchanges and stop momentum chains.')
  } else {
    recommendations.push('Defensive opportunities exist—build actions that finish cleanly after preparation.')
  }

  if (report.tempo_seconds_per_scoring_touch && report.tempo_seconds_per_scoring_touch < 18) {
    recommendations.push('Slow the rhythm between halts. Rapid restart tempo appears to favor this fencer.')
  }

  if (recommendations.length === 0) {
    recommendations.push('Limited data available. Fence fundamentally: control distance, vary preparation, and avoid predictable timing.')
  }

  return {
    style_signals: styleSignals,
    recommendations: recommendations.slice(0, 6),
  }
}

async function buildFencerScoutingReport(env, ownerKey, fencerName) {
  const name = String(fencerName || '').trim()
  if (!name) return null

  const boutsRes = await env.DB.prepare(
    `SELECT id, title, weapon, left_name, right_name, left_score, right_score, created_at
     FROM bouts
     WHERE owner_key = ? AND (left_name = ? OR right_name = ?)
     ORDER BY datetime(created_at) DESC, id DESC`
  )
    .bind(ownerKey, name, name)
    .all()

  const bouts = boutsRes.results || []
  if (bouts.length === 0) {
    return {
      fencer_name: name,
      total_bouts: 0,
      total_touches_scored: 0,
      total_touches_conceded: 0,
      win_rate: 0,
      opening_touch_rate: 0,
      average_scored_per_bout: 0,
      average_conceded_per_bout: 0,
      tempo_seconds_per_scoring_touch: null,
      weapon_breakdown: [],
      row_style_breakdown: [],
      opponent_breakdown: [],
      ai_summary: 'No bout data yet for this fencer.',
      how_to_fence_them: ['Record at least one analyzed bout with touches to generate scouting recommendations.'],
      confidence: 'low',
    }
  }

  let wins = 0
  let losses = 0
  let draws = 0
  let openingTouchesWon = 0
  let scoringTouches = 0
  let concededTouches = 0
  let scoringTempoTotal = 0
  let scoringTempoCount = 0

  const rowStyleCounts = new Map()
  const weaponStats = new Map()
  const opponentStats = new Map()

  for (const bout of bouts) {
    const isLeft = bout.left_name === name
    const ownScore = Number(isLeft ? bout.left_score : bout.right_score) || 0
    const oppScore = Number(isLeft ? bout.right_score : bout.left_score) || 0
    const opponent = isLeft ? bout.right_name : bout.left_name

    if (ownScore > oppScore) wins += 1
    else if (ownScore < oppScore) losses += 1
    else draws += 1

    const weaponEntry = weaponStats.get(bout.weapon) || { weapon: bout.weapon, bouts: 0, wins: 0, losses: 0, draws: 0 }
    weaponEntry.bouts += 1
    if (ownScore > oppScore) weaponEntry.wins += 1
    else if (ownScore < oppScore) weaponEntry.losses += 1
    else weaponEntry.draws += 1
    weaponStats.set(bout.weapon, weaponEntry)

    const opponentEntry = opponentStats.get(opponent) || { opponent, bouts: 0, wins: 0, losses: 0, draws: 0 }
    opponentEntry.bouts += 1
    if (ownScore > oppScore) opponentEntry.wins += 1
    else if (ownScore < oppScore) opponentEntry.losses += 1
    else opponentEntry.draws += 1
    opponentStats.set(opponent, opponentEntry)

    const touchesRes = await env.DB.prepare(
      'SELECT scorer, row_verdict, video_time_seconds FROM touches WHERE bout_id = ? ORDER BY video_time_seconds ASC, id ASC'
    )
      .bind(bout.id)
      .all()

    let firstScoringTouchSeen = false
    let firstOwnScoringTime = null

    for (const touch of touchesRes.results || []) {
      const scorer = touch.scorer
      const isOwnTouch = (isLeft && scorer === 'left') || (!isLeft && scorer === 'right')
      const isOppTouch = (isLeft && scorer === 'right') || (!isLeft && scorer === 'left')

      if (!firstScoringTouchSeen && (isOwnTouch || isOppTouch)) {
        firstScoringTouchSeen = true
        if (isOwnTouch) openingTouchesWon += 1
      }

      if (isOwnTouch) {
        scoringTouches += 1
        const style = classifyRowVerdict(touch.row_verdict)
        rowStyleCounts.set(style, (rowStyleCounts.get(style) || 0) + 1)

        const touchTime = Number(touch.video_time_seconds)
        if (Number.isFinite(touchTime)) {
          if (firstOwnScoringTime != null) {
            scoringTempoTotal += Math.max(0, touchTime - firstOwnScoringTime)
            scoringTempoCount += 1
          }
          firstOwnScoringTime = touchTime
        }
      }

      if (isOppTouch) {
        concededTouches += 1
      }
    }
  }

  const totalBouts = bouts.length
  const rowStyleBreakdown = [...rowStyleCounts.entries()]
    .map(([style, count]) => ({ style, count, share: scoringTouches ? Number((count / scoringTouches).toFixed(3)) : 0 }))
    .sort((a, b) => b.count - a.count)

  const winRate = totalBouts ? wins / totalBouts : 0
  const openingTouchRate = totalBouts ? openingTouchesWon / totalBouts : 0
  const report = {
    fencer_name: name,
    total_bouts: totalBouts,
    wins,
    losses,
    draws,
    win_rate: Number(winRate.toFixed(3)),
    total_touches_scored: scoringTouches,
    total_touches_conceded: concededTouches,
    opening_touch_rate: Number(openingTouchRate.toFixed(3)),
    average_scored_per_bout: Number((scoringTouches / totalBouts).toFixed(2)),
    average_conceded_per_bout: Number((concededTouches / totalBouts).toFixed(2)),
    tempo_seconds_per_scoring_touch: scoringTempoCount ? Number((scoringTempoTotal / scoringTempoCount).toFixed(2)) : null,
    weapon_breakdown: [...weaponStats.values()].sort((a, b) => b.bouts - a.bouts),
    row_style_breakdown: rowStyleBreakdown,
    opponent_breakdown: [...opponentStats.values()].sort((a, b) => b.bouts - a.bouts).slice(0, 10),
    confidence: scoringTouches >= 20 || totalBouts >= 5 ? 'medium' : 'low',
  }

  const insights = buildScoutingRecommendations(report)
  report.ai_summary = `${name} has a ${Math.round(report.win_rate * 100)}% win rate across ${report.total_bouts} bout(s), averaging ${report.average_scored_per_bout} scored vs ${report.average_conceded_per_bout} conceded touches.`
  report.style_signals = insights.style_signals
  report.how_to_fence_them = insights.recommendations

  return report
}

async function getAccessibleBout(env, boutId, ownerKey, userId) {
  return env.DB.prepare(
    `SELECT b.*,
            CASE WHEN b.owner_key = ? THEN 1 ELSE 0 END AS can_edit,
            CASE WHEN b.owner_key = ? THEN 'owned' ELSE 'shared' END AS access_type,
            owner_user.email AS owner_email
     FROM bouts b
     LEFT JOIN bout_shares bs ON bs.bout_id = b.id AND bs.target_user_id = ?
     LEFT JOIN users owner_user ON owner_user.id = bs.owner_user_id
     WHERE b.id = ? AND (b.owner_key = ? OR bs.id IS NOT NULL)
     LIMIT 1`
  )
    .bind(ownerKey, ownerKey, Number(userId) || -1, boutId, ownerKey)
    .first()
}

app.get('/api/health', (c) => c.json({ ok: true }))

app.get('/api/auth/me', async (c) => {
  await ensureSchema(c.env)
  const { user } = await getAuthContext(c)
  return c.json({
    user: user ? { id: user.id, email: user.email } : null,
  })
})

app.post('/api/auth/signup', async (c) => {
  await ensureSchema(c.env)
  const { email, password } = await c.req.json()
  const normalizedEmail = normalizeEmail(email)

  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    return c.json({ error: 'Valid email is required' }, 400)
  }

  if (!password || String(password).length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400)
  }

  const passwordHash = await hashPassword(password)

  try {
    await c.env.DB.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)')
      .bind(normalizedEmail, passwordHash)
      .run()
  } catch {
    return c.json({ error: 'An account with this email already exists' }, 409)
  }

  const user = await c.env.DB.prepare('SELECT id, email FROM users WHERE email = ?').bind(normalizedEmail).first()
  const token = makeSessionToken()
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()

  await c.env.DB.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)')
    .bind(user.id, token, expiresAt)
    .run()

  setCookie(c, 'fv_session', token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: true,
    maxAge: 60 * 60 * 24 * 30,
  })

  return c.json({ user: { id: user.id, email: user.email } }, 201)
})

app.post('/api/auth/login', async (c) => {
  await ensureSchema(c.env)
  const { email, password } = await c.req.json()
  const normalizedEmail = normalizeEmail(email)

  if (!normalizedEmail || !password) {
    return c.json({ error: 'Email and password are required' }, 400)
  }

  const user = await c.env.DB.prepare('SELECT id, email, password_hash FROM users WHERE email = ?')
    .bind(normalizedEmail)
    .first()

  if (!user) return c.json({ error: 'Invalid email or password' }, 401)

  const valid = await verifyPassword(password, user.password_hash)
  if (!valid) return c.json({ error: 'Invalid email or password' }, 401)

  const token = makeSessionToken()
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  await c.env.DB.prepare('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)')
    .bind(user.id, token, expiresAt)
    .run()

  setCookie(c, 'fv_session', token, {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: true,
    maxAge: 60 * 60 * 24 * 30,
  })

  return c.json({ user: { id: user.id, email: user.email } })
})

app.post('/api/auth/logout', async (c) => {
  await ensureSchema(c.env)
  const token = getCookie(c, 'fv_session')
  if (token) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(String(token)).run()
  }

  setCookie(c, 'fv_session', '', {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: true,
    maxAge: 0,
  })

  return c.json({ success: true })
})

app.get('/api/bouts', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)
  const userId = user?.id || -1

  const { results } = await c.env.DB.prepare(
    `SELECT b.*, 
            CASE WHEN b.owner_key = ? THEN 1 ELSE 0 END AS can_edit,
            CASE WHEN b.owner_key = ? THEN 'owned' ELSE 'shared' END AS access_type,
            owner_user.email AS shared_by_email
     FROM bouts b
     LEFT JOIN bout_shares bs ON bs.bout_id = b.id AND bs.target_user_id = ?
     LEFT JOIN users owner_user ON owner_user.id = bs.owner_user_id
     WHERE b.owner_key = ? OR bs.id IS NOT NULL
     ORDER BY datetime(b.created_at) DESC, b.id DESC`
  )
    .bind(ownerKey, ownerKey, userId, ownerKey)
    .all()

  return c.json(results.map((b) => ({ ...b, video_url: `/uploads/${b.video_filename}` })))
})

async function getFencerSummaries(env, ownerKey) {
  const boutsRes = await env.DB.prepare(
    'SELECT id, title, weapon, left_name, right_name, left_score, right_score, created_at FROM bouts WHERE owner_key = ? ORDER BY datetime(created_at) DESC, id DESC'
  )
    .bind(ownerKey)
    .all()
  const linksRes = await env.DB.prepare('SELECT * FROM fencers WHERE owner_key = ?').bind(ownerKey).all()
  const usaRes = await env.DB.prepare(
    `SELECT f.name, r.id, r.event_name, r.event_date, r.score_summary, r.source_url, r.created_at
     FROM usafencing_results r
     JOIN fencers f ON f.id = r.fencer_id
     WHERE f.owner_key = ?
     ORDER BY datetime(r.created_at) DESC, r.id DESC`
  )
    .bind(ownerKey)
    .all()

  const linksByName = new Map((linksRes.results || []).map((row) => [row.name, row]))
  const resultsByName = new Map()
  for (const row of usaRes.results || []) {
    if (!resultsByName.has(row.name)) resultsByName.set(row.name, [])
    resultsByName.get(row.name).push({
      id: row.id,
      event_name: row.event_name,
      event_date: row.event_date,
      score_summary: row.score_summary,
      source_url: row.source_url,
      created_at: row.created_at,
    })
  }

  const grouped = new Map()
  const ensureGroupedEntry = (name) => {
    if (!name) return null
    if (!grouped.has(name)) {
      const link = linksByName.get(name)
      grouped.set(name, {
        name,
        bout_count: 0,
        last_bout_at: null,
        usafencing_member_id: link?.usafencing_member_id || null,
        usafencing_profile_url: link?.usafencing_profile_url || null,
        bouts: [],
        usafencing_recent_results: resultsByName.get(name)?.slice(0, 8) || [],
      })
    }
    return grouped.get(name)
  }

  for (const linkedName of linksByName.keys()) {
    ensureGroupedEntry(linkedName)
  }

  for (const bout of boutsRes.results || []) {
    for (const side of ['left_name', 'right_name']) {
      const entry = ensureGroupedEntry(bout[side])
      if (!entry) continue
      entry.bout_count += 1
      if (!entry.last_bout_at || new Date(bout.created_at) > new Date(entry.last_bout_at)) {
        entry.last_bout_at = bout.created_at
      }
      entry.bouts.push({
        id: bout.id,
        title: bout.title,
        weapon: bout.weapon,
        created_at: bout.created_at,
        left_name: bout.left_name,
        right_name: bout.right_name,
        left_score: bout.left_score,
        right_score: bout.right_score,
      })
    }
  }

  return [...grouped.values()].sort((a, b) => {
    if (b.bout_count !== a.bout_count) return b.bout_count - a.bout_count
    return a.name.localeCompare(b.name)
  })
}

app.get('/api/fencers', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)
  return c.json(await getFencerSummaries(c.env, ownerKey))
})

app.get('/api/fencers/:name', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)
  const name = decodeURIComponent(c.req.param('name'))
  const fencers = await getFencerSummaries(c.env, ownerKey)
  const fencer = fencers.find((entry) => entry.name === name)
  if (!fencer) return c.json({ error: 'Fencer not found' }, 404)
  return c.json(fencer)
})

app.get('/api/fencers/:name/scouting-report', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)
  const name = decodeURIComponent(c.req.param('name'))
  const report = await buildFencerScoutingReport(c.env, ownerKey, name)
  if (!report) return c.json({ error: 'Fencer not found' }, 404)
  return c.json(report)
})

app.post('/api/fencers/:name/usafencing-link', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)
  const name = decodeURIComponent(c.req.param('name'))
  const { member_id, profile_url } = await c.req.json()

  if (!name) return c.json({ error: 'Fencer name is required' }, 400)

  const fencer = await upsertFencer(c.env, ownerKey, name)
  await c.env.DB.prepare('UPDATE fencers SET usafencing_member_id = ?, usafencing_profile_url = ? WHERE id = ?')
    .bind(member_id ? String(member_id) : null, profile_url ? String(profile_url) : null, fencer.id)
    .run()

  const updated = await c.env.DB.prepare('SELECT * FROM fencers WHERE id = ?').bind(fencer.id).first()
  return c.json(updated)
})

app.post('/api/fencers/:name/usafencing-sync', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)
  const name = decodeURIComponent(c.req.param('name'))

  const scopedName = `${ownerKey}::${String(name).trim().toLowerCase()}`
  const fencer = await c.env.DB.prepare('SELECT * FROM fencers WHERE scoped_name = ?').bind(scopedName).first()
  if (!fencer) return c.json({ error: 'Fencer not found' }, 404)
  if (!fencer.usafencing_profile_url) {
    return c.json({ error: 'Link a USA Fencing profile URL first.' }, 400)
  }

  const response = await fetch(fencer.usafencing_profile_url)
  if (!response.ok) {
    return c.json({ error: `Failed to fetch USA Fencing profile (${response.status})` }, 502)
  }

  const html = await response.text()
  const parsed = parseUsaFencingResults(html, fencer.usafencing_profile_url)
  if (parsed.length === 0) {
    return c.json({
      synced: 0,
      note: 'No recent results could be auto-detected from this profile page. You may need to use a profile URL with a public results table.',
    })
  }

  await c.env.DB.prepare('DELETE FROM usafencing_results WHERE fencer_id = ?').bind(fencer.id).run()
  const stmt = c.env.DB.prepare(
    'INSERT INTO usafencing_results (fencer_id, event_name, event_date, score_summary, source_url) VALUES (?, ?, ?, ?, ?)'
  )
  await c.env.DB.batch(parsed.map((item) => stmt.bind(fencer.id, item.event_name, item.event_date, item.score_summary, item.source_url)))

  return c.json({ synced: parsed.length, results: parsed })
})

app.get('/api/calendar/blocks', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)
  const { results } = await c.env.DB.prepare('SELECT * FROM calendar_blocks WHERE owner_key = ? ORDER BY datetime(start_time) ASC, id ASC')
    .bind(ownerKey)
    .all()
  return c.json(results)
})

app.post('/api/calendar/blocks', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)
  const { title, start_time, end_time, location, notes } = await c.req.json()

  if (!title || !start_time || !end_time) {
    return c.json({ error: 'title, start_time, and end_time are required' }, 400)
  }

  const result = await c.env.DB.prepare(
    'INSERT INTO calendar_blocks (title, start_time, end_time, location, notes, owner_key) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(String(title), String(start_time), String(end_time), location ? String(location) : null, notes ? String(notes) : null, ownerKey)
    .run()

  const created = await c.env.DB.prepare('SELECT * FROM calendar_blocks WHERE id = ?').bind(result.meta.last_row_id).first()
  return c.json(created, 201)
})

app.delete('/api/calendar/blocks/:id', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare('DELETE FROM calendar_blocks WHERE id = ? AND owner_key = ?').bind(id, ownerKey).run()
  return c.json({ success: true })
})

app.get('/api/usafencing/events', async (c) => {
  const scope = c.req.query('scope') || 'both'
  const urls = []
  if (scope === 'national' || scope === 'both') urls.push({ scope: 'national', url: 'https://www.usafencing.org/events-national' })
  if (scope === 'regional' || scope === 'both') urls.push({ scope: 'regional', url: 'https://www.usafencing.org/regional-calendar' })

  const events = []
  for (const item of urls) {
    const response = await fetch(item.url)
    if (!response.ok) continue
    const html = await response.text()
    events.push(...parseUsaFencingEvents(html, item.scope))
  }

  return c.json({ events, source_note: 'Best-effort parser from public USA Fencing pages; verify details before registering.' })
})

app.post('/api/bouts', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)
  const form = await c.req.formData()
  const file = form.get('video')
  const title = form.get('title')
  const weapon = form.get('weapon')
  const left_name = form.get('left_name')
  const right_name = form.get('right_name')

  if (!(file instanceof File) || !title || !weapon || !left_name || !right_name) {
    return c.json({ error: 'Missing required fields' }, 400)
  }

  const fileError = validateVideoFileInfo(file.name, file.type)
  if (fileError) {
    return c.json({ error: fileError }, 400)
  }

  const safeName = file.name.replace(/\s+/g, '-')
  const videoFilename = `${Date.now()}-${crypto.randomUUID()}-${safeName}`
  await c.env.VIDEOS.put(videoFilename, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  })

  const result = await c.env.DB.prepare(
    'INSERT INTO bouts (title, weapon, left_name, right_name, video_filename, owner_key) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(String(title), String(weapon), String(left_name), String(right_name), videoFilename, ownerKey)
    .run()

  await upsertFencer(c.env, ownerKey, left_name)
  await upsertFencer(c.env, ownerKey, right_name)

  const bout = await c.env.DB.prepare('SELECT * FROM bouts WHERE id = ?').bind(result.meta.last_row_id).first()
  return c.json({ ...bout, video_url: `/uploads/${bout.video_filename}` }, 201)
})

app.post('/api/uploads/init', async (c) => {
  await ensureSchema(c.env)
  await getAuthContext(c)

  const { filename, contentType } = await c.req.json()
  if (!filename) {
    return c.json({ error: 'filename is required' }, 400)
  }

  const fileError = validateVideoFileInfo(filename, contentType)
  if (fileError) {
    return c.json({ error: fileError }, 400)
  }

  const safeName = String(filename).replace(/\s+/g, '-')
  const key = `${Date.now()}-${crypto.randomUUID()}-${safeName}`

  const upload = await c.env.VIDEOS.createMultipartUpload(key, {
    httpMetadata: { contentType: String(contentType || 'application/octet-stream') },
  })

  return c.json({ key, uploadId: upload.uploadId })
})

app.put('/api/uploads/part', async (c) => {
  const key = c.req.query('key')
  const uploadId = c.req.query('uploadId')
  const partNumber = Number(c.req.query('partNumber'))

  if (!key || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return c.json({ error: 'key, uploadId, and valid partNumber are required' }, 400)
  }

  const chunk = await c.req.arrayBuffer()
  const maxPartBytes = 25 * 1024 * 1024
  if (!chunk || chunk.byteLength === 0 || chunk.byteLength > maxPartBytes) {
    return c.json({ error: 'Part must be between 1 byte and 25MB' }, 400)
  }

  const upload = c.env.VIDEOS.resumeMultipartUpload(key, uploadId)
  const uploadedPart = await upload.uploadPart(partNumber, chunk)

  return c.json({ partNumber: uploadedPart.partNumber, etag: uploadedPart.etag })
})

app.post('/api/uploads/complete', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)

  const { key, uploadId, parts, title, weapon, left_name, right_name } = await c.req.json()

  if (!key || !uploadId || !title || !weapon || !left_name || !right_name) {
    return c.json({ error: 'Missing required fields' }, 400)
  }

  if (!Array.isArray(parts) || parts.length === 0) {
    return c.json({ error: 'parts array is required' }, 400)
  }

  const normalizedParts = parts
    .map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag || '') }))
    .filter((p) => Number.isInteger(p.partNumber) && p.partNumber > 0 && p.etag)
    .sort((a, b) => a.partNumber - b.partNumber)

  if (normalizedParts.length !== parts.length) {
    return c.json({ error: 'Invalid parts payload' }, 400)
  }

  const upload = c.env.VIDEOS.resumeMultipartUpload(String(key), String(uploadId))
  await upload.complete(normalizedParts)

  const result = await c.env.DB.prepare(
    'INSERT INTO bouts (title, weapon, left_name, right_name, video_filename, owner_key) VALUES (?, ?, ?, ?, ?, ?)'
  )
    .bind(String(title), String(weapon), String(left_name), String(right_name), String(key), ownerKey)
    .run()

  await upsertFencer(c.env, ownerKey, left_name)
  await upsertFencer(c.env, ownerKey, right_name)

  const bout = await c.env.DB.prepare('SELECT * FROM bouts WHERE id = ?').bind(result.meta.last_row_id).first()
  return c.json({ ...bout, video_url: `/uploads/${bout.video_filename}` }, 201)
})

app.post('/api/uploads/abort', async (c) => {
  const { key, uploadId } = await c.req.json()
  if (!key || !uploadId) {
    return c.json({ error: 'key and uploadId are required' }, 400)
  }

  const upload = c.env.VIDEOS.resumeMultipartUpload(String(key), String(uploadId))
  await upload.abort()
  return c.json({ success: true })
})

app.get('/api/bouts/:id', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)
  const id = Number(c.req.param('id'))

  const bout = await getAccessibleBout(c.env, id, ownerKey, user?.id)
  if (!bout) return c.json({ error: 'Bout not found' }, 404)

  const touches = await c.env.DB.prepare(
    'SELECT * FROM touches WHERE bout_id = ? ORDER BY video_time_seconds ASC, id ASC'
  )
    .bind(id)
    .all()

  const tipMarks = await c.env.DB.prepare(
    'SELECT * FROM tip_marks WHERE bout_id = ? ORDER BY video_time_seconds ASC, id ASC'
  )
    .bind(id)
    .all()

  return c.json({
    ...bout,
    video_url: `/uploads/${bout.video_filename}`,
    touches: touches.results,
    tip_marks: tipMarks.results,
  })
})

app.delete('/api/bouts/:id', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey } = await getAuthContext(c)
  const id = Number(c.req.param('id'))

  const bout = await c.env.DB.prepare('SELECT * FROM bouts WHERE id = ? AND owner_key = ?').bind(id, ownerKey).first()
  if (!bout) return c.json({ error: 'Bout not found' }, 404)

  await c.env.DB.prepare('DELETE FROM bouts WHERE id = ?').bind(id).run()
  await c.env.VIDEOS.delete(bout.video_filename)

  return c.json({ success: true })
})

app.get('/api/bouts/:id/shares', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)
  const boutId = Number(c.req.param('id'))

  if (!user) return c.json({ error: 'Sign in required' }, 401)

  const bout = await c.env.DB.prepare('SELECT id FROM bouts WHERE id = ? AND owner_key = ?')
    .bind(boutId, ownerKey)
    .first()
  if (!bout) return c.json({ error: 'Bout not found' }, 404)

  const { results } = await c.env.DB.prepare(
    `SELECT bs.id, bs.created_at, bs.target_user_id, u.email
     FROM bout_shares bs
     JOIN users u ON u.id = bs.target_user_id
     WHERE bs.bout_id = ?
     ORDER BY datetime(bs.created_at) DESC, bs.id DESC`
  )
    .bind(boutId)
    .all()

  return c.json(results)
})

app.post('/api/bouts/:id/share', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)
  const boutId = Number(c.req.param('id'))
  const { email } = await c.req.json()
  const normalizedEmail = normalizeEmail(email)

  if (!user) return c.json({ error: 'Sign in required' }, 401)
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    return c.json({ error: 'Valid email is required' }, 400)
  }

  const bout = await c.env.DB.prepare('SELECT id FROM bouts WHERE id = ? AND owner_key = ?')
    .bind(boutId, ownerKey)
    .first()
  if (!bout) return c.json({ error: 'Bout not found' }, 404)

  const target = await c.env.DB.prepare('SELECT id, email FROM users WHERE email = ?')
    .bind(normalizedEmail)
    .first()
  if (!target) return c.json({ error: 'No account found for that email address' }, 404)
  if (Number(target.id) === Number(user.id)) {
    return c.json({ error: 'You already own this bout' }, 400)
  }

  await c.env.DB.prepare('INSERT INTO bout_shares (bout_id, owner_user_id, target_user_id) VALUES (?, ?, ?) ON CONFLICT(bout_id, target_user_id) DO NOTHING')
    .bind(boutId, user.id, target.id)
    .run()

  return c.json({ success: true, shared_with: target.email })
})

app.delete('/api/bouts/:id/shares/:shareId', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)
  const boutId = Number(c.req.param('id'))
  const shareId = Number(c.req.param('shareId'))

  if (!user) return c.json({ error: 'Sign in required' }, 401)

  const bout = await c.env.DB.prepare('SELECT id FROM bouts WHERE id = ? AND owner_key = ?')
    .bind(boutId, ownerKey)
    .first()
  if (!bout) return c.json({ error: 'Bout not found' }, 404)

  await c.env.DB.prepare('DELETE FROM bout_shares WHERE id = ? AND bout_id = ?')
    .bind(shareId, boutId)
    .run()

  return c.json({ success: true })
})

app.post('/api/bouts/:id/touches', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)
  const boutId = Number(c.req.param('id'))
  const { video_time_seconds, scorer, row_verdict, note } = await c.req.json()

  const exists = await c.env.DB.prepare('SELECT id FROM bouts WHERE id = ? AND owner_key = ?').bind(boutId, ownerKey).first()
  if (!exists) return c.json({ error: 'Bout not found' }, 404)
  if (video_time_seconds == null || !scorer) {
    return c.json({ error: 'video_time_seconds and scorer are required' }, 400)
  }

  const result = await c.env.DB.prepare(
    'INSERT INTO touches (bout_id, video_time_seconds, scorer, row_verdict, note) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(boutId, Number(video_time_seconds), scorer, row_verdict ?? null, note ?? null)
    .run()

  const touch = await c.env.DB.prepare('SELECT * FROM touches WHERE id = ?').bind(result.meta.last_row_id).first()
  const score = await recalculateBoutScore(c.env, boutId)

  return c.json({ touch, score }, 201)
})

app.patch('/api/touches/:id', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey } = await getAuthContext(c)
  const touchId = Number(c.req.param('id'))
  const payload = await c.req.json()

  const existing = await c.env.DB.prepare(
    `SELECT t.*
     FROM touches t
     JOIN bouts b ON b.id = t.bout_id
     WHERE t.id = ? AND b.owner_key = ?`
  )
    .bind(touchId, ownerKey)
    .first()

  if (!existing) return c.json({ error: 'Touch not found' }, 404)

  const nextScorer = payload?.scorer ?? existing.scorer
  const nextTime = payload?.video_time_seconds ?? existing.video_time_seconds
  const nextVerdict = payload?.row_verdict ?? existing.row_verdict
  const nextNote = payload?.note ?? existing.note

  if (!['left', 'right', 'none'].includes(String(nextScorer))) {
    return c.json({ error: 'scorer must be left, right, or none' }, 400)
  }

  const parsedTime = Number(nextTime)
  if (!Number.isFinite(parsedTime) || parsedTime < 0) {
    return c.json({ error: 'video_time_seconds must be a non-negative number' }, 400)
  }

  await c.env.DB.prepare(
    'UPDATE touches SET video_time_seconds = ?, scorer = ?, row_verdict = ?, note = ? WHERE id = ?'
  )
    .bind(parsedTime, String(nextScorer), nextVerdict ?? null, nextNote ?? null, touchId)
    .run()

  const touch = await c.env.DB.prepare('SELECT * FROM touches WHERE id = ?').bind(touchId).first()
  const score = await recalculateBoutScore(c.env, existing.bout_id)

  return c.json({ touch, score })
})

app.delete('/api/touches/:id', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)
  const touchId = Number(c.req.param('id'))

  const touch = await c.env.DB.prepare(
    `SELECT t.*
     FROM touches t
     JOIN bouts b ON b.id = t.bout_id
     WHERE t.id = ? AND b.owner_key = ?`
  )
    .bind(touchId, ownerKey)
    .first()
  if (!touch) return c.json({ error: 'Touch not found' }, 404)

  await c.env.DB.prepare('DELETE FROM touches WHERE id = ?').bind(touchId).run()
  const score = await recalculateBoutScore(c.env, touch.bout_id)
  return c.json({ success: true, score })
})

app.post('/api/bouts/:id/tip-marks', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)
  const boutId = Number(c.req.param('id'))
  const { marks } = await c.req.json()

  if (!Array.isArray(marks) || marks.length === 0) {
    return c.json({ error: 'marks array is required' }, 400)
  }

  const exists = await c.env.DB.prepare('SELECT id FROM bouts WHERE id = ? AND owner_key = ?').bind(boutId, ownerKey).first()
  if (!exists) return c.json({ error: 'Bout not found' }, 404)

  const stmt = c.env.DB.prepare(
    'INSERT INTO tip_marks (bout_id, fencer, video_time_seconds, x_norm, y_norm) VALUES (?, ?, ?, ?, ?)'
  )
  const batch = marks.map((m) =>
    stmt.bind(boutId, m.fencer, Number(m.video_time_seconds), Number(m.x_norm), Number(m.y_norm))
  )
  await c.env.DB.batch(batch)

  const tipMarks = await c.env.DB.prepare(
    'SELECT * FROM tip_marks WHERE bout_id = ? ORDER BY video_time_seconds ASC, id ASC'
  )
    .bind(boutId)
    .all()

  return c.json({ tip_marks: tipMarks.results }, 201)
})

app.delete('/api/bouts/:id/tip-marks', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)
  const boutId = Number(c.req.param('id'))
  const fencer = c.req.query('fencer')

  if (!fencer || !['left', 'right'].includes(fencer)) {
    return c.json({ error: 'fencer=left|right is required' }, 400)
  }

  const exists = await c.env.DB.prepare('SELECT id FROM bouts WHERE id = ? AND owner_key = ?').bind(boutId, ownerKey).first()
  if (!exists) return c.json({ error: 'Bout not found' }, 404)

  await c.env.DB.prepare('DELETE FROM tip_marks WHERE bout_id = ? AND fencer = ?').bind(boutId, fencer).run()

  const tipMarks = await c.env.DB.prepare(
    'SELECT * FROM tip_marks WHERE bout_id = ? ORDER BY video_time_seconds ASC, id ASC'
  )
    .bind(boutId)
    .all()

  return c.json({ success: true, tip_marks: tipMarks.results })
})

app.get('/uploads/:filename', async (c) => {
  await ensureSchema(c.env)
  const { ownerKey, user } = await getAuthContext(c)
  const key = c.req.param('filename')

  const access = await c.env.DB.prepare(
    `SELECT b.id
     FROM bouts b
     LEFT JOIN bout_shares bs ON bs.bout_id = b.id AND bs.target_user_id = ?
     WHERE b.video_filename = ? AND (b.owner_key = ? OR bs.id IS NOT NULL)
     LIMIT 1`
  )
    .bind(user?.id || -1, key, ownerKey)
    .first()

  if (!access) return c.notFound()

  const object = await c.env.VIDEOS.get(key)
  if (!object) return c.notFound()

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('cache-control', 'private, max-age=3600')
  return new Response(object.body, { headers })
})

app.get('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw)
})

export default app
