<template lang='pug'>
  .ai-chat
    v-navigation-drawer.ai-chat-panel(
      v-model='panelOpen'
      app
      :right='!$vuetify.rtl'
      :width='drawerWidth'
      :mobile-breakpoint='dockBreakpoint'
      disable-resize-watcher
      touchless
      )
      .ai-chat-panel-resizer(
        v-if='canResize'
        role='separator'
        aria-orientation='vertical'
        tabindex='0'
        :aria-label='`Resize the ${panelTitle} panel`'
        :aria-valuenow='panelWidth'
        :aria-valuemin='minWidth'
        :aria-valuemax='maxWidth'
        :aria-valuetext='`${panelWidth} pixels wide`'
        title='Drag or use the arrow keys to resize. Double-click or press Enter to reset.'
        @pointerdown='onResizeStart'
        @pointermove='onResizeMove'
        @pointerup='onResizeEnd'
        @pointercancel='onResizeEnd'
        @lostpointercapture='onResizeEnd'
        @dblclick='resetWidth'
        @keydown='onResizeKey'
        )
      .ai-chat-panel-layout
        header.ai-chat-panel-header
          .ai-chat-panel-title
            v-icon(size='17', color='primary') mdi-creation
            span {{panelTitle}}
          .ai-chat-panel-status(:class='{ "is-online": status.online }')
            span.ai-chat-panel-status-dot
            span {{status.label}}
          .ai-chat-panel-actions
            button.ai-chat-panel-action(
              type='button'
              @click='startNewChat'
              :disabled='!canStartNewChat'
              aria-label='New chat'
              title='New chat'
              )
              svg(width='15', height='15', viewBox='0 0 16 16', fill='none', stroke='currentColor', stroke-width='1.6', stroke-linecap='round', stroke-linejoin='round', aria-hidden='true')
                path(d='M14 8.4v3.1a1 1 0 0 1-1 1H9.2L6 14.9V12.5H3a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h5.1')
                line(x1='12.6', y1='1.6', x2='12.6', y2='6')
                line(x1='10.4', y1='3.8', x2='14.8', y2='3.8')
            button.ai-chat-panel-action(
              ref='closeBtn'
              type='button'
              @click='closePanel'
              :aria-label='`Close ${panelTitle}`'
              :title='`Close the ${panelTitle} panel`'
              )
              svg(width='15', height='15', viewBox='0 0 16 16', fill='none', stroke='currentColor', stroke-width='1.6', aria-hidden='true')
                rect(x='1', y='2', width='14', height='12', rx='2')
                line(x1='10', y1='2', x2='10', y2='14')
                polyline(points='12,6 14,8 12,10')
        .ai-chat-panel-body
          iframe.ai-chat-panel-frame(
            v-if='panelUrl && hasOpened'
            ref='frame'
            :src='frameSrc'
            :title='panelTitle'
            allow='clipboard-write; microphone'
            )
          .ai-chat-panel-empty(v-else-if='!panelUrl')
            .ai-chat-panel-card
              .ai-chat-panel-card-title Not connected yet
              .ai-chat-panel-card-text Once the AI service is running, you can ask questions here and get answers from this wiki.
              .ai-chat-panel-card-meta
                span Current page
                strong {{pageTitle}}
                span /{{locale}}/{{path}}

    .ai-chat-launcher(v-show='!panelOpen')
      v-btn(
        ref='launcherBtn'
        fab
        color='primary'
        dark
        width='50'
        height='50'
        @click='openPanel'
        :aria-label='launcherLabel'
        :title='launcherLabel'
        )
        svg(width='20', height='20', viewBox='0 0 20 20', fill='none', stroke='currentColor', stroke-width='1.6', aria-hidden='true')
          path(d='M18 2H2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h4l4 4 4-4h4a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1z')
      span.ai-chat-launcher-badge(v-if='unreadCount > 0', aria-hidden='true') {{unreadCount > 99 ? '99+' : unreadCount}}
</template>

<script>
import { get, sync } from 'vuex-pathify'

import aiStore from '@/store/ai'

const PANEL_WIDTH = 600 // the default, and what a reset goes back to
const MIN_PANEL_WIDTH = 400
// The panel docks beside the page only while the page still has this much
// room left: what it has today on a 1512px screen beside the old 400px
// panel. With the default width that puts the breakpoint at 1712px, so a
// 1728px window docks and a 1512px one slides the panel over the page.
const PAGE_MIN_WIDTH = 1112
// Measured against the default width, not the one the reader dragged to:
// a drag is a deliberate choice to give the page less room, and a panel
// that changed mode under the pointer — dimming the page and closing on
// the next click — would be a nasty surprise 16px into a drag.
const DOCK_BREAKPOINT = PAGE_MIN_WIDTH + PANEL_WIDTH
// Remembered for this browser, not just this tab: it is a preference,
// unlike the open state, which is per tab.
const WIDTH_KEY = 'wiki-ai-panel-width'
const KEY_STEP = 16
const KEY_STEP_LARGE = 64

function clampWidth (value, max) {
  return Math.min(Math.max(Math.round(value), MIN_PANEL_WIDTH), Math.max(MIN_PANEL_WIDTH, max))
}

function readStoredWidth () {
  try {
    const stored = parseInt(window.localStorage.getItem(WIDTH_KEY), 10)
    return Number.isFinite(stored) ? stored : PANEL_WIDTH
  } catch (err) {
    return PANEL_WIDTH
  }
}

function writeStoredWidth (width) {
  try {
    window.localStorage.setItem(WIDTH_KEY, String(width))
  } catch (err) {
    // Storage can be unavailable (e.g. private mode); the panel still works
  }
}

export default {
  data () {
    return {
      hasOpened: false,
      // The width the reader asked for, before this window's limit.
      storedWidth: readStoredWidth(),
      dragging: false,
      status: {
        label: 'Not connected',
        online: false
      }
    }
  },
  computed: {
    panelOpen: sync('ai/panelOpen'),
    unreadCount: sync('ai/unreadCount'),
    path: get('page/path'),
    locale: get('page/locale'),
    pageTitle: get('page/title'),
    // Set window.WIKI_AI_PANEL_URL (e.g. '/ai/panel') to load the chat app.
    // Until then the panel shows a placeholder.
    panelUrl () {
      const url = window.WIKI_AI_PANEL_URL
      return (typeof url === 'string') ? url.trim() : ''
    },
    // What the panel calls itself, in its header and as the iframe's
    // accessible name. Set window.WIKI_AI_PANEL_TITLE beside the URL in
    // Admin > Theme > Head HTML Injection to change it.
    panelTitle () {
      const title = window.WIKI_AI_PANEL_TITLE
      const trimmed = (typeof title === 'string') ? title.trim() : ''
      return trimmed.length > 0 ? trimmed.slice(0, 40) : 'Assistant'
    },
    panelOrigin () {
      try {
        return new URL(this.panelUrl, window.location.href).origin
      } catch (err) {
        return ''
      }
    },
    frameSrc () {
      const params = new URLSearchParams({
        path: this.path,
        locale: this.locale,
        title: this.pageTitle,
        theme: this.$vuetify.theme.dark ? 'dark' : 'light'
      })
      const separator = this.panelUrl.indexOf('?') >= 0 ? '&' : '?'
      return `${this.panelUrl}${separator}${params.toString()}`
    },
    minWidth () {
      return MIN_PANEL_WIDTH
    },
    // Never more than half the window, whatever was asked for.
    maxWidth () {
      return Math.max(MIN_PANEL_WIDTH, Math.floor(this.$vuetify.breakpoint.width / 2))
    },
    // The width in use. The preference itself is kept whole, so widening
    // the window gives back a width a narrow one had to clamp.
    panelWidth () {
      return clampWidth(this.storedWidth, this.maxWidth)
    },
    drawerWidth () {
      return this.$vuetify.breakpoint.xsOnly ? '100%' : this.panelWidth
    },
    // Phones get the full width, so there is nothing to drag.
    canResize () {
      return !this.$vuetify.breakpoint.xsOnly
    },
    // Vuetify slides the drawer over the page below this width, which is
    // what the panel should do when the page no longer fits beside it.
    dockBreakpoint () {
      return DOCK_BREAKPOINT
    },
    isDocked () {
      return this.panelOpen && this.$vuetify.breakpoint.width >= DOCK_BREAKPOINT
    },
    launcherLabel () {
      // The title is used as written: lowercasing it would mangle a name.
      const open = `Open ${this.panelTitle}`
      return this.unreadCount > 0 ? `${open} (${this.unreadCount} unread)` : open
    },
    canStartNewChat () {
      return Boolean(this.panelUrl && this.hasOpened)
    }
  },
  watch: {
    panelOpen: {
      immediate: true,
      handler (isOpen) {
        if (isOpen) {
          // Load the chat app the first time the panel opens, then keep it
          // loaded so closing and reopening doesn't lose the conversation.
          this.hasOpened = true
          this.unreadCount = 0
        }
        this.updateBodyClasses()
      }
    },
    isDocked () {
      this.updateBodyClasses()
    },
    panelWidth: {
      immediate: true,
      handler (width) {
        this.publishWidth(width)
      }
    }
  },
  beforeCreate () {
    // Registered here so this component owns its store module and
    // client/store/index.js stays identical to upstream.
    if (!this.$store.hasModule('ai')) {
      this.$store.registerModule('ai', aiStore)
    }
  },
  created () {
    // Drag bookkeeping: deliberately not reactive, it changes every frame.
    this.resizeFrame = 0
    this.pointerX = 0
    this.dragFromX = 0
    this.dragFromWidth = PANEL_WIDTH
  },
  mounted () {
    window.addEventListener('message', this.onFrameMessage)
    document.addEventListener('keydown', this.onKeydown)
  },
  beforeDestroy () {
    window.removeEventListener('message', this.onFrameMessage)
    document.removeEventListener('keydown', this.onKeydown)
    if (this.resizeFrame) {
      window.cancelAnimationFrame(this.resizeFrame)
    }
    document.body.classList.remove('ai-panel-docked', 'ai-launcher-shown', 'ai-panel-resizing')
    document.body.style.removeProperty('--ai-panel-width')
  },
  methods: {
    openPanel () {
      this.panelOpen = true
      this.$nextTick(() => {
        if (this.$refs.closeBtn) {
          this.$refs.closeBtn.focus()
        }
      })
    },
    // The chat app clears the conversation itself; it owns that state.
    startNewChat () {
      const frame = this.$refs.frame
      if (!frame || !frame.contentWindow || !this.panelOrigin) {
        return
      }
      frame.contentWindow.postMessage({ type: 'wiki-ai:new-chat' }, this.panelOrigin)
    },
    closePanel () {
      this.panelOpen = false
      this.$nextTick(() => {
        if (this.$refs.launcherBtn) {
          this.$refs.launcherBtn.$el.focus()
        }
      })
    },
    updateBodyClasses () {
      // Used by the styles below to keep Wiki.js's own floating buttons clear
      document.body.classList.toggle('ai-panel-docked', this.isDocked)
      document.body.classList.toggle('ai-launcher-shown', !this.panelOpen)
    },
    // The styles need the live width too, for the floating edit button.
    publishWidth (width) {
      if (typeof document !== 'undefined' && document.body) {
        document.body.style.setProperty('--ai-panel-width', `${width}px`)
      }
    },
    setWidth (width, remember) {
      this.storedWidth = clampWidth(width, this.maxWidth)
      if (remember) {
        writeStoredWidth(this.storedWidth)
      }
    },
    // Dragging the edge. The pointer is captured, so the drag survives
    // crossing the iframe, which would otherwise swallow the events.
    onResizeStart (ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) {
        return
      }
      this.dragging = true
      this.dragFromX = ev.clientX
      this.dragFromWidth = this.panelWidth
      document.body.classList.add('ai-panel-resizing')
      try {
        ev.currentTarget.setPointerCapture(ev.pointerId)
      } catch (err) {
        // Without capture the drag still works over the page itself
      }
      ev.preventDefault()
    },
    onResizeMove (ev) {
      if (!this.dragging) {
        return
      }
      this.pointerX = ev.clientX
      if (this.resizeFrame) {
        return
      }
      // One update per frame: each one re-lays out the whole page.
      this.resizeFrame = window.requestAnimationFrame(() => {
        this.resizeFrame = 0
        if (!this.dragging) {
          return
        }
        // The panel sits on the right (on the left in RTL), so moving the
        // edge towards the page widens it.
        const moved = this.$vuetify.rtl ?
          this.pointerX - this.dragFromX :
          this.dragFromX - this.pointerX
        this.setWidth(this.dragFromWidth + moved, false)
      })
    },
    onResizeEnd () {
      if (!this.dragging) {
        return
      }
      this.dragging = false
      if (this.resizeFrame) {
        window.cancelAnimationFrame(this.resizeFrame)
        this.resizeFrame = 0
      }
      document.body.classList.remove('ai-panel-resizing')
      writeStoredWidth(this.panelWidth)
    },
    resetWidth () {
      this.setWidth(PANEL_WIDTH, true)
    },
    onResizeKey (ev) {
      const step = ev.shiftKey ? KEY_STEP_LARGE : KEY_STEP
      const wider = this.$vuetify.rtl ? 'ArrowRight' : 'ArrowLeft'
      const narrower = this.$vuetify.rtl ? 'ArrowLeft' : 'ArrowRight'
      let next = null
      switch (ev.key) {
        case wider: next = this.panelWidth + step; break
        case narrower: next = this.panelWidth - step; break
        case 'Home': next = MIN_PANEL_WIDTH; break
        case 'End': next = this.maxWidth; break
        case 'Enter': case ' ': next = PANEL_WIDTH; break
        default: return
      }
      ev.preventDefault()
      this.setWidth(next, true)
    },
    onKeydown (ev) {
      // Escape during a drag puts the width back rather than closing.
      if (ev.key === 'Escape' && this.dragging) {
        this.setWidth(this.dragFromWidth, false)
        this.onResizeEnd()
        return
      }
      if (ev.key === 'Escape' && this.panelOpen && this.$el.contains(document.activeElement)) {
        this.closePanel()
      }
    },
    // Messages the chat app can send from inside the panel:
    //   { type: 'wiki-ai:status', label: 'Model name', online: true }
    //   { type: 'wiki-ai:unread', count: 3 }
    //   { type: 'wiki-ai:close' }
    onFrameMessage (ev) {
      const frame = this.$refs.frame
      if (!frame || ev.source !== frame.contentWindow || ev.origin !== this.panelOrigin) {
        return
      }
      const msg = (ev.data && typeof ev.data === 'object') ? ev.data : {}
      switch (msg.type) {
        case 'wiki-ai:status':
          this.status = {
            label: String(msg.label || 'Connected').slice(0, 40),
            online: msg.online !== false
          }
          break
        case 'wiki-ai:unread':
          if (!this.panelOpen) {
            this.unreadCount = Math.max(0, parseInt(msg.count, 10) || 0)
          }
          break
        case 'wiki-ai:close':
          this.closePanel()
          break
      }
    }
  }
}
</script>

<style lang='scss'>
// Colours follow the Wiki.js theme (light and dark mode).
// Dimensions and spacing follow the assistant design.

$ai-panel-width: 600px; // the default; the live width is --ai-panel-width
$ai-resizer-hit: 9px;
$ai-header-height: 64px; // lines up with the Wiki.js header
$ai-launcher-size: 50px;
$ai-launcher-bottom: 22px;
$ai-launcher-side: 19px; // centres the launcher under Wiki.js's 56px edit button

$ai-header-bg: #000; // same as the Wiki.js header, in both modes
$ai-header-border: rgba(255, 255, 255, 0.12);

.ai-chat-panel {
  &.v-navigation-drawer.theme--light {
    background-color: mc('grey', '100');
  }

  &.v-navigation-drawer.theme--dark {
    background-color: mc('grey', '900');
  }

  .v-navigation-drawer__content {
    overflow: hidden;
  }

  &-layout {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  // The draggable edge. It is only as wide as a comfortable target; the
  // line that shows where it is appears on hover, focus and while dragging.
  &-resizer {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 3;
    width: $ai-resizer-hit;
    height: 100%;
    cursor: col-resize;
    // So a touch drag resizes instead of scrolling the page behind it.
    touch-action: none;

    &::before {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      width: 3px;
      background-color: transparent;
      transition: background-color 0.12s;
    }

    &:hover::before,
    &:focus-visible::before {
      background-color: mc('blue', '400');
    }

    &:focus-visible {
      // The line along the edge is the focus indicator: an outline on a
      // 9px strip would be drawn mostly outside the panel.
      outline: none;

      &::before {
        background-color: mc('blue', '300');
        box-shadow: 0 0 0 1px mc('blue', '300');
      }
    }

    .v-application--is-rtl & {
      left: auto;
      right: 0;

      &::before {
        left: auto;
        right: 0;
      }
    }
  }

  &-header {
    flex: 0 0 $ai-header-height;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px;
    background-color: $ai-header-bg;
    border-bottom: 1px solid $ai-header-border;
  }

  &-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14.5px;
    font-weight: 600;
    color: #fff;
  }

  &-status {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 12px;
    border: 1px solid $ai-header-border;
    border-radius: 20px;
    font-size: 11px;
    color: mc('grey', '400');
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;

    &-dot {
      flex-shrink: 0;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background-color: mc('grey', '600');
    }

    &.is-online &-dot {
      background-color: mc('green', '500');
      box-shadow: 0 0 5px mc('green', '500');
    }
  }

  &-actions {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }

  &-action {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 1px solid $ai-header-border;
    border-radius: 8px;
    background: transparent;
    color: mc('grey', '500');
    cursor: pointer;
    transition: background-color 0.12s, color 0.12s;

    &:hover:not(:disabled) {
      background-color: mc('grey', '900');
      color: #fff;
    }

    &:focus-visible {
      outline: 2px solid mc('blue', '300');
      outline-offset: 2px;
    }

    &:disabled {
      opacity: 0.4;
      cursor: default;
    }
  }

  &-body {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  &-frame {
    flex: 1 1 auto;
    display: block;
    width: 100%;
    border: 0;
    background-color: transparent;
  }

  &-empty {
    padding: 14px 13px;
  }

  &-card {
    padding: 11px 13px;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 11px 11px 11px 3px;
    background-color: #fff;
    font-size: 13.5px;
    line-height: 1.6;
    color: rgba(0, 0, 0, 0.87);

    &-title {
      font-weight: 600;
    }

    &-text {
      margin-top: 4px;
      color: rgba(0, 0, 0, 0.6);
    }

    &-meta {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid rgba(0, 0, 0, 0.12);
      font-size: 12px;
      color: rgba(0, 0, 0, 0.6);

      strong {
        font-size: 13px;
        font-weight: 500;
        color: rgba(0, 0, 0, 0.87);
      }
    }

    // Dark mode: same greys Wiki.js uses for its own cards and menus
    .theme--dark & {
      border-color: rgba(255, 255, 255, 0.12);
      background-color: lighten(mc('grey', '900'), 5%);
      color: #fff;
    }

    .theme--dark &-text,
    .theme--dark &-meta {
      color: rgba(255, 255, 255, 0.7);
    }

    .theme--dark &-meta {
      border-top-color: rgba(255, 255, 255, 0.12);

      strong {
        color: #fff;
      }
    }
  }
}

.ai-chat-launcher {
  position: fixed;
  right: $ai-launcher-side;
  bottom: $ai-launcher-bottom;
  z-index: 5;
  transition: transform 0.15s;

  &:hover {
    transform: scale(1.05);
  }

  .v-btn.v-btn--fab {
    border-radius: 14px;
  }

  &-badge {
    position: absolute;
    top: -5px;
    right: -5px;
    min-width: 18px;
    padding: 1px 6px;
    border: 1.5px solid #fff;
    border-radius: 9px;
    background-color: mc('red', '500');
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    line-height: 1.4;
    text-align: center;
    pointer-events: none;

    .theme--dark & {
      border-color: mc('grey', '900');
    }
  }

  .v-application--is-rtl & {
    right: auto;
    left: $ai-launcher-side;
  }

  .v-application--is-rtl &-badge {
    right: auto;
    left: -5px;
  }
}

// Lift Wiki.js's floating edit button above the launcher
body.ai-launcher-shown {
  .v-application--is-ltr .v-speed-dial--fixed.v-speed-dial--bottom.v-speed-dial--right,
  .v-application--is-rtl .v-speed-dial--fixed.v-speed-dial--bottom.v-speed-dial--left {
    bottom: $ai-launcher-bottom + $ai-launcher-size + 14px;
  }
}

// Keep the edit button clear of the docked panel, at whatever width the
// reader has dragged it to (the component keeps --ai-panel-width in step).
body.ai-panel-docked {
  .v-application--is-ltr .v-speed-dial--fixed.v-speed-dial--right {
    right: calc(var(--ai-panel-width, #{$ai-panel-width}) + 16px);
  }

  .v-application--is-rtl .v-speed-dial--fixed.v-speed-dial--left {
    left: calc(var(--ai-panel-width, #{$ai-panel-width}) + 16px);
  }
}

// While the edge is being dragged: no width animation to lag behind the
// pointer, no text selection, and the iframe must not swallow the drag.
body.ai-panel-resizing {
  cursor: col-resize;
  user-select: none;

  .ai-chat-panel.v-navigation-drawer,
  .v-main {
    transition: none !important;
  }

  .ai-chat-panel-frame {
    pointer-events: none;
  }

  .ai-chat-panel-resizer::before {
    background-color: mc('blue', '400');
  }
}

@media (prefers-reduced-motion: reduce) {
  .ai-chat-panel,
  .ai-chat-launcher {
    transition: none !important;
  }
}
</style>
