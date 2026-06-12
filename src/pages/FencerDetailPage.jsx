import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ExternalLink, RefreshCw, Save, UserRound } from 'lucide-react'
import { api } from '../lib/api'

function formatDate(value) {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString()
}

export default function FencerDetailPage() {
  const { name } = useParams()
  const decodedName = useMemo(() => decodeURIComponent(name || ''), [name])
  const [fencer, setFencer] = useState(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [draft, setDraft] = useState({ member_id: '', profile_url: '' })
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const loadFencer = async () => {
    setLoading(true)
    setMessage('')
    try {
      const row = await api(`/api/fencers/${encodeURIComponent(decodedName)}`)
      setFencer(row)
      setDraft({
        member_id: row.usafencing_member_id || '',
        profile_url: row.usafencing_profile_url || '',
      })
    } catch (error) {
      setMessage(error.message)
      setFencer(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!decodedName) return
    loadFencer()
  }, [decodedName])

  const saveLink = async () => {
    if (!fencer) return
    setSaving(true)
    setMessage('')
    try {
      await api(`/api/fencers/${encodeURIComponent(fencer.name)}/usafencing-link`, {
        method: 'POST',
        body: JSON.stringify({
          member_id: draft.member_id.trim() || null,
          profile_url: draft.profile_url.trim() || null,
        }),
      })
      await loadFencer()
      setMessage(`Saved USA Fencing link for ${fencer.name}.`)
    } catch (error) {
      setMessage(error.message)
    } finally {
      setSaving(false)
    }
  }

  const syncResults = async () => {
    if (!fencer) return
    setSyncing(true)
    setMessage('')
    try {
      const payload = await api(`/api/fencers/${encodeURIComponent(fencer.name)}/usafencing-sync`, {
        method: 'POST',
      })
      await loadFencer()
      setMessage(`Synced ${payload.synced || 0} result(s) for ${fencer.name}.`)
    } catch (error) {
      setMessage(error.message)
    } finally {
      setSyncing(false)
    }
  }

  if (loading) return <div className="text-slate-400">Loading fencer detail...</div>

  if (!fencer) {
    return (
      <section className="space-y-4">
        <Link to="/fencers" className="btn-ghost text-xs">
          <ArrowLeft size={14} /> Back to Fencers
        </Link>
        <div className="glass p-6 text-slate-300">{message || 'Fencer not found.'}</div>
      </section>
    )
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <Link to="/fencers" className="btn-ghost text-xs mb-2">
            <ArrowLeft size={14} /> Back to Fencers
          </Link>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <UserRound size={22} className="text-accentRed" />
            {fencer.name}
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Total Bouts: {fencer.bout_count} • Last Bout: {formatDate(fencer.last_bout_at)}
          </p>
        </div>
        {fencer.usafencing_profile_url ? (
          <a href={fencer.usafencing_profile_url} target="_blank" rel="noreferrer" className="btn-ghost text-xs">
            <ExternalLink size={14} /> USA Fencing Profile
          </a>
        ) : null}
      </div>

      {message ? <div className="glass p-3 text-sm text-slate-300">{message}</div> : null}

      <div className="grid lg:grid-cols-3 gap-4">
        <article className="glass p-4 space-y-3 lg:col-span-1 h-fit">
          <h2 className="font-semibold">USA Fencing Link</h2>
          <input
            value={draft.member_id}
            onChange={(event) => setDraft((prev) => ({ ...prev, member_id: event.target.value }))}
            placeholder="Member ID (optional)"
            className="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm outline-none focus:border-slate-500"
          />
          <input
            value={draft.profile_url}
            onChange={(event) => setDraft((prev) => ({ ...prev, profile_url: event.target.value }))}
            placeholder="https://www.usafencing.org/..."
            className="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm outline-none focus:border-slate-500"
          />
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" onClick={saveLink} disabled={saving}>
              <Save size={16} /> {saving ? 'Saving...' : 'Save Link'}
            </button>
            <button className="btn-ghost" onClick={syncResults} disabled={syncing || !draft.profile_url}>
              <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
              {syncing ? 'Syncing...' : 'Sync Results'}
            </button>
          </div>
        </article>

        <article className="glass p-4 space-y-3 lg:col-span-2">
          <h2 className="font-semibold">Bout History</h2>
          {fencer.bouts?.length ? (
            <ul className="space-y-2 max-h-[520px] overflow-auto pr-1">
              {fencer.bouts.map((bout) => {
                const side = bout.left_name === fencer.name ? 'Left' : 'Right'
                return (
                  <li key={`${fencer.name}-${bout.id}`} className="bg-slate-900/50 rounded-lg p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium">{bout.title}</p>
                      <Link className="btn-ghost text-xs" to={`/analyzer/${bout.id}`}>
                        Open Bout
                      </Link>
                    </div>
                    <p className="text-slate-400 text-xs mt-1">
                      {bout.weapon.toUpperCase()} • {formatDate(bout.created_at)} • Side: {side}
                    </p>
                    <p className="text-slate-300 text-xs mt-1">
                      {bout.left_name} {bout.left_score} - {bout.right_score} {bout.right_name}
                    </p>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="text-sm text-slate-400">No bouts recorded yet for this fencer.</p>
          )}
        </article>
      </div>

      <article className="glass p-4 space-y-2">
        <h2 className="font-semibold">Recent USA Fencing Results</h2>
        {fencer.usafencing_recent_results?.length ? (
          <ul className="space-y-2">
            {fencer.usafencing_recent_results.map((result) => (
              <li key={result.id} className="bg-slate-900/50 rounded-lg p-3 text-sm">
                <p className="font-medium">{result.event_name}</p>
                <p className="text-slate-400 text-xs">{result.event_date || 'Date unavailable'}</p>
                <p className="text-slate-300 text-xs mt-1">{result.score_summary}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-400">No synced results yet.</p>
        )}
      </article>
    </section>
  )
}
