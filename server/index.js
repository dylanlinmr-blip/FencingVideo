import express from 'express'
import cors from 'cors'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import db, { recalculateBoutScore } from './db.js'

const app = express()
const PORT = 3001

const uploadsDir = path.resolve(process.cwd(), 'uploads')
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const sanitized = file.originalname.replace(/\s+/g, '-')
    cb(null, `${Date.now()}-${sanitized}`)
  },
})

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const valid = ['video/mp4', 'video/webm', 'video/quicktime']
    cb(valid.includes(file.mimetype) ? null : new Error('Invalid file type'), valid.includes(file.mimetype))
  },
})

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use('/uploads', express.static(uploadsDir))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.post('/api/bouts', upload.single('video'), (req, res) => {
  try {
    const { title, weapon, left_name, right_name } = req.body

    if (!title || !weapon || !left_name || !right_name || !req.file) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const stmt = db.prepare(
      'INSERT INTO bouts (title, weapon, left_name, right_name, video_filename) VALUES (?, ?, ?, ?, ?)'
    )

    const result = stmt.run(title, weapon, left_name, right_name, req.file.filename)
    const bout = db.prepare('SELECT * FROM bouts WHERE id = ?').get(result.lastInsertRowid)

    return res.status(201).json(bout)
  } catch (error) {
    return res.status(500).json({ error: 'Failed to create bout', details: error.message })
  }
})

app.get('/api/bouts', (_req, res) => {
  try {
    const bouts = db
      .prepare('SELECT * FROM bouts ORDER BY datetime(created_at) DESC, id DESC')
      .all()
      .map((b) => ({ ...b, video_url: `/uploads/${b.video_filename}` }))

    res.json(bouts)
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch bouts', details: error.message })
  }
})

app.get('/api/bouts/:id', (req, res) => {
  try {
    const id = Number(req.params.id)
    const bout = db.prepare('SELECT * FROM bouts WHERE id = ?').get(id)

    if (!bout) return res.status(404).json({ error: 'Bout not found' })

    const touches = db
      .prepare('SELECT * FROM touches WHERE bout_id = ? ORDER BY video_time_seconds ASC, id ASC')
      .all(id)

    const tip_marks = db
      .prepare('SELECT * FROM tip_marks WHERE bout_id = ? ORDER BY video_time_seconds ASC, id ASC')
      .all(id)

    res.json({
      ...bout,
      video_url: `/uploads/${bout.video_filename}`,
      touches,
      tip_marks,
    })
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch bout detail', details: error.message })
  }
})

app.delete('/api/bouts/:id', (req, res) => {
  try {
    const id = Number(req.params.id)
    const bout = db.prepare('SELECT * FROM bouts WHERE id = ?').get(id)
    if (!bout) return res.status(404).json({ error: 'Bout not found' })

    db.prepare('DELETE FROM bouts WHERE id = ?').run(id)

    const filePath = path.join(uploadsDir, bout.video_filename)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)

    res.json({ success: true })
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete bout', details: error.message })
  }
})

app.post('/api/bouts/:id/touches', (req, res) => {
  try {
    const boutId = Number(req.params.id)
    const { video_time_seconds, scorer, row_verdict, note } = req.body

    if (video_time_seconds == null || !scorer) {
      return res.status(400).json({ error: 'video_time_seconds and scorer are required' })
    }

    const bout = db.prepare('SELECT id FROM bouts WHERE id = ?').get(boutId)
    if (!bout) return res.status(404).json({ error: 'Bout not found' })

    const result = db
      .prepare(
        'INSERT INTO touches (bout_id, video_time_seconds, scorer, row_verdict, note) VALUES (?, ?, ?, ?, ?)'
      )
      .run(boutId, video_time_seconds, scorer, row_verdict ?? null, note ?? null)

    const touch = db.prepare('SELECT * FROM touches WHERE id = ?').get(result.lastInsertRowid)
    const score = recalculateBoutScore(boutId)

    res.status(201).json({ touch, score })
  } catch (error) {
    res.status(500).json({ error: 'Failed to create touch', details: error.message })
  }
})

app.delete('/api/touches/:id', (req, res) => {
  try {
    const touchId = Number(req.params.id)
    const touch = db.prepare('SELECT * FROM touches WHERE id = ?').get(touchId)
    if (!touch) return res.status(404).json({ error: 'Touch not found' })

    db.prepare('DELETE FROM touches WHERE id = ?').run(touchId)
    const score = recalculateBoutScore(touch.bout_id)

    res.json({ success: true, score })
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete touch', details: error.message })
  }
})

app.post('/api/bouts/:id/tip-marks', (req, res) => {
  try {
    const boutId = Number(req.params.id)
    const { marks } = req.body

    if (!Array.isArray(marks) || marks.length === 0) {
      return res.status(400).json({ error: 'marks array is required' })
    }

    const insert = db.prepare(
      'INSERT INTO tip_marks (bout_id, fencer, video_time_seconds, x_norm, y_norm) VALUES (?, ?, ?, ?, ?)'
    )

    const tx = db.transaction((batch) => {
      for (const mark of batch) {
        insert.run(boutId, mark.fencer, mark.video_time_seconds, mark.x_norm, mark.y_norm)
      }
    })

    tx(marks)

    const tip_marks = db
      .prepare('SELECT * FROM tip_marks WHERE bout_id = ? ORDER BY video_time_seconds ASC, id ASC')
      .all(boutId)

    res.status(201).json({ tip_marks })
  } catch (error) {
    res.status(500).json({ error: 'Failed to save tip marks', details: error.message })
  }
})

app.delete('/api/bouts/:id/tip-marks', (req, res) => {
  try {
    const boutId = Number(req.params.id)
    const fencer = req.query.fencer || req.body?.fencer

    if (!fencer || !['left', 'right'].includes(String(fencer))) {
      return res.status(400).json({ error: 'fencer=left|right is required' })
    }

    db.prepare('DELETE FROM tip_marks WHERE bout_id = ? AND fencer = ?').run(boutId, String(fencer))
    const tip_marks = db
      .prepare('SELECT * FROM tip_marks WHERE bout_id = ? ORDER BY video_time_seconds ASC, id ASC')
      .all(boutId)

    res.json({ success: true, tip_marks })
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear tip marks', details: error.message })
  }
})

app.listen(PORT, () => {
  console.log(`FenceVision backend listening on http://localhost:${PORT}`)
})
