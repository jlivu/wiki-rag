import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import { applyTheme, readPanelParams } from './lib/params'
import './styles.css'

const params = readPanelParams()
applyTheme(params.theme)

const container = document.getElementById('root')
if (!container) {
  throw new Error('the panel has no #root element')
}

createRoot(container).render(
  <StrictMode>
    <App params={params} />
  </StrictMode>
)
