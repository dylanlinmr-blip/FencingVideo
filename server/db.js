import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'

const dataDir = path.resolve(process.cwd(), 'data')
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

const dbPath = path.join(dataDir, 'fencevision.db')
const db = new Database(dbPath)

db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS bouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  weapon TEXT NOT NULL CHECK (weapon IN ('foil','sabre','epee')),
  left_name TEXT NOT NULL,
  right_name TEXT NOT NULL,
  video_filename TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  left_score INTEGER DEFAULT 0,
  right_score INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS touches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bout_id INTEGER NOT NULL,
  video_time_seconds REAL NOT NULL,
  scorer TEXT NOT NULL CHECK (scorer IN ('left','right','none')),
  row_verdict TEXT,
  note TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bout_id) REFERENCES bouts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tip_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bout_id INTEGER NOT NULL,
  fencer TEXT NOT NULL CHECK (fencer IN ('left','right')),
  video_time_seconds REAL NOT NULL,
  x_norm REAL NOT NULL,
  y_norm REAL NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bout_id) REFERENCES bouts(id) ON DELETE CASCADE
);
`)

export function recalculateBoutScore(boutId) {
  const result = db
    .prepare(
      `SELECT
        SUM(CASE WHEN scorer = 'left' THEN 1 ELSE 0 END) AS left_score,
        SUM(CASE WHEN scorer = 'right' THEN 1 ELSE 0 END) AS right_score
      FROM touches WHERE bout_id = ?`
    )
    .get(boutId)

  const leftScore = result?.left_score || 0
  const rightScore = result?.right_score || 0

  db.prepare('UPDATE bouts SET left_score = ?, right_score = ? WHERE id = ?').run(
    leftScore,
    rightScore,
    boutId
  )

  return { leftScore, rightScore }
}

export default db
