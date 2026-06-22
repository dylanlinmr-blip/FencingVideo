import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { UploadCloud } from 'lucide-react'
import { api } from '../lib/api'

const MAX_PART_BYTES = 25 * 1024 * 1024
const RESUME_STORAGE_KEY = 'fv_upload_resume_v1'

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

function getFileFingerprint(file) {
  if (!file) return ''
  return `${file.name}::${file.size}::${file.lastModified}`
}

function readResumeState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RESUME_STORAGE_KEY) || 'null')
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function saveResumeState(payload) {
  localStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(payload))
}

function clearResumeState() {
  localStorage.removeItem(RESUME_STORAGE_KEY)
}

function roundMb(bytes) {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10
}

function calculatePartBytes(partNumber, chunkSize, fileSize) {
  const start = (partNumber - 1) * chunkSize
  const end = Math.min(start + chunkSize, fileSize)
  return Math.max(0, end - start)
}

function hydrateParts(totalParts, persistedParts) {
  const parts = new Array(totalParts).fill(null)
  for (const part of persistedParts || []) {
    const partNumber = Number(part?.partNumber)
    const etag = String(part?.etag || '')
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > totalParts || !etag) continue
    parts[partNumber - 1] = { partNumber, etag }
  }
  return parts
}

export default function UploadPage() {
  const navigate = useNavigate()
  const inputRef = useRef(null)
  const uploadFlowRef = useRef({ paused: false, waiters: [] })

  const [file, setFile] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [saving, setSaving] = useState(false)
  const [paused, setPaused] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadMeta, setUploadMeta] = useState({ streams: 0, chunkSizeMb: 0, uploadedMb: 0, totalMb: 0 })
  const [resumeCandidate, setResumeCandidate] = useState(null)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    title: '',
    weapon: 'foil',
    left_name: 'Left Fencer',
    right_name: 'Right Fencer',
  })

  const flushResumeWaiters = () => {
    const waiters = uploadFlowRef.current.waiters
    uploadFlowRef.current.waiters = []
    for (const resolve of waiters) resolve()
  }

  const pauseUpload = () => {
    uploadFlowRef.current.paused = true
    setPaused(true)
  }

  const resumeUpload = () => {
    uploadFlowRef.current.paused = false
    setPaused(false)
    flushResumeWaiters()
  }

  const waitIfPaused = async () => {
    if (!uploadFlowRef.current.paused) return
    await new Promise((resolve) => {
      uploadFlowRef.current.waiters.push(resolve)
    })
  }

  const syncResumeCandidateForFile = (nextFile) => {
    if (!nextFile) {
      setResumeCandidate(null)
      return
    }

    const saved = readResumeState()
    if (!saved) {
      setResumeCandidate(null)
      return
    }

    const sameFile = saved.fileFingerprint === getFileFingerprint(nextFile)
    if (!sameFile || !saved.key || !saved.uploadId) {
      setResumeCandidate(null)
      return
    }

    const totalParts = Math.ceil(nextFile.size / Number(saved.chunkSize || 1))
    const uploadedParts = hydrateParts(totalParts, saved.parts || []).filter(Boolean).length

    setResumeCandidate({
      ...saved,
      uploadedParts,
      totalParts,
    })

    if (saved.form && typeof saved.form === 'object') {
      setForm((prev) => ({
        ...prev,
        ...saved.form,
      }))
    }
  }

  const uploadPartWithRetry = async ({ key, uploadId, partNumber, chunk, maxRetries = 4 }) => {
    let lastError = null

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      await waitIfPaused()

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

  const persistUploadCheckpoint = ({ fileFingerprint, session, chunkSize, concurrency, parts, currentForm }) => {
    saveResumeState({
      fileFingerprint,
      key: session.key,
      uploadId: session.uploadId,
      chunkSize,
      concurrency,
      parts: parts.filter(Boolean),
      form: currentForm,
      updatedAt: Date.now(),
    })
  }

  const startUpload = async ({ fromSavedSession = false } = {}) => {
    if (!file || saving) return

    const fileFingerprint = getFileFingerprint(file)
    const persisted = fromSavedSession ? readResumeState() : null
    const canResumePersisted =
      persisted &&
      persisted.fileFingerprint === fileFingerprint &&
      persisted.key &&
      persisted.uploadId &&
      Number.isFinite(Number(persisted.chunkSize))

    const defaultPlan = getUploadPlan(file.size)
    const chunkSize = canResumePersisted
      ? Math.min(MAX_PART_BYTES, Math.max(5 * 1024 * 1024, Number(persisted.chunkSize)))
      : defaultPlan.chunkSize
    const concurrency = canResumePersisted
      ? Math.max(2, Math.min(8, Number(persisted.concurrency || defaultPlan.concurrency)))
      : defaultPlan.concurrency

    const totalParts = Math.ceil(file.size / chunkSize)
    const parts = hydrateParts(totalParts, canResumePersisted ? persisted.parts || [] : [])

    let uploadedBytes = 0
    for (const part of parts) {
      if (!part) continue
      uploadedBytes += calculatePartBytes(part.partNumber, chunkSize, file.size)
    }

    const uploadSession = canResumePersisted
      ? { key: String(persisted.key), uploadId: String(persisted.uploadId) }
      : await api('/api/uploads/init', {
          method: 'POST',
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type || 'application/octet-stream',
          }),
        })

    persistUploadCheckpoint({
      fileFingerprint,
      session: uploadSession,
      chunkSize,
      concurrency,
      parts,
      currentForm: form,
    })

    uploadFlowRef.current.paused = false
    uploadFlowRef.current.waiters = []
    setPaused(false)
    setSaving(true)
    setError('')
    setResumeCandidate(null)
    setUploadProgress(Math.min(100, Math.round((uploadedBytes / file.size) * 100)))
    setUploadMeta({
      streams: concurrency,
      chunkSizeMb: roundMb(chunkSize),
      uploadedMb: roundMb(uploadedBytes),
      totalMb: roundMb(file.size),
    })

    try {
      let nextPartIndex = 0

      const takeNextPendingIndex = () => {
        while (nextPartIndex < totalParts && parts[nextPartIndex]) {
          nextPartIndex += 1
        }
        if (nextPartIndex >= totalParts) return -1
        const index = nextPartIndex
        nextPartIndex += 1
        return index
      }

      const worker = async () => {
        while (true) {
          await waitIfPaused()

          const currentIndex = takeNextPendingIndex()
          if (currentIndex < 0) return

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

          if (!parts[currentIndex]) {
            parts[currentIndex] = { partNumber, etag: uploadedPart.etag }
            uploadedBytes += chunk.size
          }

          setUploadProgress(Math.min(100, Math.round((uploadedBytes / file.size) * 100)))
          setUploadMeta((prev) => ({
            ...prev,
            uploadedMb: roundMb(uploadedBytes),
          }))

          persistUploadCheckpoint({
            fileFingerprint,
            session: uploadSession,
            chunkSize,
            concurrency,
            parts,
            currentForm: form,
          })
        }
      }

      const workerCount = Math.min(concurrency, totalParts)
      await Promise.all(Array.from({ length: workerCount }, () => worker()))

      if (parts.some((part) => !part)) {
        throw new Error('Upload incomplete. Please resume and try again.')
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

      clearResumeState()
      setResumeCandidate(null)
      navigate(`/analyzer/${created.id}`)
    } catch (err) {
      const normalizedError = String(err?.message || '').toLowerCase()
      if (normalizedError.includes('request denied')) {
        setError('Upload request was denied. Please use the working API-enabled app link and resume the upload.')
      } else {
        setError(err?.message || 'Upload interrupted. You can resume from the saved progress.')
      }

      syncResumeCandidateForFile(file)
    } finally {
      setSaving(false)
      setPaused(false)
      uploadFlowRef.current.paused = false
      flushResumeWaiters()
    }
  }

  const discardSavedUpload = async () => {
    const saved = readResumeState()
    clearResumeState()
    setResumeCandidate(null)

    if (saved?.key && saved?.uploadId) {
      try {
        await api('/api/uploads/abort', {
          method: 'POST',
          body: JSON.stringify({ key: saved.key, uploadId: saved.uploadId }),
        })
      } catch {
        // Ignore abort failures; local resume state is still cleared.
      }
    }
  }

  return (
    <section className="max-w-2xl mx-auto space-y-4">
      <h1 className="text-2xl font-bold">Upload Bout</h1>
      <form onSubmit={(event) => {
        event.preventDefault()
        startUpload({ fromSavedSession: false })
      }} className="glass p-5 space-y-4">
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
            const selectedFile = e.dataTransfer.files?.[0] || null
            setFile(selectedFile)
            setUploadProgress(0)
            setError('')
            syncResumeCandidateForFile(selectedFile)
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
            const selectedFile = e.target.files?.[0] || null
            setFile(selectedFile)
            setUploadProgress(0)
            setError('')
            syncResumeCandidateForFile(selectedFile)
          }}
        />

        {resumeCandidate && !saving ? (
          <div className="text-sm text-emerald-200 bg-emerald-600/10 border border-emerald-500/40 rounded p-3 space-y-2">
            <p>
              Found a paused upload for this file: {resumeCandidate.uploadedParts}/{resumeCandidate.totalParts} parts complete.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-primary"
                onClick={() => startUpload({ fromSavedSession: true })}
              >
                Resume Previous Upload
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-600 px-3 py-2 text-slate-200"
                onClick={discardSavedUpload}
              >
                Discard Saved Upload
              </button>
            </div>
          </div>
        ) : null}

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
          <div className="text-sm text-slate-200 bg-slate-800/60 border border-slate-600 rounded p-2 space-y-2">
            <p>
              Uploading with {uploadMeta.streams} parallel streams ({uploadMeta.chunkSizeMb}MB chunks): {uploadProgress}%
              {uploadMeta.totalMb > 0 ? ` • ${uploadMeta.uploadedMb}/${uploadMeta.totalMb} MB` : ''}
            </p>
            <div className="flex flex-wrap gap-2">
              {!paused ? (
                <button
                  type="button"
                  className="rounded-lg border border-slate-500 px-3 py-1.5 text-slate-100"
                  onClick={pauseUpload}
                >
                  Pause Upload
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded-lg border border-emerald-500 px-3 py-1.5 text-emerald-200"
                  onClick={resumeUpload}
                >
                  Resume Upload
                </button>
              )}
            </div>
          </div>
        ) : null}

        {error ? <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded p-2">{error}</p> : null}

        <button disabled={!file || saving} className="btn-primary disabled:opacity-50" type="submit">
          {saving ? (paused ? `Paused at ${uploadProgress}%` : `Uploading ${uploadProgress}%`) : 'Create Bout'}
        </button>
      </form>
    </section>
  )
}
