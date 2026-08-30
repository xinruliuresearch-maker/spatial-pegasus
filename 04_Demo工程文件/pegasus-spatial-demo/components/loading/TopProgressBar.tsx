'use client'

/**
 * Prototype 2: Top progress bar (Vercel / GitHub / YouTube style).
 *
 * Sits 2px tall at the very top of the viewport, primary-colored slice
 * loops left-to-right via the existing `pmo-prog-slide` keyframe
 * (globals.css:778). Never reaches "100% done" because we don't know how
 * long the data fetch will take; the indeterminate slide is the signal.
 *
 * Tip: stack this with a faint <SkeletonShimmer plain /> below so the page
 * isn't visually empty during the wait.
 */
export function TopProgressBar() {
  return (
    <>
      <div
        aria-hidden
        className="fixed top-0 left-0 right-0 z-[60] h-[2px] overflow-hidden bg-transparent"
        style={{ pointerEvents: 'none' }}
      >
        <div
          className="absolute top-0 h-full"
          style={{
            width: '30%',
            background:
              'linear-gradient(90deg, transparent 0%, var(--primary, #536c9f) 50%, transparent 100%)',
            animation: 'pmo-prog-slide 1.6s ease-in-out infinite',
          }}
        />
      </div>
    </>
  )
}
