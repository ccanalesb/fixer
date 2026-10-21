import { useCallback, useEffect, useState } from 'react'
import { CullingProfilesAPI } from '../../services/api'
import { useQuery, invalidateAll } from '../../data'
import { Button } from '../ui/Button'
import { FoldingCard } from '../ui/Card'
import {
  CULL_ADD_PROFILE,
  CULL_NOT_MEASURED,
  CULL_PROFILES_HELP,
  CULL_PROFILES_SECTION,
  CULL_PROFILES_SUMMARY,
  CULL_PROFILE_ACTIVE,
  CULL_PROFILE_INACTIVE,
} from '../../constants/strings'
import { CullingProfileEditor } from './CullingProfileEditor'
import { minimalNewProfileBody } from './minimalProfile'

export function CullingProfilesSection() {
  const profiles = useQuery(['culling-profiles.list'] as const, () => CullingProfilesAPI.list())
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)

  const detail = useQuery(['culling-profiles.detail', selectedSlug ?? ''] as const, () =>
    selectedSlug ? CullingProfilesAPI.get(selectedSlug) : Promise.resolve(null),
  )

  useEffect(() => {
    if (selectedSlug === null && profiles?.profiles?.length) {
      setSelectedSlug(profiles.profiles[0]!.slug)
    }
  }, [profiles, selectedSlug])

  const refresh = useCallback(() => {
    invalidateAll(['culling-profiles.list', 'culling-profiles.pipeline', 'culling-profiles.detail'])
  }, [])

  const onAdd = async () => {
    const slug = `profile-${Date.now()}`
    const created = await CullingProfilesAPI.create(minimalNewProfileBody(slug, 'New profile'))
    setSelectedSlug(created.slug)
    refresh()
  }

  const list = profiles?.profiles ?? []
  const summary = CULL_PROFILES_SUMMARY(
    list.length,
    list.filter((r) => r.active).map((r) => r.name),
  )

  return (
    <div className="mt-6">
      <FoldingCard title={CULL_PROFILES_SECTION} summary={summary} storageKey="lt.perspectives.profiles.open">
        <p className="text-sm text-text-secondary mb-4">{CULL_PROFILES_HELP}</p>
        <div className="flex flex-col lg:flex-row gap-6">
          <div className="w-full lg:w-72 shrink-0 space-y-3">
            <Button type="button" variant="primary" size="sm" onClick={() => void onAdd()}>
              {CULL_ADD_PROFILE}
            </Button>
            <div className="border border-border rounded-base divide-y divide-border max-h-[480px] overflow-y-auto">
              {list.map((r) => (
                <button
                  key={r.slug}
                  type="button"
                  className={`w-full text-left p-3 text-sm hover:bg-surface ${selectedSlug === r.slug ? 'bg-surface border-l-2 border-l-accent' : ''}`}
                  onClick={() => setSelectedSlug(r.slug)}
                >
                  <div className="font-medium">{r.name}</div>
                  <div className="text-text-tertiary text-xs">
                    v{r.version} ·{' '}
                    <span className={r.active ? 'text-success' : ''}>
                      {r.active ? CULL_PROFILE_ACTIVE : CULL_PROFILE_INACTIVE}
                    </span>
                    {!r.measured && <> · {CULL_NOT_MEASURED}</>}
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 min-w-0">
            {detail && selectedSlug ? (
              <CullingProfileEditor key={`${detail.slug}-${detail.version}`} profile={detail} onRefresh={refresh} />
            ) : null}
          </div>
        </div>
      </FoldingCard>
    </div>
  )
}
