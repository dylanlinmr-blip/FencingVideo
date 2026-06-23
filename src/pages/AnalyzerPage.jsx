import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Rewind,
  FastForward,
  PenLine,
  Undo2,
  Trash2,
  Sparkles,
  Loader2,
  Pencil,
  Check,
  X,
} from 'lucide-react'
import { api, formatClock } from '../lib/api'
import { evaluateRow, rowHints } from '../lib/rowDecision'

const fps = 30
const PRE_TOUCH_OFFSET_KEY = 'fencevision.preTouchOffsetSeconds'

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

function averageRegionSignal(imageData, region, mode) {
  const { data, width, height } = imageData
  const x1 = Math.floor(clamp(region.x, 0, 1) * width)
  const y1 = Math.floor(clamp(region.y, 0, 1) * height)
  const x2 = Math.floor(clamp(region.x + region.w, 0, 1) * width)
  const y2 = Math.floor(clamp(region.y + region.h, 0, 1) * height)

  let count = 0
  let sum = 0
  const step = 2

  for (let y = y1; y < y2; y += step) {
    for (let x = x1; x < x2; x += step) {
      const idx = (y * width + x) * 4
      const r = data[idx]
      const g = data[idx + 1]
      const b = data[idx + 2]
      const brightness = (r + g + b) / 3

      if (mode === 'left') {
        sum += r - (g + b) / 2 + brightness * 0.4
      } else {
        sum += g - (r + b) / 2 + brightness * 0.4
      }
      count += 1
    }
  }

  return count > 0 ? sum / count : 0
}

function getMeanStd(values) {
  if (!values.length) return { mean: 0, std: 0 }
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length
  return { mean, std: Math.sqrt(variance) }
}

function detectSideEvents(samples, key, { threshold, std, cooldown, scorer }) {
  const events = []
  let inPulse = false
  let peak = Number.NEGATIVE_INFINITY
  let peakTime = 0
  let lastEventTime = Number.NEGATIVE_INFINITY

  for (const sample of samples) {
    const value = sample[key]
    const above = value > threshold

    if (above) {
      if (!inPulse) {
        inPulse = true
        peak = value
        peakTime = sample.time
      } else if (value > peak) {
        peak = value
        peakTime = sample.time
      }
    } else if (inPulse) {
      inPulse = false
      if (peakTime - lastEventTime >= cooldown) {
        lastEventTime = peakTime
        const confidence = clamp((peak - threshold) / ((std || 1) * 3), 0.1, 0.99)
        events.push({
          time: peakTime,
          scorer,
          confidence,
          verdict: `AI DETECTED ${scorer.toUpperCase()} LIGHT`,
          note: `AI light pulse (confidence ${(confidence * 100).toFixed(0)}%)`,
        })
      }
    }
  }

  if (inPulse && peakTime - lastEventTime >= cooldown) {
    const confidence = clamp((peak - threshold) / ((std || 1) * 3), 0.1, 0.99)
    events.push({
      time: peakTime,
      scorer,
      confidence,
      verdict: `AI DETECTED ${scorer.toUpperCase()} LIGHT`,
      note: `AI light pulse (confidence ${(confidence * 100).toFixed(0)}%)`,
    })
  }

  return events
}

function mergeSimultaneousEvents(events, windowSeconds = 0.2) {
  const sorted = [...events].sort((a, b) => a.time - b.time)
  const merged = []

  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i]
    const next = sorted[i + 1]

    if (next && current.scorer !== next.scorer && Math.abs(next.time - current.time) <= windowSeconds) {
      const confidence = Math.max(current.confidence, next.confidence)
      merged.push({
        time: (current.time + next.time) / 2,
        scorer: 'none',
        confidence,
        verdict: 'AI DETECTED SIMULTANEOUS LIGHTS',
        note: `AI simultaneous pulse (${(confidence * 100).toFixed(0)}%)`,
      })
      i += 1
      continue
    }

    merged.push(current)
  }

  return merged.map((event, index) => ({
    ...event,
    id: `${Math.round(event.time * 1000)}-${index}-${Math.random().toString(36).slice(2, 7)}`,
  }))
}

function waitForEvent(target, eventName) {
  return new Promise((resolve, reject) => {
    const onLoad = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error(`Failed while waiting for ${eventName}`))
    }
    const cleanup = () => {
      target.removeEventListener(eventName, onLoad)
      target.removeEventListener('error', onError)
    }

    target.addEventListener(eventName, onLoad, { once: true })
    target.addEventListener('error', onError, { once: true })
  })
}

async function detectAiScoreTimeline({ videoUrl, leftRegion, rightRegion, sampleInterval, sensitivity, cooldown, onProgress }) {
  const probeVideo = document.createElement('video')
  probeVideo.src = videoUrl
  probeVideo.muted = true
  probeVideo.playsInline = true
  probeVideo.preload = 'auto'

  if (probeVideo.readyState < 1) {
    await waitForEvent(probeVideo, 'loadedmetadata')
  }

  const duration = Number(probeVideo.duration) || 0
  if (!duration) return []

  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 180
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  const samples = []
  const totalSteps = Math.max(1, Math.ceil(duration / sampleInterval))

  for (let stepIndex = 0; stepIndex <= totalSteps; stepIndex += 1) {
    const time = Math.min(duration, stepIndex * sampleInterval)
    probeVideo.currentTime = time
    await waitForEvent(probeVideo, 'seeked')

    ctx.drawImage(probeVideo, 0, 0, canvas.width, canvas.height)
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)

    samples.push({
      time,
      left: averageRegionSignal(imageData, leftRegion, 'left'),
      right: averageRegionSignal(imageData, rightRegion, 'right'),
    })

    onProgress(Math.round((stepIndex / totalSteps) * 100))
  }

  const leftStats = getMeanStd(samples.map((s) => s.left))
  const rightStats = getMeanStd(samples.map((s) => s.right))

  const leftThreshold = leftStats.mean + leftStats.std * sensitivity
  const rightThreshold = rightStats.mean + rightStats.std * sensitivity

  const leftEvents = detectSideEvents(samples, 'left', {
    threshold: leftThreshold,
    std: leftStats.std,
    cooldown,
    scorer: 'left',
  })

  const rightEvents = detectSideEvents(samples, 'right', {
    threshold: rightThreshold,
    std: rightStats.std,
    cooldown,
    scorer: 'right',
  })

  return mergeSimultaneousEvents([...leftEvents, ...rightEvents])
}

function estimateAiRowFromTrail({ bout, time, windowSeconds = 2.2 }) {
  if (!bout || bout.weapon === 'epee') {
    return { error: 'AI ROW tracking is currently optimized for foil/sabre.' }
  }

  const start = Math.max(0, time - windowSeconds)
  const inWindow = (fencer) =>
    (bout.tip_marks || [])
      .filter((mark) => mark.fencer === fencer && mark.video_time_seconds >= start && mark.video_time_seconds <= time)
      .sort((a, b) => a.video_time_seconds - b.video_time_seconds)

  const leftMarks = inWindow('left')
  const rightMarks = inWindow('right')

  if (leftMarks.length < 2 && rightMarks.length < 2) {
    return { error: 'Not enough tip-mark data. Mark a short exchange first, then run AI ROW suggestion.' }
  }

  const summarize = (marks, side) => {
    let forward = 0
    let activity = 0
    for (let i = 1; i < marks.length; i += 1) {
      const dx = Number(marks[i].x_norm) - Number(marks[i - 1].x_norm)
      const signed = side === 'left' ? dx : -dx
      forward += signed
      activity += Math.abs(dx)
    }

    return {
      marks: marks.length,
      start: marks[0]?.video_time_seconds ?? Number.POSITIVE_INFINITY,
      end: marks[marks.length - 1]?.video_time_seconds ?? Number.NEGATIVE_INFINITY,
      forward,
      activity,
    }
  }

  const left = summarize(leftMarks, 'left')
  const right = summarize(rightMarks, 'right')
  const forwardGap = left.forward - right.forward
  const activityTotal = left.activity + right.activity

  let initiator = 'both'
  if (Math.abs(forwardGap) >= 0.03) {
    initiator = forwardGap > 0 ? 'left' : 'right'
  } else if (Math.abs(left.start - right.start) > 0.25) {
    initiator = left.start < right.start ? 'left' : 'right'
  }

  const attackEstablished = activityTotal > 0.05 || Math.abs(forwardGap) > 0.02
  const answers = {
    step1AttackEstablished: attackEstablished ? 'yes' : 'no',
    step1Initiator: initiator,
  }

  const reasons = []
  if (!attackEstablished) {
    answers.step1BothLights = Math.abs(forwardGap) < 0.05 ? 'yes' : 'no'
    answers.step1SingleLightScorer = forwardGap >= 0 ? 'left' : 'right'
    reasons.push('Limited forward pressure detected from both fencers in this exchange window.')
  } else if (initiator !== 'both') {
    const attacker = initiator === 'left' ? left : right
    const defender = initiator === 'left' ? right : left
    const landedNoParry = attacker.forward - defender.forward > 0.03 && defender.activity < attacker.activity * 0.9
    answers.step2LandedNoParry = landedNoParry ? 'yes' : 'no'

    if (!landedNoParry) {
      const successfulParry = defender.activity >= attacker.activity * 0.7 || defender.forward >= attacker.forward * 0.8
      answers.step3SuccessfulParry = successfulParry ? 'yes' : 'no'

      if (successfulParry) {
        const riposteImmediate = defender.start - attacker.start < 0.9
        answers.step4RiposteImmediate = riposteImmediate ? 'yes' : 'no'
        if (!riposteImmediate) {
          answers.step4OriginalAttackerRemise = attacker.activity >= defender.activity ? 'yes' : 'no'
        }
      } else {
        answers.step3DefenderThenAttack = defender.forward > 0.02 ? 'yes' : 'no'
      }
    }

    reasons.push(
      `${initiator.toUpperCase()} showed stronger initiating motion (forward delta ${Math.abs(forwardGap).toFixed(3)}).`
    )
  } else {
    reasons.push('Both fencers initiated at near-similar timing and pressure; likely simultaneous setup.')
  }

  const row = evaluateRow(bout.weapon, answers)
  const confidence = clamp(
    0.25 + Math.min(0.45, activityTotal * 2.5) + Math.min(0.25, Math.abs(forwardGap) * 3),
    0.2,
    0.95
  )

  return {
    answers,
    row,
    confidence,
    reasons,
    metrics: {
      left_marks: left.marks,
      right_marks: right.marks,
      forward_gap: Number(forwardGap.toFixed(3)),
    },
  }
}

export default function AnalyzerPage() {
  const { id } = useParams()
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const [bout, setBout] = useState(null)
  const [activeTab, setActiveTab] = useState('row')
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [fadeSeconds, setFadeSeconds] = useState(1.5)
  const [preTouchSeconds, setPreTouchSeconds] = useState(() => {
    if (typeof window === 'undefined') return 1
    const saved = window.localStorage.getItem(PRE_TOUCH_OFFSET_KEY)
    const parsed = Number(saved)
    return parsed === 1 || parsed === 1.5 ? parsed : 1
  })
  const [defaultOffsetSaved, setDefaultOffsetSaved] = useState(false)
  const [markMode, setMarkMode] = useState(false)
  const [markFencer, setMarkFencer] = useState('left')
  const [noteDraft, setNoteDraft] = useState('')
  const [touchSaving, setTouchSaving] = useState(false)
  const [panelError, setPanelError] = useState('')
  const [editingTouchId, setEditingTouchId] = useState(null)
  const [editTouchDraft, setEditTouchDraft] = useState({
    video_time_seconds: 0,
    scorer: 'none',
    row_verdict: '',
    note: '',
  })
  const [aiScanning, setAiScanning] = useState(false)
  const [aiProgress, setAiProgress] = useState(0)
  const [aiApplying, setAiApplying] = useState(false)
  const [aiPredictedTouches, setAiPredictedTouches] = useState([])
  const [aiRegions, setAiRegions] = useState({
    left: { x: 0.02, y: 0.02, w: 0.2, h: 0.15 },
    right: { x: 0.78, y: 0.02, w: 0.2, h: 0.15 },
  })
  const [aiConfig, setAiConfig] = useState({
    sampleInterval: 0.08,
    sensitivity: 2.2,
    cooldown: 0.8,
  })
  const [aiRowRunning, setAiRowRunning] = useState(false)
  const [autoRowTracking, setAutoRowTracking] = useState(false)
  const [aiRowSuggestion, setAiRowSuggestion] = useState(null)
  const [answers, setAnswers] = useState({
    step1AttackEstablished: 'yes',
    step1Initiator: 'left',
  })

  const loadBout = async () => {
    const data = await api(`/api/bouts/${id}`)
    setBout(data)
  }

  const saveOffsetAsDefault = () => {
    window.localStorage.setItem(PRE_TOUCH_OFFSET_KEY, String(preTouchSeconds))
    setDefaultOffsetSaved(true)
    window.setTimeout(() => setDefaultOffsetSaved(false), 1400)
  }

  const resetOffsetDefault = () => {
    window.localStorage.removeItem(PRE_TOUCH_OFFSET_KEY)
    setPreTouchSeconds(1)
    setDefaultOffsetSaved(false)
  }

  useEffect(() => {
    loadBout()
  }, [id])

  useEffect(() => {
    if (!videoRef.current) return
    videoRef.current.playbackRate = speed
  }, [speed])

  useEffect(() => {
    if (!videoRef.current || !canvasRef.current) return

    const resize = () => {
      const video = videoRef.current
      const canvas = canvasRef.current
      const rect = video.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      const ctx = canvas.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      drawTrail()
    }

    const ro = new ResizeObserver(resize)
    ro.observe(videoRef.current)
    resize()

    return () => ro.disconnect()
  }, [bout, fadeSeconds])

  useEffect(() => {
    let raf
    const loop = () => {
      drawTrail()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [bout, fadeSeconds])

  const drawTrail = () => {
    if (!canvasRef.current || !bout) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const width = parseFloat(canvas.style.width || '0')
    const height = parseFloat(canvas.style.height || '0')
    ctx.clearRect(0, 0, width, height)

    const drawFor = (fencer, color) => {
      const marks = bout.tip_marks.filter(
        (m) => m.fencer === fencer && m.video_time_seconds <= currentTime && currentTime - m.video_time_seconds <= fadeSeconds
      )
      if (marks.length < 2) return
      ctx.lineWidth = 2
      for (let i = 1; i < marks.length; i += 1) {
        const prev = marks[i - 1]
        const next = marks[i]
        const age = currentTime - next.video_time_seconds
        const alpha = Math.max(0.1, 1 - age / fadeSeconds)
        ctx.strokeStyle = `${color}${Math.floor(alpha * 255)
          .toString(16)
          .padStart(2, '0')}`
        ctx.beginPath()
        ctx.moveTo(prev.x_norm * width, prev.y_norm * height)
        ctx.lineTo(next.x_norm * width, next.y_norm * height)
        ctx.stroke()
      }
    }

    drawFor('left', '#ef4444')
    drawFor('right', '#22c55e')
  }

  const step = (delta) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = Math.min(Math.max(0, v.currentTime + delta), v.duration || 0)
    setCurrentTime(v.currentTime)
  }

  const togglePlay = async () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      await v.play()
      setIsPlaying(true)
    } else {
      v.pause()
      setIsPlaying(false)
    }
  }

  const markTip = async (event) => {
    if (!markMode || !canvasRef.current || !bout) return
    const rect = canvasRef.current.getBoundingClientRect()
    const x = (event.clientX - rect.left) / rect.width
    const y = (event.clientY - rect.top) / rect.height

    const marks = [
      {
        fencer: markFencer,
        video_time_seconds: videoRef.current.currentTime,
        x_norm: Math.min(1, Math.max(0, x)),
        y_norm: Math.min(1, Math.max(0, y)),
      },
    ]

    const res = await api(`/api/bouts/${bout.id}/tip-marks`, {
      method: 'POST',
      body: JSON.stringify({ marks }),
    })

    setBout((prev) => ({ ...prev, tip_marks: res.tip_marks }))
  }

  const clearTrail = async () => {
    if (!bout) return
    const res = await api(`/api/bouts/${bout.id}/tip-marks?fencer=${markFencer}`, { method: 'DELETE' })
    setBout((prev) => ({ ...prev, tip_marks: res.tip_marks }))
  }

  const touchScore = useMemo(() => {
    if (!bout) return { left: 0, right: 0 }
    return {
      left: bout.touches.filter((t) => t.scorer === 'left').length,
      right: bout.touches.filter((t) => t.scorer === 'right').length,
    }
  }, [bout])

  const runAiRowSuggestion = () => {
    if (!bout || bout.weapon === 'epee') {
      setPanelError('AI ROW tracking currently supports foil/sabre. For epee, use scorer and double-touch controls.')
      return
    }

    setAiRowRunning(true)
    setPanelError('')
    try {
      const suggestion = estimateAiRowFromTrail({
        bout,
        time: Number(videoRef.current?.currentTime ?? currentTime),
      })

      if (suggestion.error) {
        setPanelError(suggestion.error)
        return
      }

      setAiRowSuggestion(suggestion)
      setAnswers((prev) => ({ ...prev, ...suggestion.answers }))
    } finally {
      setAiRowRunning(false)
    }
  }

  const applyAiRowSuggestion = () => {
    if (!aiRowSuggestion?.answers) return
    setAnswers((prev) => ({ ...prev, ...aiRowSuggestion.answers }))
  }

  const saveTouch = async (override = null) => {
    if (!bout || !videoRef.current || touchSaving) return

    const row = evaluateRow(bout.weapon, answers)
    const scorer = override?.scorer ?? row.scorer
    const verdict = override?.verdict ?? row.verdict
    const awardTime = videoRef.current.currentTime
    const touchTime = Math.max(0, awardTime - preTouchSeconds)

    setTouchSaving(true)
    setPanelError('')
    try {
      const res = await api(`/api/bouts/${bout.id}/touches`, {
        method: 'POST',
        body: JSON.stringify({
          video_time_seconds: touchTime,
          scorer,
          row_verdict: verdict,
          note: noteDraft,
        }),
      })

      let nextTipMarks = bout.tip_marks
      if (scorer === 'left' || scorer === 'right') {
        const latestMark = [...bout.tip_marks]
          .filter((m) => m.fencer === scorer && m.video_time_seconds <= awardTime)
          .sort((a, b) => b.video_time_seconds - a.video_time_seconds)[0]

        if (latestMark && touchTime < awardTime) {
          const markRes = await api(`/api/bouts/${bout.id}/tip-marks`, {
            method: 'POST',
            body: JSON.stringify({
              marks: [
                {
                  fencer: scorer,
                  video_time_seconds: touchTime,
                  x_norm: latestMark.x_norm,
                  y_norm: latestMark.y_norm,
                },
              ],
            }),
          })
          nextTipMarks = markRes.tip_marks
        }
      }

      setBout((prev) => ({ ...prev, touches: [...prev.touches, res.touch], tip_marks: nextTipMarks }))
      setNoteDraft('')
      setActiveTab('touches')
    } catch (err) {
      setPanelError(err.message || 'Could not save touch')
    } finally {
      setTouchSaving(false)
    }
  }

  const undoLastTouch = async () => {
    if (!bout?.touches?.length || touchSaving) return
    const last = [...bout.touches].sort((a, b) => b.id - a.id)[0]
    await api(`/api/touches/${last.id}`, { method: 'DELETE' })
    await loadBout()
  }

  const startEditTouch = (touch) => {
    setEditingTouchId(touch.id)
    setEditTouchDraft({
      video_time_seconds: Number(touch.video_time_seconds) || 0,
      scorer: touch.scorer || 'none',
      row_verdict: touch.row_verdict || '',
      note: touch.note || '',
    })
  }

  const saveEditedTouch = async (touchId) => {
    if (!bout) return
    setTouchSaving(true)
    setPanelError('')

    try {
      const res = await api(`/api/touches/${touchId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          video_time_seconds: Number(editTouchDraft.video_time_seconds),
          scorer: editTouchDraft.scorer,
          row_verdict: editTouchDraft.row_verdict,
          note: editTouchDraft.note,
        }),
      })

      setBout((prev) => ({
        ...prev,
        touches: prev.touches.map((touch) => (touch.id === touchId ? res.touch : touch)),
      }))
      setEditingTouchId(null)
    } catch (err) {
      setPanelError(err.message || 'Could not edit touch')
    } finally {
      setTouchSaving(false)
    }
  }

  const deleteTouch = async (touchId) => {
    if (!bout || touchSaving) return
    setTouchSaving(true)
    setPanelError('')
    try {
      await api(`/api/touches/${touchId}`, { method: 'DELETE' })
      setBout((prev) => ({
        ...prev,
        touches: prev.touches.filter((touch) => touch.id !== touchId),
      }))
      if (editingTouchId === touchId) {
        setEditingTouchId(null)
      }
    } catch (err) {
      setPanelError(err.message || 'Could not delete touch')
    } finally {
      setTouchSaving(false)
    }
  }

  const runAiScoreTracking = async () => {
    if (!bout || aiScanning || aiApplying) return
    setPanelError('')
    setAiScanning(true)
    setAiProgress(0)

    try {
      const predictions = await detectAiScoreTimeline({
        videoUrl: bout.video_url,
        leftRegion: aiRegions.left,
        rightRegion: aiRegions.right,
        sampleInterval: Number(aiConfig.sampleInterval),
        sensitivity: Number(aiConfig.sensitivity),
        cooldown: Number(aiConfig.cooldown),
        onProgress: setAiProgress,
      })
      setAiPredictedTouches(predictions)
      setActiveTab('ai')
    } catch (err) {
      setPanelError(err.message || 'AI score tracking failed. Try adjusting the light regions and rerun.')
    } finally {
      setAiScanning(false)
      setAiProgress(100)
    }
  }

  const applyAiTouchesToBout = async () => {
    if (!bout || !aiPredictedTouches.length || aiApplying) return
    setAiApplying(true)
    setPanelError('')

    try {
      const sorted = [...aiPredictedTouches].sort((a, b) => a.time - b.time)
      for (const touch of sorted) {
        await api(`/api/bouts/${bout.id}/touches`, {
          method: 'POST',
          body: JSON.stringify({
            video_time_seconds: clamp(Number(touch.time) || 0, 0, videoRef.current?.duration || Number.MAX_SAFE_INTEGER),
            scorer: touch.scorer,
            row_verdict: touch.verdict || `AI DETECTED ${String(touch.scorer || 'none').toUpperCase()} TOUCH`,
            note: touch.note || 'AI score tracking prediction',
          }),
        })
      }

      await loadBout()
      setAiPredictedTouches([])
      setActiveTab('touches')
    } catch (err) {
      setPanelError(err.message || 'Failed to apply AI touches')
    } finally {
      setAiApplying(false)
    }
  }

  useEffect(() => {
    if (!autoRowTracking || !bout || bout.weapon === 'epee') return

    const suggestion = estimateAiRowFromTrail({
      bout,
      time: Number(currentTime),
    })

    if (!suggestion.error) {
      setAiRowSuggestion(suggestion)
      setAnswers((prev) => ({ ...prev, ...suggestion.answers }))
    }
  }, [autoRowTracking, bout, currentTime])

  useEffect(() => {
    const onKeyDown = (event) => {
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.repeat) return

      if (event.key === '1') {
        event.preventDefault()
        saveTouch({ scorer: 'left', verdict: 'POINT LEFT (QUICK ADD)' })
      } else if (event.key === '2') {
        event.preventDefault()
        saveTouch({ scorer: 'right', verdict: 'POINT RIGHT (QUICK ADD)' })
      } else if (event.key === '0') {
        event.preventDefault()
        saveTouch({ scorer: 'none', verdict: 'NO TOUCH (QUICK ADD)' })
      } else if (event.key.toLowerCase() === 'u') {
        event.preventDefault()
        undoLastTouch()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saveTouch, undoLastTouch])

  if (!bout) return <div className="text-slate-400">Loading bout...</div>

  const frameNumber = Math.floor(currentTime * fps)
  const rowResult = evaluateRow(bout.weapon, answers)

  return (
    <section className="grid lg:grid-cols-10 gap-4">
      <div className="lg:col-span-7 space-y-3">
        <div className="glass p-3">
          <div className="relative" onClick={markTip}>
            <video
              ref={videoRef}
              src={bout.video_url}
              className="w-full rounded-lg bg-black"
              onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
            />
            <canvas ref={canvasRef} className="absolute inset-0 rounded-lg cursor-crosshair" />
          </div>
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap gap-2 items-center">
              <button className="btn-ghost" onClick={togglePlay}>{isPlaying ? <Pause size={16} /> : <Play size={16} />}</button>
              <button className="btn-ghost" onClick={() => step(-1 / fps)}><SkipBack size={16} /> frame</button>
              <button className="btn-ghost" onClick={() => step(1 / fps)}><SkipForward size={16} /> frame</button>
              <button className="btn-ghost" onClick={() => step(-0.1)}><Rewind size={16} /> 0.1s</button>
              <button className="btn-ghost" onClick={() => step(0.1)}><FastForward size={16} /> 0.1s</button>
              <button className="btn-ghost" onClick={() => step(-1)}>-1s</button>
              <button className="btn-ghost" onClick={() => step(1)}>+1s</button>
              <label className="text-sm flex items-center gap-2">
                Speed
                <input type="range" min="0.1" max="2" step="0.1" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
                {speed.toFixed(1)}x
              </label>
            </div>
            <input
              type="range"
              min="0"
              max={videoRef.current?.duration || 0}
              step="0.01"
              value={currentTime}
              onChange={(e) => {
                const v = Number(e.target.value)
                videoRef.current.currentTime = v
                setCurrentTime(v)
              }}
              className="w-full"
            />
            <div className="text-sm text-slate-400 flex justify-between">
              <span>Frame #{frameNumber}</span>
              <span>{formatClock(currentTime)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="lg:col-span-3">
        <div className="glass p-3 space-y-3 sticky top-20">
          <div className="flex flex-wrap gap-2 text-sm">
            {[
              ['row', 'ROW Assistant'],
              ['trail', 'Tip Trail'],
              ['touches', 'Touches'],
              ['ai', 'AI Score'],
              ['notes', 'Notes'],
            ].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`px-2 py-1 rounded ${activeTab === key ? 'bg-slate-100 text-slate-900' : 'bg-slate-800'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {panelError ? (
            <p className="text-xs text-red-300 bg-red-500/10 border border-red-500/40 rounded p-2">{panelError}</p>
          ) : null}

          {activeTab === 'row' && (
            <div className="space-y-3 text-sm">
              <h3 className="font-semibold">ROW Assistant ({bout.weapon.toUpperCase()})</h3>

              <div className="grid grid-cols-1 gap-2">
                <button className="btn-primary" onClick={runAiRowSuggestion} disabled={aiRowRunning || touchSaving}>
                  {aiRowRunning ? (
                    <span className="inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Tracking ROW...</span>
                  ) : (
                    <span className="inline-flex items-center gap-2"><Sparkles size={14} /> AI Suggest ROW at Playhead</span>
                  )}
                </button>

                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={autoRowTracking}
                    onChange={(e) => setAutoRowTracking(e.target.checked)}
                    disabled={bout.weapon === 'epee'}
                  />
                  Auto-track ROW while scrubbing (foil/sabre)
                </label>

                {aiRowSuggestion?.row ? (
                  <div className="bg-slate-900/50 border border-slate-700 rounded p-2 text-xs space-y-1">
                    <p className="text-slate-200">AI verdict: <span className="font-semibold">{aiRowSuggestion.row.verdict}</span></p>
                    <p className="text-slate-400">Confidence: {Math.round((aiRowSuggestion.confidence || 0) * 100)}% • Marks L/R: {aiRowSuggestion.metrics?.left_marks || 0}/{aiRowSuggestion.metrics?.right_marks || 0}</p>
                    {aiRowSuggestion.reasons?.length ? (
                      <ul className="list-disc pl-4 text-slate-400 space-y-1">
                        {aiRowSuggestion.reasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    ) : null}
                    <div>
                      <button type="button" className="btn-ghost text-xs" onClick={applyAiRowSuggestion}>Use AI Answers</button>
                    </div>
                  </div>
                ) : null}
              </div>

              {bout.weapon === 'epee' ? (
                <>
                  <p className="text-slate-400">Épée has no right-of-way. Record scorer (or double-touch).</p>
                  <select
                    className="w-full bg-slate-900 border border-slate-700 rounded p-2"
                    value={answers.epeeScorer || 'left'}
                    onChange={(e) => setAnswers((p) => ({ ...p, epeeScorer: e.target.value }))}
                  >
                    <option value="left">Left scores</option>
                    <option value="right">Right scores</option>
                    <option value="none">No touch</option>
                  </select>
                  <label className="flex gap-2 items-center">
                    <input
                      type="checkbox"
                      checked={!!answers.epeeDoubleTouch}
                      onChange={(e) => setAnswers((p) => ({ ...p, epeeDoubleTouch: e.target.checked }))}
                    />
                    Double touch window (40-50ms)
                  </label>
                </>
              ) : (
                <>
                  <label className="block">
                    <span className="text-slate-300">1) Attack established?</span>
                    <select
                      className="w-full bg-slate-900 border border-slate-700 rounded p-2 mt-1"
                      value={answers.step1AttackEstablished}
                      onChange={(e) => setAnswers((p) => ({ ...p, step1AttackEstablished: e.target.value }))}
                    >
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                    <p className="text-xs text-slate-400 mt-1">{rowHints.step1}</p>
                  </label>

                  {answers.step1AttackEstablished === 'yes' ? (
                    <>
                      <label className="block">
                        <span>Who initiated?</span>
                        <select
                          className="w-full bg-slate-900 border border-slate-700 rounded p-2 mt-1"
                          value={answers.step1Initiator}
                          onChange={(e) => setAnswers((p) => ({ ...p, step1Initiator: e.target.value }))}
                        >
                          <option value="left">Left</option>
                          <option value="right">Right</option>
                          <option value="both">Both at same time</option>
                        </select>
                      </label>

                      {answers.step1Initiator !== 'both' && (
                        <>
                          <label className="block">
                            <span>2) Landed without parry?</span>
                            <select
                              className="w-full bg-slate-900 border border-slate-700 rounded p-2 mt-1"
                              value={answers.step2LandedNoParry || 'yes'}
                              onChange={(e) => setAnswers((p) => ({ ...p, step2LandedNoParry: e.target.value }))}
                            >
                              <option value="yes">Yes</option>
                              <option value="no">No</option>
                            </select>
                            <p className="text-xs text-slate-400 mt-1">{rowHints.step2}</p>
                          </label>

                          {(answers.step2LandedNoParry || 'yes') === 'no' && (
                            <>
                              <label className="block">
                                <span>3) Successful parry?</span>
                                <select
                                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 mt-1"
                                  value={answers.step3SuccessfulParry || 'yes'}
                                  onChange={(e) => setAnswers((p) => ({ ...p, step3SuccessfulParry: e.target.value }))}
                                >
                                  <option value="yes">Yes</option>
                                  <option value="no">No</option>
                                </select>
                                <p className="text-xs text-slate-400 mt-1">{rowHints.step3}</p>
                              </label>

                              {(answers.step3SuccessfulParry || 'yes') === 'yes' ? (
                                <label className="block">
                                  <span>4) Immediate riposte?</span>
                                  <select
                                    className="w-full bg-slate-900 border border-slate-700 rounded p-2 mt-1"
                                    value={answers.step4RiposteImmediate || 'yes'}
                                    onChange={(e) => setAnswers((p) => ({ ...p, step4RiposteImmediate: e.target.value }))}
                                  >
                                    <option value="yes">Yes</option>
                                    <option value="no">No</option>
                                  </select>
                                  <p className="text-xs text-slate-400 mt-1">{rowHints.step4}</p>
                                </label>
                              ) : (
                                <label className="block">
                                  <span>Did defender then attack?</span>
                                  <select
                                    className="w-full bg-slate-900 border border-slate-700 rounded p-2 mt-1"
                                    value={answers.step3DefenderThenAttack || 'yes'}
                                    onChange={(e) => setAnswers((p) => ({ ...p, step3DefenderThenAttack: e.target.value }))}
                                  >
                                    <option value="yes">Yes</option>
                                    <option value="no">No</option>
                                  </select>
                                </label>
                              )}

                              {(answers.step4RiposteImmediate || 'yes') === 'no' &&
                                (answers.step3SuccessfulParry || 'yes') === 'yes' && (
                                  <label className="block">
                                    <span>Did original attacker remise and land first?</span>
                                    <select
                                      className="w-full bg-slate-900 border border-slate-700 rounded p-2 mt-1"
                                      value={answers.step4OriginalAttackerRemise || 'yes'}
                                      onChange={(e) =>
                                        setAnswers((p) => ({ ...p, step4OriginalAttackerRemise: e.target.value }))
                                      }
                                    >
                                      <option value="yes">Yes</option>
                                      <option value="no">No</option>
                                    </select>
                                  </label>
                                )}
                            </>
                          )}
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <label className="block">
                        <span>Did both lights go off?</span>
                        <select
                          className="w-full bg-slate-900 border border-slate-700 rounded p-2 mt-1"
                          value={answers.step1BothLights || 'yes'}
                          onChange={(e) => setAnswers((p) => ({ ...p, step1BothLights: e.target.value }))}
                        >
                          <option value="yes">Yes</option>
                          <option value="no">No</option>
                        </select>
                      </label>
                      {(answers.step1BothLights || 'yes') === 'no' && (
                        <label className="block">
                          <span>Single light scorer</span>
                          <select
                            className="w-full bg-slate-900 border border-slate-700 rounded p-2 mt-1"
                            value={answers.step1SingleLightScorer || 'left'}
                            onChange={(e) => setAnswers((p) => ({ ...p, step1SingleLightScorer: e.target.value }))}
                          >
                            <option value="left">Left</option>
                            <option value="right">Right</option>
                            <option value="none">None</option>
                          </select>
                        </label>
                      )}
                    </>
                  )}
                </>
              )}

              <div className="glass p-2 text-xs space-y-2">
                <div>
                  Final verdict: <span className="font-semibold">{rowResult.verdict}</span>
                </div>
                <label className="flex items-center justify-between gap-2">
                  <span>AI pre-point trail offset</span>
                  <select
                    value={String(preTouchSeconds)}
                    onChange={(e) => setPreTouchSeconds(Number(e.target.value))}
                    className="bg-slate-900 border border-slate-700 rounded px-2 py-1"
                  >
                    <option value="0">0s (none)</option>
                    <option value="1">1.0s</option>
                    <option value="1.5">1.5s</option>
                  </select>
                </label>
                <div className="flex gap-2">
                  <button type="button" className="btn-ghost text-xs" onClick={saveOffsetAsDefault}>
                    Save as default
                  </button>
                  <button type="button" className="btn-ghost text-xs" onClick={resetOffsetDefault}>
                    Reset default
                  </button>
                </div>
                {defaultOffsetSaved ? <p className="text-emerald-300">Default offset saved.</p> : null}
                <p className="text-slate-400">
                  Touch is saved at <span className="font-medium">{formatClock(Math.max(0, currentTime - preTouchSeconds))}</span> while award moment is {formatClock(currentTime)}.
                </p>
              </div>

              <button className="btn-primary w-full" onClick={() => saveTouch()} disabled={touchSaving}>
                {touchSaving ? 'Saving touch...' : 'Record ROW Touch'}
              </button>

              <div className="grid grid-cols-3 gap-2">
                <button
                  className="btn-ghost border border-red-500/30"
                  onClick={() => saveTouch({ scorer: 'left', verdict: 'POINT LEFT (QUICK ADD)' })}
                  disabled={touchSaving}
                >
                  Left +1
                </button>
                <button
                  className="btn-ghost border border-green-500/30"
                  onClick={() => saveTouch({ scorer: 'right', verdict: 'POINT RIGHT (QUICK ADD)' })}
                  disabled={touchSaving}
                >
                  Right +1
                </button>
                <button
                  className="btn-ghost"
                  onClick={() => saveTouch({ scorer: 'none', verdict: 'NO TOUCH (QUICK ADD)' })}
                  disabled={touchSaving}
                >
                  No Touch
                </button>
              </div>

              <p className="text-xs text-slate-400">Hotkeys: 1=Left, 2=Right, 0=No Touch, U=Undo</p>
            </div>
          )}

          {activeTab === 'trail' && (
            <div className="space-y-3 text-sm">
              <h3 className="font-semibold">Tip Trail</h3>
              <label className="block">
                Fencer
                <select
                  value={markFencer}
                  onChange={(e) => setMarkFencer(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 mt-1"
                >
                  <option value="left">Left (red)</option>
                  <option value="right">Right (green)</option>
                </select>
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={markMode} onChange={(e) => setMarkMode(e.target.checked)} />
                Mark Tip mode
              </label>
              <label className="block">
                Trail fade (s)
                <input
                  type="range"
                  min="0.3"
                  max="5"
                  step="0.1"
                  value={fadeSeconds}
                  onChange={(e) => setFadeSeconds(Number(e.target.value))}
                  className="w-full"
                />
              </label>
              <button className="btn-ghost" onClick={clearTrail}><Trash2 size={16} /> Clear Trail</button>
            </div>
          )}

          {activeTab === 'touches' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-center">
                <div className="rounded-lg bg-red-500/20 p-3">
                  <div className="text-xs text-red-200">{bout.left_name}</div>
                  <div className="text-3xl font-bold text-red-300">{touchScore.left}</div>
                </div>
                <div className="rounded-lg bg-green-500/20 p-3">
                  <div className="text-xs text-green-200">{bout.right_name}</div>
                  <div className="text-3xl font-bold text-green-300">{touchScore.right}</div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <button
                  className="btn-ghost border border-red-500/30"
                  onClick={() => saveTouch({ scorer: 'left', verdict: 'POINT LEFT (QUICK ADD)' })}
                  disabled={touchSaving}
                >
                  Left +1
                </button>
                <button
                  className="btn-ghost border border-green-500/30"
                  onClick={() => saveTouch({ scorer: 'right', verdict: 'POINT RIGHT (QUICK ADD)' })}
                  disabled={touchSaving}
                >
                  Right +1
                </button>
                <button
                  className="btn-ghost"
                  onClick={() => saveTouch({ scorer: 'none', verdict: 'NO TOUCH (QUICK ADD)' })}
                  disabled={touchSaving}
                >
                  No Touch
                </button>
              </div>
              <p className="text-xs text-slate-400">Touch timing offset: {preTouchSeconds}s before current playhead</p>
              <button className="btn-ghost" onClick={undoLastTouch} disabled={touchSaving}><Undo2 size={16} /> Undo last touch</button>
              <div className="max-h-80 overflow-auto text-xs space-y-2">
                {bout.touches.length === 0 ? (
                  <p className="text-slate-400">No touches recorded yet.</p>
                ) : (
                  bout.touches
                    .slice()
                    .sort((a, b) => a.video_time_seconds - b.video_time_seconds)
                    .map((t) => {
                      const isEditing = editingTouchId === t.id
                      return (
                        <div key={t.id} className="border border-slate-700 rounded p-2 space-y-2">
                          {!isEditing ? (
                            <>
                              <div className="flex justify-between text-slate-300">
                                <span>{formatClock(t.video_time_seconds)}</span>
                                <span>{t.scorer.toUpperCase()}</span>
                              </div>
                              <p className="text-slate-400">{t.row_verdict || '—'} • {bout.weapon.toUpperCase()}</p>
                              {t.note ? <p className="text-slate-500">{t.note}</p> : null}
                              <div className="flex gap-2">
                                <button className="btn-ghost" onClick={() => startEditTouch(t)} disabled={touchSaving}>
                                  <Pencil size={14} /> Edit
                                </button>
                                <button className="btn-ghost" onClick={() => deleteTouch(t.id)} disabled={touchSaving}>
                                  <Trash2 size={14} /> Delete
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="grid grid-cols-2 gap-2">
                                <label className="space-y-1">
                                  <span>Time (s)</span>
                                  <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={editTouchDraft.video_time_seconds}
                                    onChange={(e) => setEditTouchDraft((prev) => ({ ...prev, video_time_seconds: e.target.value }))}
                                    className="w-full rounded bg-slate-900 border border-slate-700 px-2 py-1"
                                  />
                                </label>
                                <label className="space-y-1">
                                  <span>Scorer</span>
                                  <select
                                    value={editTouchDraft.scorer}
                                    onChange={(e) => setEditTouchDraft((prev) => ({ ...prev, scorer: e.target.value }))}
                                    className="w-full rounded bg-slate-900 border border-slate-700 px-2 py-1"
                                  >
                                    <option value="left">Left</option>
                                    <option value="right">Right</option>
                                    <option value="none">None</option>
                                  </select>
                                </label>
                              </div>
                              <label className="space-y-1 block">
                                <span>Verdict</span>
                                <input
                                  value={editTouchDraft.row_verdict}
                                  onChange={(e) => setEditTouchDraft((prev) => ({ ...prev, row_verdict: e.target.value }))}
                                  className="w-full rounded bg-slate-900 border border-slate-700 px-2 py-1"
                                />
                              </label>
                              <label className="space-y-1 block">
                                <span>Note</span>
                                <input
                                  value={editTouchDraft.note}
                                  onChange={(e) => setEditTouchDraft((prev) => ({ ...prev, note: e.target.value }))}
                                  className="w-full rounded bg-slate-900 border border-slate-700 px-2 py-1"
                                />
                              </label>
                              <div className="flex gap-2">
                                <button className="btn-ghost" onClick={() => saveEditedTouch(t.id)} disabled={touchSaving}>
                                  <Check size={14} /> Save
                                </button>
                                <button className="btn-ghost" onClick={() => setEditingTouchId(null)} disabled={touchSaving}>
                                  <X size={14} /> Cancel
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      )
                    })
                )}
              </div>
            </div>
          )}

          {activeTab === 'ai' && (
            <div className="space-y-3 text-sm">
              <h3 className="font-semibold">AI Score Tracking (Best Effort)</h3>
              <p className="text-slate-400">
                The model scans likely red/green light regions over time, predicts touches, then lets you edit before applying.
              </p>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <label className="space-y-1">
                  <span>Sample interval (s)</span>
                  <input
                    type="number"
                    min="0.04"
                    max="0.5"
                    step="0.01"
                    value={aiConfig.sampleInterval}
                    onChange={(e) => setAiConfig((prev) => ({ ...prev, sampleInterval: Number(e.target.value) }))}
                    className="w-full rounded bg-slate-900 border border-slate-700 px-2 py-1"
                  />
                </label>
                <label className="space-y-1">
                  <span>Cooldown (s)</span>
                  <input
                    type="number"
                    min="0.2"
                    max="2"
                    step="0.1"
                    value={aiConfig.cooldown}
                    onChange={(e) => setAiConfig((prev) => ({ ...prev, cooldown: Number(e.target.value) }))}
                    className="w-full rounded bg-slate-900 border border-slate-700 px-2 py-1"
                  />
                </label>
                <label className="space-y-1 col-span-2">
                  <span>Sensitivity (higher = fewer detections)</span>
                  <input
                    type="range"
                    min="1.2"
                    max="4"
                    step="0.1"
                    value={aiConfig.sensitivity}
                    onChange={(e) => setAiConfig((prev) => ({ ...prev, sensitivity: Number(e.target.value) }))}
                    className="w-full"
                  />
                  <p className="text-slate-400">{aiConfig.sensitivity.toFixed(1)}</p>
                </label>
              </div>

              <div className="border border-slate-700 rounded p-2 space-y-2 text-xs">
                <p className="font-medium">Left light region (x, y, w, h)</p>
                <div className="grid grid-cols-4 gap-1">
                  {['x', 'y', 'w', 'h'].map((field) => (
                    <input
                      key={`left-${field}`}
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                      value={aiRegions.left[field]}
                      onChange={(e) =>
                        setAiRegions((prev) => ({
                          ...prev,
                          left: { ...prev.left, [field]: clamp(Number(e.target.value), 0, 1) },
                        }))
                      }
                      className="rounded bg-slate-900 border border-slate-700 px-1 py-1"
                    />
                  ))}
                </div>
              </div>

              <div className="border border-slate-700 rounded p-2 space-y-2 text-xs">
                <p className="font-medium">Right light region (x, y, w, h)</p>
                <div className="grid grid-cols-4 gap-1">
                  {['x', 'y', 'w', 'h'].map((field) => (
                    <input
                      key={`right-${field}`}
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                      value={aiRegions.right[field]}
                      onChange={(e) =>
                        setAiRegions((prev) => ({
                          ...prev,
                          right: { ...prev.right, [field]: clamp(Number(e.target.value), 0, 1) },
                        }))
                      }
                      className="rounded bg-slate-900 border border-slate-700 px-1 py-1"
                    />
                  ))}
                </div>
              </div>

              <button className="btn-primary w-full" onClick={runAiScoreTracking} disabled={aiScanning || aiApplying}>
                {aiScanning ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 size={16} className="animate-spin" /> Scanning video... {aiProgress}%
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-2">
                    <Sparkles size={16} /> Run AI Score Tracking
                  </span>
                )}
              </button>

              {aiPredictedTouches.length > 0 ? (
                <>
                  <div className="flex items-center justify-between text-xs">
                    <p className="text-slate-300">Predicted touches: {aiPredictedTouches.length}</p>
                    <button className="btn-ghost" onClick={() => setAiPredictedTouches([])} disabled={aiApplying}>
                      Clear
                    </button>
                  </div>
                  <div className="max-h-64 overflow-auto space-y-2">
                    {aiPredictedTouches
                      .slice()
                      .sort((a, b) => a.time - b.time)
                      .map((touch) => (
                        <div key={touch.id} className="border border-slate-700 rounded p-2 space-y-2 text-xs">
                          <div className="grid grid-cols-2 gap-2">
                            <label className="space-y-1">
                              <span>Time (s)</span>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={touch.time}
                                onChange={(e) => {
                                  const value = Number(e.target.value)
                                  setAiPredictedTouches((prev) =>
                                    prev.map((item) => (item.id === touch.id ? { ...item, time: value } : item))
                                  )
                                }}
                                className="w-full rounded bg-slate-900 border border-slate-700 px-2 py-1"
                              />
                            </label>
                            <label className="space-y-1">
                              <span>Scorer</span>
                              <select
                                value={touch.scorer}
                                onChange={(e) => {
                                  const scorer = e.target.value
                                  setAiPredictedTouches((prev) =>
                                    prev.map((item) =>
                                      item.id === touch.id
                                        ? {
                                            ...item,
                                            scorer,
                                            verdict: `AI DETECTED ${scorer.toUpperCase()} TOUCH`,
                                          }
                                        : item
                                    )
                                  )
                                }}
                                className="w-full rounded bg-slate-900 border border-slate-700 px-2 py-1"
                              >
                                <option value="left">Left</option>
                                <option value="right">Right</option>
                                <option value="none">None / simultaneous</option>
                              </select>
                            </label>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-slate-400">{formatClock(Number(touch.time) || 0)} • {(touch.confidence * 100).toFixed(0)}%</span>
                            <button
                              className="btn-ghost"
                              onClick={() =>
                                setAiPredictedTouches((prev) => prev.filter((item) => item.id !== touch.id))
                              }
                              disabled={aiApplying}
                            >
                              <Trash2 size={14} /> Remove
                            </button>
                          </div>
                        </div>
                      ))}
                  </div>
                  <button className="btn-primary w-full" onClick={applyAiTouchesToBout} disabled={aiApplying}>
                    {aiApplying ? 'Applying predicted touches...' : 'Apply Predicted Touches to Bout'}
                  </button>
                </>
              ) : (
                <p className="text-xs text-slate-400">No AI predictions yet. Tune regions/sensitivity and run scan.</p>
              )}
            </div>
          )}

          {activeTab === 'notes' && (
            <div className="space-y-3 text-sm">
              <h3 className="font-semibold">Touch Note</h3>
              <p className="text-slate-400">Add this note before pressing “Record Touch” in ROW Assistant.</p>
              <textarea
                rows={6}
                className="w-full rounded-lg bg-slate-900 border border-slate-700 p-2"
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="e.g. late counterattack after failed riposte"
              />
              <button className="btn-ghost" onClick={() => setActiveTab('row')}>
                <PenLine size={16} /> Back to ROW Assistant
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
