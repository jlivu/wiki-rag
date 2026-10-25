/**
 * Every link in the panel leaves the iframe into a new browser tab. The
 * icon says so visually; the hidden text says so to a screen reader.
 */
export function NewTabHint () {
  return (
    <>
      <svg
        className="new-tab-icon"
        width="10"
        height="10"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M13 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3.5" />
        <polyline points="9.5,2 14,2 14,6.5" />
        <line x1="7.5" y1="8.5" x2="14" y2="2" />
      </svg>
      <span className="sr-only"> (opens in a new tab)</span>
    </>
  )
}

/** The attributes every link in the panel carries. */
export const NEW_TAB_LINK = {
  target: '_blank',
  rel: 'noopener noreferrer'
} as const
