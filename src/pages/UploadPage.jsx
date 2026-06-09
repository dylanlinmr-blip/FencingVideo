import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { UploadCloud } from 'lucide-react'
import { api } from '../lib/api'

export default function UploadPage() {
  const navigate = useNavigate()
  const inputRef = useRef(null)
  const [file, setFile] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    title: '',
    weapon: 'foil',
    left_name: 'Left Fencer',
    right_name: 'Right Fencer',
  })

  const submit = async (event) => {
    event.preventDefault()
    if (!file) return

    const body = new FormData()
    body.append('video', file)
    Object.entries(form).forEach(([k, v]) => body.append(k, v))

    setSaving(true)
    try {
      const created = await api('/api/bouts', { method: 'POST', body })
      navigate(`/analyzer/${created.id}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="max-w-2xl mx-auto space-y-4">
      <h1 className="text-2xl font-bold">Upload Bout</h1>
      <form onSubmit={submit} className="glass p-5 space-y-4">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            setFile(e.dataTransfer.files?.[0] || null)
          }}
          className={`w-full border-2 border-dashed rounded-xl p-8 text-center transition ${
            dragging ? 'border-slate-200 bg-slate-800' : 'border-slate-600'
          }`}
        >
          <UploadCloud className="mx-auto mb-2 text-slate-300" />
          <p>{file ? file.name : 'Drag & drop video (.mp4/.webm/.mov) or click to choose'}</p>
        </button>
        <input
          ref={inputRef}
          type="file"
          hidden
          accept="video/mp4,video/webm,video/quicktime"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
        />

        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span>Title</span>
            <input
              required
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2"
            />
          </label>

          <label className="space-y-1 text-sm">
            <span>Weapon</span>
            <select
              value={form.weapon}
              onChange={(e) => setForm({ ...form, weapon: e.target.value })}
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2"
            >
              <option value="foil">Foil</option>
              <option value="sabre">Sabre</option>
              <option value="epee">Épée</option>
            </select>
          </label>

          <label className="space-y-1 text-sm">
            <span>Left Fencer</span>
            <input
              required
              value={form.left_name}
              onChange={(e) => setForm({ ...form, left_name: e.target.value })}
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2"
            />
          </label>

          <label className="space-y-1 text-sm">
            <span>Right Fencer</span>
            <input
              required
              value={form.right_name}
              onChange={(e) => setForm({ ...form, right_name: e.target.value })}
              className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2"
            />
          </label>
        </div>

        <button disabled={!file || saving} className="btn-primary disabled:opacity-50" type="submit">
          {saving ? 'Uploading...' : 'Create Bout'}
        </button>
      </form>
    </section>
  )
}
