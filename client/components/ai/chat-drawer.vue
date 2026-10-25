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
      .ai-chat-panel-layout
        header.ai-chat-panel-header
          .ai-chat-panel-title
            v-icon(size='17', color='primary') mdi-creation
            span Assistant
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
              aria-label='Close assistant'
              title='Close assistant panel'
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
            title='Assistant'
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
        title='Open assistant'
        )
        svg(width='20', height='20', viewBox='0 0 20 20', fill='none', stroke='currentColor', stroke-width='1.6', aria-hidden='true')
          path(d='M18 2H2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h4l4 4 4-4h4a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1z')
      span.ai-chat-launcher-badge(v-if='unreadCount > 0', aria-hidden='true') {{unreadCount > 99 ? '99+' : unreadCount}}
</template>

<script>
import { get, sync } from 'vuex-pathify'

import aiStore from '@/store/ai'

// The panel docks beside the page from this window width up,
// and slides over the page on narrower screens.
const DOCK_BREAKPOINT = 960
const PANEL_WIDTH = 400 // keep in sync with $ai-panel-width in the styles

export default {
  data () {
    return {
      hasOpened: false,
      dockBreakpoint: DOCK_BREAKPOINT,
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
    drawerWidth () {
      return this.$vuetify.breakpoint.xsOnly ? '100%' : PANEL_WIDTH
    },
    isDocked () {
      return this.panelOpen && this.$vuetify.breakpoint.width >= DOCK_BREAKPOINT
    },
    launcherLabel () {
      return this.unreadCount > 0 ? `Open assistant (${this.unreadCount} unread)` : 'Open assistant'
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
    }
  },
  beforeCreate () {
    // Registered here so this component owns its store module and
    // client/store/index.js stays identical to upstream.
    if (!this.$store.hasModule('ai')) {
      this.$store.registerModule('ai', aiStore)
    }
  },
  mounted () {
    window.addEventListener('message', this.onFrameMessage)
    document.addEventListener('keydown', this.onKeydown)
  },
  beforeDestroy () {
    window.removeEventListener('message', this.onFrameMessage)
    document.removeEventListener('keydown', this.onKeydown)
    document.body.classList.remove('ai-panel-docked', 'ai-launcher-shown')
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
    onKeydown (ev) {
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

$ai-panel-width: 400px; // keep in sync with PANEL_WIDTH in the script
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

// Keep the edit button clear of the docked panel
body.ai-panel-docked {
  .v-application--is-ltr .v-speed-dial--fixed.v-speed-dial--right {
    right: $ai-panel-width + 16px;
  }

  .v-application--is-rtl .v-speed-dial--fixed.v-speed-dial--left {
    left: $ai-panel-width + 16px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ai-chat-panel,
  .ai-chat-launcher {
    transition: none !important;
  }
}
</style>
