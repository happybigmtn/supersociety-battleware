import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { getVaultRecord, getVaultStatusSync } from './security/keyVault'

// Best-effort: if a vault exists, set the localStorage marker so the app
// can require passkey unlock before generating legacy keys.
try {
  const { supported } = getVaultStatusSync()
  if (supported) {
    getVaultRecord()
      .then((record) => {
        if (record) {
          localStorage.setItem('nullspace_vault_enabled', 'true')
          localStorage.setItem('casino_public_key_hex', record.nullspacePublicKeyHex)
        }
      })
      .catch(() => {
        // ignore
      })
  }
} catch {
  // ignore
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
