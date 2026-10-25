import type { ReactNode } from 'react'

/**
 * The shell every answer component sits in: a header strip and a body,
 * following the design's inline cards in Wiki.js colours.
 */
export function Card ({ icon, title, children }: {
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <section className="aic">
      <header className="aic-head">
        {icon}
        <span>{title}</span>
      </header>
      {children}
    </section>
  )
}
