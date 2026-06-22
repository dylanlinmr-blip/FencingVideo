import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { UploadCloud } from 'lucide-react'
import { api } from '../lib/api'

const MAX_PART_BYTES = 25 * 1024 * 1024

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getUploadPlan(fileSize) {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4
  const hardwareLimit = Math.max(2, Math.min(8, Number(cores)))

  let chunkSize = 8 * 1024 * 1024
  let concurrency = Math.min(4, hardwareLimit)

  if (fileSize <= 80 * 1024 * 1024) {
    chunkSize = 5 * 1024 * 1024
    concurrency = Math.min(3, hardwareLimit)
  } else if (fileSize <= 400 * 1024 * 1024) {
    chunkSize = 10 * 1024 * 1024
    concurrency = Math.min(4, hardwareLimit)
  } else if (fileSize <= 1024 * 1024 * 1024) {
    chunkSize = 16 * 1024 * 1024
    concurrency = Math.min(5, hardwareLimit)
  } else {
    chunkSize = 20 * 1024 * 1024
    concurrency = Math.min(6, hardwareLimit)
  }

  return {
    chunkSize: Math.min(chunkSize, MAX_PART_BYTES),
    concurrency,
  }
}

export default function UploadPage() {
  const navigate = useNavigate()
  const inputRef = useRef(null)
  const [file, setFile] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadMeta, setUploadMeta] = useState({ streams: 0, chunkSizeMb: 0, uploadedMb: 0, totalMb: 0 })
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    title: '',
    weapon: 'foil',
    left_name: 'Left Fencer',
    right_name: 'Right Fencer',
  })

  const uploadPartWithRetry = async ({ key, uploadId, partNumber, chunk, maxRetries = 4 }) => {
    let lastError = null

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        return await api(
          `/api/uploads/part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: chunk,
          }
        )
      } catch (err) {
        lastError = err
        if (attempt < maxRetries) {
          const backoff = 400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250)
          await sleep(backoff)
        }
      }
    }

    throw new Error(lastError?.message || `Failed to upload chunk #${partNumber}`)
  }

  const submit = async (event) => {
    event.preventDefault()
    if (!file) return

    const { chunkSize, concurrency } = getUploadPlan(file.size)
    let uploadSession = null

    setSaving(true)
    setUploadProgress(0)
    setUploadMeta({
      streams: concurrency,
      chunkSizeMb: Math.round((chunkSize / (1024 * 1024)) * 10) / 10,
      uploadedMb: 0,
      totalMb: Math.round((file.size / (1024 * 1024)) * 10) / 10,
    })
    setError('')

    try {
      uploadSession = await api('/api/uploads/init', {
        method: 'POST',
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
        }),
      })

      const totalParts = Math.ceil(file.size / chunkSize)
      const parts = new Array(totalParts)
      let uploadedBytes = 0
      let nextPartIndex = 0

      const worker = async () => {
        while (true) {
          const currentIndex = nextPartIndex
          nextPartIndex += 1
          if (currentIndex >= totalParts) return

          const partNumber = currentIndex + 1
          const start = currentIndex * chunkSize
          const end = Math.min(start + chunkSize, file.size)
          const chunk = file.slice(start, end)

          const uploadedPart = await uploadPartWithRetry({
            key: uploadSession.key,
            uploadId: uploadSession.uploadId,
            partNumber,
            chunk,
          })

          parts[currentIndex] = { partNumber, etag: uploadedPart.etag }
          uploadedBytes += chunk.size
          setUploadProgress(Math.min(100, Math.round((uploadedBytes / file.size) * 100)))
          setUploadMeta((prev) => ({
            ...prev,
            uploadedMb: Math.round((uploadedBytes / (1024 * 1024)) * 10) / 10,
          }))
        }
      }

      const workerCount = Math.min(concurrency, totalParts)
      await Promise.all(Array.from({ length: workerCount }, () => worker()))

      if (parts.some((part) => !part)) {
        throw new Error('Upload incomplete. Please retry.')
      }

      const created = await api('/api/uploads/complete', {
        method: 'POST',
        body: JSON.stringify({
          key: uploadSession.key,
          uploadId: uploadSession.uploadId,
          parts,
          ...form,
        }),
      })

      navigate(`/analyzer/${created.id}`)
    } catch (err) {
      if (uploadSession?.key && uploadSession?.uploadId) {
        try {
          await api('/api/uploads/abort', {
            method: 'POST',
            body: JSON.stringify({ key: uploadSession.key, uploadId: uploadSession.uploadId }),
          })
        } catch {
          // Ignore abort failures; surface original upload error instead.
        }
      }

      const normalizedError = String(err?.message || '').toLowerCase()
      if (normalizedError.includes('request denied')) {
        setError('Upload request was denied. Upload now uses adaptive chunk sizing and parallel streams, but still requires a working API-enabled deployment link.')
      } else {
        setError(err.message || 'Upload failed. Please try again.')
      }
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
            setUploadProgress(0)
            setError('')
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
          onChange={(e) => {
            setFile(e.target.files?.[0] || null)
            setUploadProgress(0)
            setError('')
          }}
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

        {saving ? (
          <p className="text-sm text-slate-200 bg-slate-800/60 border border-slate-600 rounded p-2">
            Uploading with {uploadMeta.streams} parallel streams ({uploadMeta.chunkSizeMb}MB chunks): {uploadProgress}%
            {uploadMeta.totalMb > 0 ? ` • ${uploadMeta.uploadedMb}/${uploadMeta.totalMb} MB` : ''}
          </p>
        ) : null}

        {error ? <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2">{error}</p> : null}

        <button disabled={!file || saving} className="btn-primary disabled:opacity-50" type="submit">
          {saving ? `Uploading ${uploadProgress}%` : 'Create Bout'}
        </button>
      </form>
    </section>
  )
}
