import { STATUS_OFFLINE_LABEL, STATUS_ONLINE_LABEL, type ParentMessage } from '@shared'

/**
 * Talk to the wiki page that frames this app. Same origin only: the panel
 * checks both the origin and the source window before acting on a message.
 */
export function postToParent (message: ParentMessage): void {
  window.parent.postMessage(message, window.location.origin)
}

/** The label comes from the service, so the chip names the live model. */
export function postStatus (online: boolean, label?: string): void {
  postToParent({
    type: 'wiki-ai:status',
    label: online ? (label ?? STATUS_ONLINE_LABEL) : STATUS_OFFLINE_LABEL,
    online
  })
}
