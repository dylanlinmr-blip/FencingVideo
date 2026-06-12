import { Swords, Upload, LibraryBig, Info, Users } from 'lucide-react'
import { NavLink } from 'react-router-dom'

const links = [
  { to: '/', label: 'Bouts', icon: LibraryBig },
  { to: '/upload', label: 'Upload', icon: Upload },
  { to: '/fencers', label: 'Fencers', icon: Users },
  { to: '/about', label: 'About', icon: Info },
]

export default function NavBar() {
  return (
    <header className="border-b border-slate-800 bg-black/30 sticky top-0 z-20 backdrop-blur">
      <nav className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
        <NavLink to="/" className="flex items-center gap-2 text-lg font-semibold">
          <Swords className="text-accentRed" size={20} />
          <span>FenceVision</span>
        </NavLink>
        <div className="flex items-center gap-2">
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
        </div>
      </nav>
    </header>
  )
}
