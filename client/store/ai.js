import { make } from 'vuex-pathify'

// Remember whether the assistant panel is open for the rest of the browser
// tab's session, so it stays open when the next wiki page loads.
const STORAGE_KEY = 'wiki-ai-panel-open'

function readPanelOpen () {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) === 'true'
  } catch (err) {
    return false
  }
}

const state = {
  panelOpen: readPanelOpen(),
  unreadCount: 0
}

export default {
  namespaced: true,
  state,
  mutations: {
    ...make.mutations(state),
    SET_PANEL_OPEN (st, value) {
      st.panelOpen = value === true
      try {
        window.sessionStorage.setItem(STORAGE_KEY, st.panelOpen ? 'true' : 'false')
      } catch (err) {
        // Storage can be unavailable (e.g. private mode); the panel still works
      }
    }
  }
}
