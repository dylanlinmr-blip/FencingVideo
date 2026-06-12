import { Hono } from 'hono'

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
      right_score INTEGER DEFAULT 0
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
      name TEXT NOT NULL UNIQUE,
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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`
  ).run()

  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_touches_bout_time ON touches(bout_id, video_time_seconds)').run()
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tip_marks_bout_time ON tip_marks(bout_id, video_time_seconds)').run()
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_usafencing_results_fencer ON usafencing_results(fencer_id, event_date)').run()
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

async function upsertFencer(env, rawName) {
  const name = String(rawName || '').trim()
  if (!name) return null

  await env.DB.prepare('INSERT INTO fencers (name) VALUES (?) ON CONFLICT(name) DO NOTHING').bind(name).run()
  return env.DB.prepare('SELECT * FROM fencers WHERE name = ?').bind(name).first()
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

app.get('/api/health', (c) => c.json({ ok: true }))

app.get('/api/bouts', async (c) => {
  await ensureSchema(c.env)
  const { results } = await c.env.DB.prepare('SELECT * FROM bouts ORDER BY datetime(created_at) DESC, id DESC').all()
  return c.json(results.map((b) => ({ ...b, video_url: `/uploads/${b.video_filename}` })))
})

async function getFencerSummaries(env) {
  const boutsRes = await env.DB.prepare(
    'SELECT id, title, weapon, left_name, right_name, left_score, right_score, created_at FROM bouts ORDER BY datetime(created_at) DESC, id DESC'
  ).all()
  const linksRes = await env.DB.prepare('SELECT * FROM fencers').all()
  const usaRes = await env.DB.prepare(
    `SELECT f.name, r.id, r.event_name, r.event_date, r.score_summary, r.source_url, r.created_at
     FROM usafencing_results r
     JOIN fencers f ON f.id = r.fencer_id
     ORDER BY datetime(r.created_at) DESC, r.id DESC`
  ).all()

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
  return c.json(await getFencerSummaries(c.env))
})

app.get('/api/fencers/:name', async (c) => {
  await ensureSchema(c.env)
  const name = decodeURIComponent(c.req.param('name'))
  const fencers = await getFencerSummaries(c.env)
  const fencer = fencers.find((entry) => entry.name === name)
  if (!fencer) return c.json({ error: 'Fencer not found' }, 404)
  return c.json(fencer)
})

app.post('/api/fencers/:name/usafencing-link', async (c) => {
  await ensureSchema(c.env)
  const name = decodeURIComponent(c.req.param('name'))
  const { member_id, profile_url } = await c.req.json()

  if (!name) return c.json({ error: 'Fencer name is required' }, 400)

  await upsertFencer(c.env, name)
  await c.env.DB.prepare('UPDATE fencers SET usafencing_member_id = ?, usafencing_profile_url = ? WHERE name = ?')
    .bind(member_id ? String(member_id) : null, profile_url ? String(profile_url) : null, name)
    .run()

  const fencer = await c.env.DB.prepare('SELECT * FROM fencers WHERE name = ?').bind(name).first()
  return c.json(fencer)
})

app.post('/api/fencers/:name/usafencing-sync', async (c) => {
  await ensureSchema(c.env)
  const name = decodeURIComponent(c.req.param('name'))

  const fencer = await c.env.DB.prepare('SELECT * FROM fencers WHERE name = ?').bind(name).first()
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
  const { results } = await c.env.DB.prepare('SELECT * FROM calendar_blocks ORDER BY datetime(start_time) ASC, id ASC').all()
  return c.json(results)
})

app.post('/api/calendar/blocks', async (c) => {
  await ensureSchema(c.env)
  const { title, start_time, end_time, location, notes } = await c.req.json()

  if (!title || !start_time || !end_time) {
    return c.json({ error: 'title, start_time, and end_time are required' }, 400)
  }

  const result = await c.env.DB.prepare(
    'INSERT INTO calendar_blocks (title, start_time, end_time, location, notes) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(String(title), String(start_time), String(end_time), location ? String(location) : null, notes ? String(notes) : null)
    .run()

  const created = await c.env.DB.prepare('SELECT * FROM calendar_blocks WHERE id = ?').bind(result.meta.last_row_id).first()
  return c.json(created, 201)
})

app.delete('/api/calendar/blocks/:id', async (c) => {
  await ensureSchema(c.env)
  const id = Number(c.req.param('id'))
  await c.env.DB.prepare('DELETE FROM calendar_blocks WHERE id = ?').bind(id).run()
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
    'INSERT INTO bouts (title, weapon, left_name, right_name, video_filename) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(String(title), String(weapon), String(left_name), String(right_name), videoFilename)
    .run()

  await upsertFencer(c.env, left_name)
  await upsertFencer(c.env, right_name)

  const bout = await c.env.DB.prepare('SELECT * FROM bouts WHERE id = ?').bind(result.meta.last_row_id).first()
  return c.json({ ...bout, video_url: `/uploads/${bout.video_filename}` }, 201)
})

app.post('/api/uploads/init', async (c) => {
  await ensureSchema(c.env)

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
    'INSERT INTO bouts (title, weapon, left_name, right_name, video_filename) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(String(title), String(weapon), String(left_name), String(right_name), String(key))
    .run()

  await upsertFencer(c.env, left_name)
  await upsertFencer(c.env, right_name)

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
  const id = Number(c.req.param('id'))

  const bout = await c.env.DB.prepare('SELECT * FROM bouts WHERE id = ?').bind(id).first()
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
  const id = Number(c.req.param('id'))

  const bout = await c.env.DB.prepare('SELECT * FROM bouts WHERE id = ?').bind(id).first()
  if (!bout) return c.json({ error: 'Bout not found' }, 404)

  await c.env.DB.prepare('DELETE FROM bouts WHERE id = ?').bind(id).run()
  await c.env.VIDEOS.delete(bout.video_filename)

  return c.json({ success: true })
})

app.post('/api/bouts/:id/touches', async (c) => {
  await ensureSchema(c.env)
  const boutId = Number(c.req.param('id'))
  const { video_time_seconds, scorer, row_verdict, note } = await c.req.json()

  const exists = await c.env.DB.prepare('SELECT id FROM bouts WHERE id = ?').bind(boutId).first()
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

app.delete('/api/touches/:id', async (c) => {
  await ensureSchema(c.env)
  const touchId = Number(c.req.param('id'))

  const touch = await c.env.DB.prepare('SELECT * FROM touches WHERE id = ?').bind(touchId).first()
  if (!touch) return c.json({ error: 'Touch not found' }, 404)

  await c.env.DB.prepare('DELETE FROM touches WHERE id = ?').bind(touchId).run()
  const score = await recalculateBoutScore(c.env, touch.bout_id)
  return c.json({ success: true, score })
})

app.post('/api/bouts/:id/tip-marks', async (c) => {
  await ensureSchema(c.env)
  const boutId = Number(c.req.param('id'))
  const { marks } = await c.req.json()

  if (!Array.isArray(marks) || marks.length === 0) {
    return c.json({ error: 'marks array is required' }, 400)
  }

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
  const boutId = Number(c.req.param('id'))
  const fencer = c.req.query('fencer')

  if (!fencer || !['left', 'right'].includes(fencer)) {
    return c.json({ error: 'fencer=left|right is required' }, 400)
  }

  await c.env.DB.prepare('DELETE FROM tip_marks WHERE bout_id = ? AND fencer = ?').bind(boutId, fencer).run()

  const tipMarks = await c.env.DB.prepare(
    'SELECT * FROM tip_marks WHERE bout_id = ? ORDER BY video_time_seconds ASC, id ASC'
  )
    .bind(boutId)
    .all()

  return c.json({ success: true, tip_marks: tipMarks.results })
})

app.get('/uploads/:filename', async (c) => {
  const key = c.req.param('filename')
  const object = await c.env.VIDEOS.get(key)
  if (!object) return c.notFound()

  const headers = new Headers()
  object.writeHttpMetadata(headers)
  headers.set('etag', object.httpEtag)
  headers.set('cache-control', 'public, max-age=31536000, immutable')
  return new Response(object.body, { headers })
})

app.get('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw)
})

export default app
