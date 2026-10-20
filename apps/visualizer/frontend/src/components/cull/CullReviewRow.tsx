import type { CullReviewRow as Row } from '../../services/api'
import { failingLevelClass } from './cullHighlight'

export function CullReviewRowView({
  row,
  checked,
  onCheck,
  onOpen,
}: {
  row: Row
  checked: boolean
  onCheck: (next: boolean) => void
  onOpen: () => void
}) {
  return (
    <div className="grid grid-cols-[auto_48px_1fr] gap-3 items-start px-3 py-2 border-t border-border bg-bg first:border-t-0">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onCheck(e.target.checked)}
        aria-label={`Select ${row.filename}`}
        className="mt-3"
      />
      <button type="button" onClick={onOpen} className="block w-12 h-12 rounded-md overflow-hidden">
        <img src={row.thumbnail_url} alt="" className="w-full h-full object-cover" />
      </button>
      <button type="button" onClick={onOpen} className="text-left min-w-0">
        <div className="font-medium text-sm truncate">{row.filename}</div>
        <div className="text-xs text-text-secondary mt-1 space-y-0.5">
          {row.recipe.level_sets.map((set) => (
            <div key={set.id}>
              <span className="text-text-tertiary">{row.recipe.name} · {set.id} levels · </span>
              {set.dimensions.map((dim, i) => (
                <span key={dim.slug}>
                  {i > 0 ? ' · ' : ''}
                  {dim.name}{' '}
                  {dim.levels.map((lv, j) => (
                    <span key={j} className={failingLevelClass(lv.fails)}>
                      {lv.level}/{set.id}
                    </span>
                  ))}
                </span>
              ))}
            </div>
          ))}
        </div>
      </button>
    </div>
  )
}
