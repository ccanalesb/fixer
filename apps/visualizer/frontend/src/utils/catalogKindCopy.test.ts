import { describe, expect, it } from 'vitest'
import {
  CATALOG_MIN_RATING_EMPTY_SOURCE_FOLDER,
  CATALOG_MIN_RATING_EMPTY_SOURCE_LIGHTROOM,
  CULL_REDECIDE_CONFIRM_BODY,
  CULL_REDECIDE_CONFIRM_BODY_FOLDER,
  INSIGHTS_FOOTER_TIMEZONE,
  INSIGHTS_FOOTER_TIMEZONE_FOLDER,
  CATALOG_CACHE_INTRO_BODY,
  CATALOG_CACHE_INTRO_BODY_FOLDER,
} from '../constants/strings'
import { forCatalogKind } from './catalogKindCopy'

describe('forCatalogKind folder copy', () => {
  it('selects folder strings for re-decide, Insights footer, cache intro and Min rating source', () => {
    expect(
      forCatalogKind('folder', CULL_REDECIDE_CONFIRM_BODY, CULL_REDECIDE_CONFIRM_BODY_FOLDER),
    ).toBe(CULL_REDECIDE_CONFIRM_BODY_FOLDER)
    expect(
      forCatalogKind('folder', INSIGHTS_FOOTER_TIMEZONE, INSIGHTS_FOOTER_TIMEZONE_FOLDER),
    ).toBe(INSIGHTS_FOOTER_TIMEZONE_FOLDER)
    expect(
      forCatalogKind('folder', CATALOG_CACHE_INTRO_BODY, CATALOG_CACHE_INTRO_BODY_FOLDER),
    ).toBe(CATALOG_CACHE_INTRO_BODY_FOLDER)
    expect(
      forCatalogKind(
        'folder',
        CATALOG_MIN_RATING_EMPTY_SOURCE_LIGHTROOM,
        CATALOG_MIN_RATING_EMPTY_SOURCE_FOLDER,
      ),
    ).toBe(CATALOG_MIN_RATING_EMPTY_SOURCE_FOLDER)
  })
})
