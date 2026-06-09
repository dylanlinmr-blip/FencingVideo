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

  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_touches_bout_time ON touches(bout_id, video_time_seconds)').run()
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_tip_marks_bout_time ON tip_marks(bout_id, video_time_seconds)').run()
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

app.get('/api/health', (c) => c.json({ ok: true }))

app.get('/api/bouts', async (c) => {
  await ensureSchema(c.env)
  const { results } = await c.env.DB.prepare('SELECT * FROM bouts ORDER BY datetime(created_at) DESC, id DESC').all()
  return c.json(results.map((b) => ({ ...b, video_url: `/uploads/${b.video_filename}` })))
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

  const allowedMime = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v'])
  const fileName = (file.name || '').toLowerCase()
  const hasAllowedExtension = /\.(mp4|webm|mov|m4v)$/i.test(fileName)
  const hasAllowedMime = file.type ? allowedMime.has(file.type) : false
  if (!hasAllowedExtension && !hasAllowedMime) {
    return c.json({ error: 'Invalid file type. Please upload MP4, WEBM, MOV, or M4V.' }, 400)
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

  const bout = await c.env.DB.prepare('SELECT * FROM bouts WHERE id = ?').bind(result.meta.last_row_id).first()
  return c.json({ ...bout, video_url: `/uploads/${bout.video_filename}` }, 201)
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
