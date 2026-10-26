/** Small line icons, in the style of the design's card headers. */
const base = {
  width: 13,
  height: 13,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
}

export function SourcesIcon () {
  return (
    <svg {...base}>
      <path d="M2.5 3.2v9.2a1 1 0 0 0 1 1H8V4.2a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1Z" />
      <path d="M8 4.2a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1v8.2a1 1 0 0 1-1 1H8" />
    </svg>
  )
}

export function ChecklistIcon () {
  return (
    <svg {...base}>
      <polyline points="2,4.5 3.5,6 6,3" />
      <polyline points="2,11 3.5,12.5 6,9.5" />
      <line x1="8.5" y1="4.5" x2="14" y2="4.5" />
      <line x1="8.5" y1="11.5" x2="14" y2="11.5" />
    </svg>
  )
}

export function AlertIcon () {
  return (
    <svg {...base}>
      <circle cx="8" cy="8" r="6" />
      <line x1="8" y1="5" x2="8" y2="8.5" />
      <line x1="8" y1="11" x2="8" y2="11.01" />
    </svg>
  )
}

export function TableIcon () {
  return (
    <svg {...base}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <line x1="2" y1="6.5" x2="14" y2="6.5" />
      <line x1="6.5" y1="6.5" x2="6.5" y2="13" />
    </svg>
  )
}

export function DraftIcon () {
  return (
    <svg {...base}>
      <path d="M8.5 2.5H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V8" />
      <path d="M11.3 2.2a1.1 1.1 0 0 1 1.5 1.5L9 7.6l-2 .5.5-2 3.8-3.9Z" />
    </svg>
  )
}

export function ClockIcon () {
  return (
    <svg {...base} width={11} height={11}>
      <circle cx="8" cy="8" r="6" />
      <polyline points="8,5 8,8 10,10" />
    </svg>
  )
}

/**
 * An uploaded file. The outline is the same sheet of paper for every type;
 * what is drawn on it says which type it is, so a spreadsheet and a slide
 * deck do not look alike at 13 pixels.
 */
export function FileIcon ({ type }: { type?: string }) {
  const kind = (type ?? '').toLowerCase()
  if (kind === 'image') { return <ImageIcon /> }
  return (
    <svg {...base} className="file-icon">
      <path d="M9 1.8H4a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.8L9 1.8Z" />
      <polyline points="9,1.8 9,5.8 13,5.8" />
      {kind === 'xlsx' || kind === 'csv'
        ? (
          <>
            <rect x="4.9" y="7.6" width="6.2" height="4.3" rx="0.4" />
            <line x1="4.9" y1="9.75" x2="11.1" y2="9.75" />
            <line x1="8" y1="7.6" x2="8" y2="11.9" />
          </>
          )
        : null}
      {kind === 'pptx'
        ? <rect x="4.9" y="7.8" width="6.2" height="4" rx="0.5" />
        : null}
      {kind === 'pdf'
        ? (
          <>
            <line x1="5" y1="8.6" x2="11" y2="8.6" />
            <path d="M5 11.9c1.5 0 2.4-1 2.7-2.1.3 1.3 1.4 2.1 3.3 1.7" />
          </>
          )
        : null}
      {kind !== 'xlsx' && kind !== 'csv' && kind !== 'pptx' && kind !== 'pdf'
        ? (
          <>
            <line x1="5" y1="8.6" x2="11" y2="8.6" />
            <line x1="5" y1="11" x2="9.4" y2="11" />
          </>
          )
        : null}
    </svg>
  )
}

/** A video: the clapperboard-free version — a frame with a play head. */
export function VideoIcon () {
  return (
    <svg {...base} className="file-icon">
      <rect x="1.6" y="3.4" width="9.4" height="9.2" rx="1.5" />
      <path d="M11 7.1l3.2-1.9a0.4 0.4 0 0 1 0.6 0.35v4.9a0.4 0.4 0 0 1-0.6 0.35L11 8.9Z" />
      <polygon points="5,6.3 8.2,8 5,9.7" />
    </svg>
  )
}

/** A picture: a frame with a horizon and a sun, the usual shorthand. */
export function ImageIcon () {
  return (
    <svg {...base} className="file-icon">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <circle cx="5.9" cy="6.6" r="1.1" />
      <path d="M2.4 11.4 6 8.2l2.4 2.1L10.6 8l3 3.2" />
    </svg>
  )
}

export function MicrophoneIcon () {
  return (
    <svg {...base}>
      <rect x="6" y="1.8" width="4" height="8" rx="2" />
      <path d="M3.4 7.4a4.6 4.6 0 0 0 9.2 0" />
      <line x1="8" y1="12" x2="8" y2="14.4" />
    </svg>
  )
}

export function StopIcon () {
  return (
    <svg {...base} fill="currentColor">
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.4" stroke="none" />
    </svg>
  )
}

export function ChevronIcon () {
  return (
    <svg {...base} width={11} height={11}>
      <polyline points="4,6.5 8,10.5 12,6.5" />
    </svg>
  )
}

export function CheckIcon () {
  return (
    <svg {...base} width={12} height={12}>
      <polyline points="3,8.5 6.2,11.5 13,4.5" />
    </svg>
  )
}

/** Points into a submenu, or back out of one when turned around. */
export function CaretIcon ({ back = false }: { back?: boolean }) {
  return (
    <svg {...base} width={11} height={11}>
      {back
        ? <polyline points="10,3 5.5,8 10,13" />
        : <polyline points="6,3 10.5,8 6,13" />}
    </svg>
  )
}
