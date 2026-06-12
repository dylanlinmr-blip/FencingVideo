import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, ExternalLink, RefreshCw, Save, Search, UserRound } from 'lucide-react'
import { api } from '../lib/api'

function formatDate(value) {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString()
}

export default function FencersPage() {
  const [fencers, setFencers] = useState([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [message, setMessage] = useState('')
  const [savingName, setSavingName] = useState('')
  const [syncingName, setSyncingName] = useState('')
  const [linkDrafts, setLinkDrafts] = useState({})

  const loadFencers = async () => {
    setLoading(true)
    setMessage('')
    try {
      const rows = await api('/api/fencers')
      setFencers(rows)
      setLinkDrafts((prev) => {
        const next = { ...prev }
        for (const row of rows) {
          if (!next[row.name]) {
            next[row.name] = {
              member_id: row.usafencing_member_id || '',
              profile_url: row.usafencing_profile_url || '',
            }
          }
        }
        return next
      })
    } catch (error) {
      setMessage(error.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadFencers()
  }, [])

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return fencers
    return fencers.filter((fencer) => fencer.name.toLowerCase().includes(term))
  }, [fencers, query])

  const updateDraft = (name, key, value) => {
    setLinkDrafts((prev) => ({
      ...prev,
      [name]: {
        ...(prev[name] || { member_id: '', profile_url: '' }),
        [key]: value,
      },
    }))
  }

  const saveLink = async (name) => {
    const draft = linkDrafts[name] || { member_id: '', profile_url: '' }
    setSavingName(name)
    setMessage('')
    try {
      await api(`/api/fencers/${encodeURIComponent(name)}/usafencing-link`, {
        method: 'POST',
        body: JSON.stringify({
          member_id: draft.member_id.trim() || null,
          profile_url: draft.profile_url.trim() || null,
        }),
      })
      await loadFencers()
      setMessage(`Saved USA Fencing link for ${name}.`)
    } catch (error) {
      setMessage(error.message)
    } finally {
      setSavingName('')
    }
  }

  const syncResults = async (name) => {
    setSyncingName(name)
    setMessage('')
    try {
      const payload = await api(`/api/fencers/${encodeURIComponent(name)}/usafencing-sync`, {
        method: 'POST',
      })
      await loadFencers()
      setMessage(`Synced ${payload.synced || 0} result(s) for ${name}.`)
    } catch (error) {
      setMessage(error.message)
    } finally {
      setSyncingName('')
    }
  }

  if (loading) return <div className="text-slate-400">Loading fencers...</div>

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Fencer Tracker</h1>
          <p className="text-slate-400 text-sm">Every fencer from the left/right side of uploaded bouts, plus their complete bout history.</p>
        </div>
        <label className="glass px-3 py-2 flex items-center gap-2 text-sm">
          <Search size={16} className="text-slate-400" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search fencer"
            className="bg-transparent outline-none text-slate-100 placeholder:text-slate-500"
          />
        </label>
      </div>

      {message ? <div className="glass p-3 text-sm text-slate-300">{message}</div> : null}

      {filtered.length === 0 ? (
        <div className="glass p-8 text-center text-slate-400">No fencers found yet.</div>
      ) : (
        <div className="space-y-4">
          {filtered.map((fencer) => {
            const draft = linkDrafts[fencer.name] || { member_id: '', profile_url: '' }
            return (
              <article key={fencer.name} className="glass p-4 space-y-4">
                <header className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold flex items-center gap-2">
                      <UserRound size={18} className="text-accentRed" />
                      {fencer.name}
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      Bouts: {fencer.bout_count} • Last Bout: {formatDate(fencer.last_bout_at)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link className="btn-ghost text-xs" to={`/fencers/${encodeURIComponent(fencer.name)}`}>
                      View Detail <ArrowRight size={14} />
                    </Link>
                    {fencer.usafencing_profile_url ? (
                      <a href={fencer.usafencing_profile_url} target="_blank" rel="noreferrer" className="btn-ghost text-xs">
                        <ExternalLink size={14} /> USA Fencing Profile
                      </a>
                    ) : null}
                  </div>
                </header>

                <section className="grid lg:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <h3 className="font-medium">Linked Bouts</h3>
                    {fencer.bouts?.length ? (
                      <ul className="space-y-2">
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
                      <p className="text-sm text-slate-400">No bouts recorded for this fencer yet.</p>
                    )}
                  </div>

                  <div className="space-y-3">
                    <h3 className="font-medium">USA Fencing Link</h3>
                    <div className="space-y-2">
                      <input
                        value={draft.member_id}
                        onChange={(event) => updateDraft(fencer.name, 'member_id', event.target.value)}
                        placeholder="Member ID (optional)"
                        className="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm outline-none focus:border-slate-500"
                      />
                      <input
                        value={draft.profile_url}
                        onChange={(event) => updateDraft(fencer.name, 'profile_url', event.target.value)}
                        placeholder="https://www.usafencing.org/..."
                        className="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm outline-none focus:border-slate-500"
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button className="btn-primary" onClick={() => saveLink(fencer.name)} disabled={savingName === fencer.name}>
                        <Save size={16} /> {savingName === fencer.name ? 'Saving...' : 'Save Link'}
                      </button>
                      <button
                        className="btn-ghost"
                        onClick={() => syncResults(fencer.name)}
                        disabled={syncingName === fencer.name || !(draft.profile_url || fencer.usafencing_profile_url)}
                      >
                        <RefreshCw size={16} className={syncingName === fencer.name ? 'animate-spin' : ''} />
                        {syncingName === fencer.name ? 'Syncing...' : 'Sync Recent Results'}
                      </button>
                    </div>

                    <div className="space-y-2">
                      <h4 className="text-sm font-medium">Recent USA Fencing Results</h4>
                      {fencer.usafencing_recent_results?.length ? (
                        <ul className="space-y-2 max-h-64 overflow-auto pr-1">
                          {fencer.usafencing_recent_results.map((result) => (
                            <li key={result.id} className="bg-slate-900/50 rounded-lg p-2 text-xs">
                              <p className="font-medium">{result.event_name}</p>
                              <p className="text-slate-400">{result.event_date || 'Date unavailable'}</p>
                              <p className="text-slate-300">{result.score_summary}</p>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-sm text-slate-400">No synced USA Fencing results yet.</p>
                      )}
                    </div>
                  </div>
                </section>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
