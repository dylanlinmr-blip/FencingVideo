import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Trash2, Play, Share2, X } from 'lucide-react'
import { api } from '../lib/api'

const weaponColors = {
  foil: 'bg-cyan-500/20 text-cyan-300',
  sabre: 'bg-amber-500/20 text-amber-300',
  epee: 'bg-fuchsia-500/20 text-fuchsia-300',
}

export default function BoutsPage() {
  const [bouts, setBouts] = useState([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [shareDrafts, setShareDrafts] = useState({})
  const [sharesByBout, setSharesByBout] = useState({})
  const [sharingBoutId, setSharingBoutId] = useState(null)
  const [loadingSharesFor, setLoadingSharesFor] = useState(null)

  const load = async () => {
    setLoading(true)
    try {
      setBouts(await api('/api/bouts'))
    } catch (error) {
      setMessage(error.message)
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

  const loadShares = async (boutId) => {
    setLoadingSharesFor(boutId)
    setMessage('')
    try {
      const shares = await api(`/api/bouts/${boutId}/shares`)
      setSharesByBout((prev) => ({ ...prev, [boutId]: shares }))
    } catch (error) {
      setMessage(error.message)
    } finally {
      setLoadingSharesFor(null)
    }
  }

  const shareBout = async (boutId) => {
    const email = (shareDrafts[boutId] || '').trim()
    if (!email) {
      setMessage('Enter an email to share this bout.')
      return
    }

    setSharingBoutId(boutId)
    setMessage('')
    try {
      await api(`/api/bouts/${boutId}/share`, {
        method: 'POST',
        body: JSON.stringify({ email }),
      })
      setShareDrafts((prev) => ({ ...prev, [boutId]: '' }))
      await loadShares(boutId)
      setMessage('Bout shared successfully.')
    } catch (error) {
      setMessage(error.message)
    } finally {
      setSharingBoutId(null)
    }
  }

  const revokeShare = async (boutId, shareId) => {
    setMessage('')
    try {
      await api(`/api/bouts/${boutId}/shares/${shareId}`, { method: 'DELETE' })
      await loadShares(boutId)
      setMessage('Share removed.')
    } catch (error) {
      setMessage(error.message)
    }
  }

  if (loading) return <div className="text-slate-400">Loading bouts...</div>

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-bold">Bout Library</h1>
      {message ? <div className="glass p-3 text-sm text-slate-300">{message}</div> : null}
      {bouts.length === 0 ? (
        <div className="glass p-8 text-center text-slate-400">
          No bouts yet. Upload your first fencing video to begin analysis.
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {bouts.map((bout) => {
            const canEdit = Boolean(Number(bout.can_edit ?? 1))
            const isShared = bout.access_type === 'shared'
            const shares = sharesByBout[bout.id] || []

            return (
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

                  {isShared ? (
                    <p className="text-xs text-emerald-300">Shared with you {bout.shared_by_email ? `by ${bout.shared_by_email}` : ''}</p>
                  ) : (
                    <p className="text-xs text-sky-300">Owned by you</p>
                  )}

                  <div className="flex items-center justify-between gap-2">
                    <Link to={`/analyzer/${bout.id}`} className="btn-primary">
                      <Play size={16} /> Open
                    </Link>
                    {canEdit ? (
                      <button className="btn-ghost" onClick={() => removeBout(bout.id)}>
                        <Trash2 size={16} /> Delete
                      </button>
                    ) : null}
                  </div>

                  {canEdit ? (
                    <div className="pt-2 border-t border-slate-800 space-y-2">
                      <p className="text-xs text-slate-400">Share this bout with a registered account</p>
                      <div className="flex gap-2">
                        <input
                          value={shareDrafts[bout.id] || ''}
                          onChange={(event) =>
                            setShareDrafts((prev) => ({
                              ...prev,
                              [bout.id]: event.target.value,
                            }))
                          }
                          placeholder="teammate@email.com"
                          className="flex-1 rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-xs outline-none focus:border-slate-500"
                        />
                        <button
                          className="btn-ghost"
                          onClick={() => shareBout(bout.id)}
                          disabled={sharingBoutId === bout.id}
                        >
                          <Share2 size={14} /> {sharingBoutId === bout.id ? 'Sharing...' : 'Share'}
                        </button>
                      </div>

                      <div className="flex items-center justify-between">
                        <button className="text-xs text-slate-400 hover:text-slate-200" onClick={() => loadShares(bout.id)}>
                          {loadingSharesFor === bout.id ? 'Loading shares...' : 'View current shares'}
                        </button>
                      </div>

                      {shares.length ? (
                        <ul className="space-y-1">
                          {shares.map((share) => (
                            <li key={share.id} className="text-xs bg-slate-900/50 rounded px-2 py-1 flex items-center justify-between gap-2">
                              <span>{share.email}</span>
                              <button className="text-slate-400 hover:text-rose-300" onClick={() => revokeShare(bout.id, share.id)}>
                                <X size={12} />
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </motion.article>
            )
          })}
        </div>
      )}
    </section>
  )
}
