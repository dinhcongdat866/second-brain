import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import App from './App.tsx'
import { AuthGate } from './components/AuthGate.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { initAuth } from './stores/authStore.ts'

// Bootstrap Supabase session before first render
initAuth();

// Ask the browser to make IndexedDB storage persistent (resist eviction).
// Honored by Chrome/Firefox; Safari ignores it — there the Neon backend is the
// real durability guarantee (see backendSync save flow).
if (navigator.storage?.persist) {
  navigator.storage.persist().catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthGate>
        <App />
      </AuthGate>
    </ErrorBoundary>
  </StrictMode>,
)
