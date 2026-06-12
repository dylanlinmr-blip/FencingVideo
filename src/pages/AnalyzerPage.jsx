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
} from 'lucide-react'
import { api, formatClock } from '../lib/api'
import { evaluateRow, rowHints } from '../lib/rowDecision'

const fps = 30
const PRE_TOUCH_OFFSET_KEY = 'fencevision.preTouchOffsetSeconds'

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

  const saveTouch = async (override = null) => {
    if (!bout || !videoRef.current || touchSaving) return

    const row = evaluateRow(bout.weapon, answers)
    const scorer = override?.scorer ?? row.scorer
    const verdict = override?.verdict ?? row.verdict
    const awardTime = videoRef.current.currentTime
    const touchTime = Math.max(0, awardTime - preTouchSeconds)

    setTouchSaving(true)
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

  useEffect(() => {
    const onKeyDown = (event) => {
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.repeat) return

      if (event.key === '1') {
        event.preventDefault()
        saveTouch({ scorer: 'left', verdict: `POINT LEFT (QUICK ADD)` })
      } else if (event.key === '2') {
        event.preventDefault()
        saveTouch({ scorer: 'right', verdict: `POINT RIGHT (QUICK ADD)` })
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

          {activeTab === 'row' && (
            <div className="space-y-3 text-sm">
              <h3 className="font-semibold">ROW Assistant ({bout.weapon.toUpperCase()})</h3>
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
                    .map((t) => (
                      <div key={t.id} className="border border-slate-700 rounded p-2">
                        <div className="flex justify-between text-slate-300">
                          <span>{formatClock(t.video_time_seconds)}</span>
                          <span>{t.scorer.toUpperCase()}</span>
                        </div>
                        <p className="text-slate-400">{t.row_verdict || '—'} • {bout.weapon.toUpperCase()}</p>
                        {t.note ? <p className="text-slate-500">{t.note}</p> : null}
                      </div>
                    ))
                )}
              </div>
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
