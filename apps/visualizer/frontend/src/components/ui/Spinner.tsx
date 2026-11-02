interface SpinnerProps {
  /** Tailwind size class pair, e.g. `"h-4 w-4"`. Defaults to a 1rem icon. */
  sizeClass?: string
  className?: string
}

/** Small inline loading spinner, shared so every surface uses the same SVG. */
export function Spinner({ sizeClass = 'h-4 w-4', className = '' }: SpinnerProps) {
  return (
    <svg
      className={`animate-spin text-accent ${sizeClass} ${className}`.trim()}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  )
}
