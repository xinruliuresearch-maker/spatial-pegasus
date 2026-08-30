import type { HTMLAttributes } from 'react'

/** Marble-on-graphite Pegasus mark, adapted from the integration branch. */
export function BrandMark({ className = '', ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex shrink-0 overflow-hidden rounded-[28%] bg-[#151816] shadow-[inset_0_1px_rgba(255,255,255,.12),0_4px_14px_rgba(31,27,23,.16)] ring-1 ring-black/10 ${className}`}
      {...props}
    >
      <svg viewBox="0 0 40 40" fill="none" className="h-full w-full" focusable="false">
        <rect width="40" height="40" rx="11" fill="#151816" />
        <path d="M-4 30C6 23 11 24 20 16S34 7 46 11M-3 35C8 27 15 29 23 21S34 13 44 16" stroke="#536c9f" strokeWidth=".65" opacity=".5" />
        <path d="M10 27.8c3.5-7.9 8.5-13 17.3-15.7-1.8 3-2.4 5.5-1.9 7.8 1.1 4.8-2.5 8.1-8.5 8.1H10Z" fill="#f8f9fb" />
        <path d="M12.8 26c3.9-4.9 7.4-7.8 12.4-10.2M15.4 27.5c2.3-3.7 5.2-6.7 9.4-9.4M19.2 27.5c1.5-2.5 3.2-4.4 5.9-6.3" stroke="#8993a5" strokeWidth=".72" strokeLinecap="round" opacity=".82" />
        <path d="M10 27.8h18.2" stroke="#536c9f" strokeWidth="1.1" strokeLinecap="round" />
        <circle cx="27.2" cy="12.1" r="1.15" fill="#f8f9fb" />
      </svg>
    </span>
  )
}
