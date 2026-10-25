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
