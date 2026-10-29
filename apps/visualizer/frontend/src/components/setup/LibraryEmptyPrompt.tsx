import { Link } from 'react-router-dom'
import {
  FIRST_RUN_GO_TO_SETUP,
  FIRST_RUN_LIBRARY_EMPTY_TITLE,
  FIRST_RUN_SETUP_ROUTE,
} from '../../constants/strings'

export function LibraryEmptyPrompt({ hint }: { hint: string }) {
  return (
    <div className="py-12 text-center">
      <div
        className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-card bg-surface text-xl"
        aria-hidden
      >
        ◎
      </div>
      <p className="font-semibold text-text">{FIRST_RUN_LIBRARY_EMPTY_TITLE}</p>
      <p className="mt-1 mb-4 text-sm text-text-secondary">{hint}</p>
      <Link
        to={FIRST_RUN_SETUP_ROUTE}
        className="inline-flex items-center justify-center rounded-base bg-accent px-4 py-2 text-base font-semibold text-white hover:bg-accent-hover"
      >
        {FIRST_RUN_GO_TO_SETUP}
      </Link>
    </div>
  )
}
