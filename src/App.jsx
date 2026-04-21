import Home from './pages/Home.jsx'
import { useEffect, useState } from 'react'
import './App.css'

function App() {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(max-width: 760px)').matches
  })
  const [showSplash, setShowSplash] = useState(() => isMobile)

  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia('(max-width: 760px)')

    function onChange(e) {
      setIsMobile(e.matches)
      // If user resizes into mobile, show splash once.
      if (e.matches) setShowSplash(true)
    }

    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])

  useEffect(() => {
    if (!showSplash) return
    const t = window.setTimeout(() => setShowSplash(false), 900)
    return () => window.clearTimeout(t)
  }, [showSplash])

  return (
    <>
      {isMobile && showSplash ? <SplashScreen /> : null}
      <Home />
    </>
  )
}

export default App

function SplashScreen() {
  return (
    <div className="splash" aria-label="Launching">
      <div className="splash-card" role="status" aria-live="polite">
        <div className="splash-logo" aria-label="IPL Contest">
          <span className="splash-logo-accent">IPL</span>
          <span className="splash-logo-rest">Contest</span>
        </div>
        <div className="splash-sub">
          Loading <span className="splash-dots" aria-hidden="true" />
        </div>
      </div>
    </div>
  )
}
