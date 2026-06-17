import { useEffect, useState } from 'react'
import { Swords, Upload, LibraryBig, Info, Users, CalendarDays, LogIn, LogOut, UserPlus } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { api } from '../lib/api'

const links = [
  { to: '/', label: 'Bouts', icon: LibraryBig },
  { to: '/upload', label: 'Upload', icon: Upload },
  { to: '/fencers', label: 'Fencers', icon: Users },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays },
  { to: '/about', label: 'About', icon: Info },
]

export default function NavBar() {
  const [user, setUser] = useState(null)
  const [authOpen, setAuthOpen] = useState(false)
  const [authMode, setAuthMode] = useState('login')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ email: '', password: '' })

  const loadSession = async () => {
    try {
      const payload = await api('/api/auth/me')
      setUser(payload.user || null)
    } catch {
      setUser(null)
    }
  }

  useEffect(() => {
    loadSession()
  }, [])

  const submitAuth = async (event) => {
    event.preventDefault()
    setMessage('')
    setLoading(true)
    try {
      const endpoint = authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login'
      await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          email: form.email.trim(),
          password: form.password,
        }),
      })
      window.location.reload()
    } catch (error) {
      setMessage(error.message)
      setLoading(false)
    }
  }

  const logout = async () => {
    setMessage('')
    setLoading(true)
    try {
      await api('/api/auth/logout', { method: 'POST' })
      window.location.reload()
    } catch (error) {
      setMessage(error.message)
      setLoading(false)
    }
  }

  return (
    <header className="border-b border-slate-800 bg-black/30 sticky top-0 z-20 backdrop-blur">
      <nav className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
        <NavLink to="/" className="flex items-center gap-2 text-lg font-semibold">
          <Swords className="text-accentRed" size={20} />
          <span>FenceVision</span>
        </NavLink>

        <div className="flex items-center gap-2 flex-wrap justify-end">
          {links.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `px-3 py-2 rounded-lg text-sm flex items-center gap-2 transition ${
                  isActive ? 'bg-slate-100 text-slate-900' : 'text-slate-300 hover:bg-slate-800'
                }`
              }
            >
              <Icon size={16} /> {label}
            </NavLink>
          ))}

          {user ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-300 hidden md:inline">{user.email}</span>
              <button className="btn-ghost" onClick={logout} disabled={loading}>
                <LogOut size={14} /> Logout
              </button>
            </div>
          ) : (
            <button className="btn-ghost" onClick={() => setAuthOpen((prev) => !prev)}>
              <LogIn size={14} /> Sign in
            </button>
          )}
        </div>
      </nav>

      {!user && authOpen ? (
        <div className="max-w-7xl mx-auto px-4 pb-3">
          <div className="glass p-3 md:p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <button
                className={`px-3 py-1.5 rounded-lg ${authMode === 'login' ? 'bg-slate-100 text-slate-900' : 'bg-slate-800 text-slate-300'}`}
                onClick={() => setAuthMode('login')}
              >
                <LogIn size={14} className="inline mr-1" /> Sign in
              </button>
              <button
                className={`px-3 py-1.5 rounded-lg ${authMode === 'signup' ? 'bg-slate-100 text-slate-900' : 'bg-slate-800 text-slate-300'}`}
                onClick={() => setAuthMode('signup')}
              >
                <UserPlus size={14} className="inline mr-1" /> Create account
              </button>
            </div>

            <form onSubmit={submitAuth} className="grid md:grid-cols-[1fr_1fr_auto] gap-2">
              <input
                type="email"
                value={form.email}
                onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
                placeholder="Email"
                className="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm outline-none focus:border-slate-500"
                required
              />
              <input
                type="password"
                value={form.password}
                onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
                placeholder={authMode === 'signup' ? 'Password (min 8 chars)' : 'Password'}
                className="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm outline-none focus:border-slate-500"
                required
                minLength={authMode === 'signup' ? 8 : 1}
              />
              <button type="submit" className="btn-primary justify-center" disabled={loading}>
                {loading ? 'Please wait...' : authMode === 'signup' ? 'Create account' : 'Sign in'}
              </button>
            </form>

            {message ? <p className="text-sm text-rose-300">{message}</p> : null}
            <p className="text-xs text-slate-400">Sign in to share bouts with other registered accounts.</p>
          </div>
        </div>
      ) : null}
    </header>
  )
}
