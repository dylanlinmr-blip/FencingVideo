import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, ExternalLink, MapPin, Plus, Trash2 } from 'lucide-react'
import { api } from '../lib/api'

function toLocalInputValue(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function formatDateTime(value) {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString()
}

function dayKey(dateValue) {
  const parsed = new Date(dateValue)
  if (Number.isNaN(parsed.getTime())) return ''
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`
}

function monthTitle(monthValue) {
  const [year, month] = monthValue.split('-').map(Number)
  if (!year || !month) return ''
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })
}

function buildCalendarGrid(monthValue) {
  const [year, month] = monthValue.split('-').map(Number)
  const firstDay = new Date(year, month - 1, 1)
  const firstWeekday = firstDay.getDay()
  const gridStart = new Date(year, month - 1, 1 - firstWeekday)

  return Array.from({ length: 42 }, (_, index) => {
    const current = new Date(gridStart)
    current.setDate(gridStart.getDate() + index)
    return current
  })
}

export default function CalendarPage() {
  const initialStart = new Date()
  initialStart.setMinutes(0, 0, 0)
  const initialEnd = new Date(initialStart)
  initialEnd.setHours(initialEnd.getHours() + 1)

  const [blocks, setBlocks] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [selectedMonth, setSelectedMonth] = useState(toLocalInputValue(new Date()).slice(0, 7))
  const [selectedDay, setSelectedDay] = useState(dayKey(new Date()))
  const [form, setForm] = useState({
    title: '',
    start_time: toLocalInputValue(initialStart),
    end_time: toLocalInputValue(initialEnd),
    location: '',
    notes: '',
  })

  const loadBlocks = async () => {
    setLoading(true)
    setMessage('')
    try {
      const rows = await api('/api/calendar/blocks')
      setBlocks(rows)
    } catch (error) {
      setMessage(error.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadBlocks()
  }, [])

  const blocksByDay = useMemo(() => {
    const map = new Map()
    for (const block of blocks) {
      const key = dayKey(block.start_time)
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(block)
    }

    for (const [, value] of map) {
      value.sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
    }

    return map
  }, [blocks])

  const selectedDayBlocks = blocksByDay.get(selectedDay) || []

  const saveBlock = async (event) => {
    event.preventDefault()
    setMessage('')

    if (!form.title.trim()) {
      setMessage('Please enter a title for this time block.')
      return
    }

    if (!form.start_time || !form.end_time) {
      setMessage('Please provide both start and end times.')
      return
    }

    const start = new Date(form.start_time)
    const end = new Date(form.end_time)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      setMessage('End time must be after start time.')
      return
    }

    setSaving(true)
    try {
      await api('/api/calendar/blocks', {
        method: 'POST',
        body: JSON.stringify({
          title: form.title.trim(),
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          location: form.location.trim() || null,
          notes: form.notes.trim() || null,
        }),
      })
      setForm((prev) => ({ ...prev, title: '', location: '', notes: '' }))
      await loadBlocks()
      setSelectedDay(dayKey(start))
      setSelectedMonth(toLocalInputValue(start).slice(0, 7))
      setMessage('Time block saved.')
    } catch (error) {
      setMessage(error.message)
    } finally {
      setSaving(false)
    }
  }

  const removeBlock = async (id) => {
    if (!confirm('Delete this time block?')) return
    setMessage('')
    try {
      await api(`/api/calendar/blocks/${id}`, { method: 'DELETE' })
      await loadBlocks()
      setMessage('Time block deleted.')
    } catch (error) {
      setMessage(error.message)
    }
  }

  const calendarGrid = useMemo(() => buildCalendarGrid(selectedMonth), [selectedMonth])

  return (
    <section className="space-y-4">
      <header className="glass p-4 md:p-5 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarDays size={22} className="text-accentRed" />
            Calendar Planner
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Link out to Fencing Time Live for tournament schedules, then mark your own training/travel blocks here.
          </p>
        </div>
        <a
          href="https://www.fencingtimelive.com/"
          target="_blank"
          rel="noreferrer"
          className="btn-ghost"
        >
          <ExternalLink size={16} /> Open Fencing Time Live
        </a>
      </header>

      {message ? <div className="glass p-3 text-sm text-slate-300">{message}</div> : null}

      <div className="grid xl:grid-cols-[380px,1fr] gap-4">
        <aside className="glass p-4 space-y-3">
          <h2 className="font-semibold">Add Time Block</h2>
          <form onSubmit={saveBlock} className="space-y-3">
            <input
              value={form.title}
              onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
              placeholder="Lesson / Tournament / Travel"
              className="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm outline-none focus:border-slate-500"
              required
            />

            <div className="grid grid-cols-1 gap-2">
              <label className="text-xs text-slate-400">Start</label>
              <input
                type="datetime-local"
                value={form.start_time}
                onChange={(event) => setForm((prev) => ({ ...prev, start_time: event.target.value }))}
                className="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm outline-none focus:border-slate-500"
                required
              />
            </div>

            <div className="grid grid-cols-1 gap-2">
              <label className="text-xs text-slate-400">End</label>
              <input
                type="datetime-local"
                value={form.end_time}
                onChange={(event) => setForm((prev) => ({ ...prev, end_time: event.target.value }))}
                className="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm outline-none focus:border-slate-500"
                required
              />
            </div>

            <input
              value={form.location}
              onChange={(event) => setForm((prev) => ({ ...prev, location: event.target.value }))}
              placeholder="Location (optional)"
              className="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm outline-none focus:border-slate-500"
            />

            <textarea
              value={form.notes}
              onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
              placeholder="Notes (optional)"
              rows={3}
              className="w-full rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm outline-none focus:border-slate-500"
            />

            <button type="submit" className="btn-primary w-full justify-center" disabled={saving}>
              <Plus size={16} /> {saving ? 'Saving...' : 'Save Block'}
            </button>
          </form>
        </aside>

        <section className="glass p-4 space-y-4">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <h2 className="font-semibold">{monthTitle(selectedMonth)}</h2>
            <input
              type="month"
              value={selectedMonth}
              onChange={(event) => setSelectedMonth(event.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900/50 px-3 py-2 text-sm outline-none focus:border-slate-500"
            />
          </div>

          {loading ? (
            <p className="text-slate-400 text-sm">Loading calendar blocks...</p>
          ) : (
            <>
              <div className="grid grid-cols-7 gap-2 text-xs text-slate-400">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                  <div key={day} className="text-center">{day}</div>
                ))}
              </div>

              <div className="grid grid-cols-7 gap-2">
                {calendarGrid.map((dateObj) => {
                  const key = dayKey(dateObj)
                  const dayBlocks = blocksByDay.get(key) || []
                  const isCurrentMonth = dateObj.getMonth() + 1 === Number(selectedMonth.slice(5, 7))
                  const isSelected = key === selectedDay

                  return (
                    <button
                      key={`${key}-${dateObj.getTime()}`}
                      type="button"
                      onClick={() => setSelectedDay(key)}
                      className={`rounded-lg border p-2 text-left min-h-20 transition ${
                        isSelected
                          ? 'border-slate-200 bg-slate-100/10'
                          : 'border-slate-800 bg-slate-900/30 hover:border-slate-600'
                      } ${!isCurrentMonth ? 'opacity-45' : ''}`}
                    >
                      <div className="text-sm font-medium">{dateObj.getDate()}</div>
                      {dayBlocks.length ? (
                        <div className="mt-1 space-y-1">
                          {dayBlocks.slice(0, 2).map((block) => (
                            <div key={block.id} className="text-[10px] rounded bg-accentRed/20 px-1 py-0.5 truncate">
                              {block.title}
                            </div>
                          ))}
                          {dayBlocks.length > 2 ? <div className="text-[10px] text-slate-400">+{dayBlocks.length - 2} more</div> : null}
                        </div>
                      ) : null}
                    </button>
                  )
                })}
              </div>

              <div className="pt-2 border-t border-slate-800">
                <h3 className="font-medium text-sm">
                  {selectedDay ? new Date(`${selectedDay}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }) : 'Select a date'}
                </h3>
                {selectedDayBlocks.length === 0 ? (
                  <p className="text-sm text-slate-400 mt-2">No blocks for this day yet.</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {selectedDayBlocks.map((block) => (
                      <li key={block.id} className="bg-slate-900/50 rounded-lg p-3 flex items-start justify-between gap-3">
                        <div>
                          <p className="font-medium text-sm">{block.title}</p>
                          <p className="text-xs text-slate-400 mt-1">
                            {formatDateTime(block.start_time)} → {formatDateTime(block.end_time)}
                          </p>
                          {block.location ? (
                            <p className="text-xs text-slate-300 mt-1 inline-flex items-center gap-1">
                              <MapPin size={12} /> {block.location}
                            </p>
                          ) : null}
                          {block.notes ? <p className="text-xs text-slate-400 mt-1">{block.notes}</p> : null}
                        </div>
                        <button className="btn-ghost" onClick={() => removeBlock(block.id)}>
                          <Trash2 size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </section>
  )
}
