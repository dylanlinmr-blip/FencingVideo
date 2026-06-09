import { Routes, Route } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import NavBar from './components/NavBar'
import BoutsPage from './pages/BoutsPage'
import UploadPage from './pages/UploadPage'
import AnalyzerPage from './pages/AnalyzerPage'
import AboutPage from './pages/AboutPage'

export default function App() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-bg to-black">
      <NavBar />
      <main className="max-w-7xl mx-auto p-4 md:p-6">
        <AnimatePresence mode="wait">
          <Routes>
            <Route path="/" element={<BoutsPage />} />
            <Route path="/upload" element={<UploadPage />} />
            <Route path="/analyzer/:id" element={<AnalyzerPage />} />
            <Route path="/about" element={<AboutPage />} />
          </Routes>
        </AnimatePresence>
      </main>
    </div>
  )
}
