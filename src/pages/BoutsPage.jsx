import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Trash2, Play } from 'lucide-react'
import { api } from '../lib/api'

const weaponColors = {
  foil: 'bg-cyan-500/20 text-cyan-300',
  sabre: 'bg-amber-500/20 text-amber-300',
  epee: 'bg-fuchsia-500/20 text-fuchsia-300',
}

export default function BoutsPage() {
  const [bouts, setBouts] = useState([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      setBouts(await api('/api/bouts'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const removeBout = async (id) => {
    if (!confirm('Delete this bout?')) return
    await api(`/api/bouts/${id}`, { method: 'DELETE' })
    load()
  }

  if (loading) return <div className="text-slate-400">Loading bouts...</div>

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">Bout Library</h1>
      {bouts.length === 0 ? (
        <div className="glass p-8 text-center text-slate-400">
          No bouts yet. Upload your first fencing video to begin analysis.
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {bouts.map((bout) => (
            <motion.article key={bout.id} layout className="glass p-3 space-y-3">
              <video className="w-full rounded-lg aspect-video object-cover bg-black" src={bout.video_url} />
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="font-semibold line-clamp-2">{bout.title}</h2>
                  <span className={`text-xs px-2 py-1 rounded ${weaponColors[bout.weapon] || ''}`}>
                    {bout.weapon.toUpperCase()}
                  </span>
                </div>
                <p className="text-xs text-slate-400">
                  {new Date(bout.created_at).toLocaleString()} • Score {bout.left_score}-{bout.right_score}
                </p>
                <div className="flex items-center justify-between">
                  <Link to={`/analyzer/${bout.id}`} className="btn-primary">
                    <Play size={16} /> Open
                  </Link>
                  <button className="btn-ghost" onClick={() => removeBout(bout.id)}>
                    <Trash2 size={16} /> Delete
                  </button>
                </div>
              </div>
            </motion.article>
          ))}
        </div>
      )}
    </section>
  )
}
