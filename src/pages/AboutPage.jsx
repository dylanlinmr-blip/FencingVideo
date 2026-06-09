import { motion } from 'framer-motion'

export default function AboutPage() {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass p-6 space-y-4"
    >
      <h1 className="text-2xl font-bold">About FenceVision</h1>
      <p className="text-slate-300">
        FenceVision is a full-stack fencing video analysis workspace built for replay study, touch logging,
        right-of-way guidance, and weapon-tip trajectory tracking.
      </p>
      <ul className="list-disc ml-6 text-slate-300 space-y-2">
        <li>Upload MP4/WEBM/MOV bouts and keep a persistent library.</li>
        <li>Use frame-level controls with timeline scrub and speed tuning.</li>
        <li>Guide foil/sabre right-of-way decisions with official-rule hints.</li>
        <li>Track left/right tip trails and maintain score + touch logs.</li>
      </ul>
    </motion.section>
  )
}
