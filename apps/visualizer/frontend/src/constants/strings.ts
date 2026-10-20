// App
export const APP_TITLE = 'Lightroom Tagger'

// Navigation
export const NAV_INSIGHTS = 'Insights'
export const NAV_IMAGES = 'Images'
export const NAV_PROCESSING = 'Processing'
export const NAV_IDENTITY = 'Identity'

// Tab labels
export const TAB_CATALOG = 'Catalog'
export const TAB_CULL_CATALOG = 'Cull catalog'
export const TAB_CULL = 'Cull'
export const TAB_ANALYZE = 'Analyze'
export const TAB_PERSPECTIVES = 'Perspectives'
export const TAB_CATALOG_CACHE = 'Catalog Cache'
export const TAB_JOB_QUEUE = 'Job Queue'
export const TAB_PROVIDERS = 'Providers'
export const TAB_SETTINGS = 'Settings'

/** Processing — Perspectives tab subtitle (D-10 / SCORE-06). */
export const NAV_PERSPECTIVES_HELP =
  'Edit critique rubrics in the library database. Reset reloads the markdown file from prompts/perspectives for the selected slug.'

// Placeholders
export const PLACEHOLDER_COMING_SOON = 'Coming soon...'
export const PLACEHOLDER_CATALOG_VIEW = 'Catalog image view coming soon'

// Badge labels (for variant prop values, not display strings)
export const BADGE_MATCHED = 'Matched'
export const BADGE_DESCRIBED = 'Described'
export const BADGE_PROCESSED = 'Processed'

// Date display
export const DATE_NO_DATE = 'No date'
export const DATE_ESTIMATED_SUFFIX = '(est.)'

// Image details
export const IMAGE_DETAILS_TITLE = 'Image Details'
export const IMAGE_DETAILS_AI_DESCRIPTION = 'AI Description'
export const IMAGE_DETAILS_DESCRIPTIVE_TECHNICAL = 'Descriptive & technical'
export const IMAGE_DETAILS_PERSPECTIVE_ANALYSIS = 'Perspective analysis'

// Catalog image modal — critique scores (phase 06-03)
export const SECTION_IMAGE_SCORES = 'Critique scores'
export const ACTION_RUN_SCORING = 'Run scoring'
export const SCORES_LOADING = 'Loading scores…'
export const ACTION_SCORING_IN_PROGRESS = 'Scoring…'
export const LABEL_SCORES_PERSPECTIVES = 'Perspectives'
export const SCORES_LOADING_PERSPECTIVES = 'Loading perspectives…'
export const SCORES_FORCE_SAME_RUBRIC = 'Force re-score same rubric revision'
export const SCORES_EMPTY_HINT =
  'No critique scores for this image yet. Run scoring from the button below or use Processing → Descriptions to batch score.'
export const SCORES_VERSION_HISTORY = 'Version history'
export const SCORES_LOADING_HISTORY = 'Loading history…'
export const SCORES_NO_PRIOR_VERSIONS = 'No prior versions.'
export const SCORES_OUTPUT_REPAIRED = 'Output was repaired before save'
export const SCORES_NO_ACTIVE_PERSPECTIVES =
  'No active perspectives to score. Add perspectives in Processing.'
export const SCORES_FAILED_GENERIC = 'Scoring failed'
export const LABEL_FOLDER = 'Folder'
export const LABEL_SOURCE = 'Source'
export const LABEL_DATE = 'Date'
export const LABEL_IMAGE_HASH_DISPLAY = 'Image Hash'
export const LABEL_TITLE = 'Title'
export const LABEL_PATH = 'Path'
export const LABEL_DIMENSIONS = 'Dimensions'
export const LABEL_CAPTION = 'Caption'
export const LABEL_KEYWORDS = 'Keywords'

// Status Display
export const STATUS_LABELS: Record<string, string> = {
  pending: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export const ERROR_SEVERITY_LABELS: Record<string, string> = {
  warning: 'Warning',
  error: 'Error',
  critical: 'Critical',
}

// Generic Messages
export const MSG_LOADING = 'Loading...'
export const MSG_UNKNOWN_ERROR = 'Unknown error'
export const MSG_NO_JOBS = 'No jobs found. Start a job to see it here.'
export const MSG_CONNECTED = 'Connected'
export const MSG_DISCONNECTED = 'Disconnected'
export const BACKEND_DISCONNECTED_BANNER_TITLE = 'Backend unreachable'
export const BACKEND_DISCONNECTED_BANNER_BODY =
  'Lost connection to the server. New data may not load until the backend responds again. The app will keep retrying in the background.'
export const BACKEND_BUSY_BANNER_TITLE = 'Backend busy'
export const BACKEND_BUSY_BANNER_BODY =
  'A background job is keeping the server busy. Pages may load slowly — cancel the job from Processing if you need the API back sooner. The app will keep retrying.'
export const MSG_ERROR_PREFIX = 'Error:'

// Generic Labels
export const LABEL_ID = 'ID:'
export const LABEL_TYPE = 'Type:'
export const LABEL_STATUS = 'Status:'
export const LABEL_CREATED = 'Created:'
export const LABEL_CONFIGURATION = 'Configuration'
export const LABEL_IMAGES = 'images'
export const LABEL_MATCHES = 'matches'
export const LABEL_DAYS = 'days'
export const LABEL_MB = 'MB'
export const LABEL_CACHED = 'cached'
export const LABEL_MODEL = 'model:'
export const LABEL_SCORE = 'score:'

// Dashboard / Insights home (KPI labels shared with legacy dashboard copy)
export const DASHBOARD_CATALOG_IMAGES = 'Catalog Images'
export const DASHBOARD_MATCHES = 'Matches Found'
export const DASHBOARD_RECENT_JOBS = 'Recent Jobs'
export const DASHBOARD_NO_JOBS = 'No recent jobs'
export const DASHBOARD_TOTAL_CATALOG = 'Total Catalog Images'
export const DASHBOARD_MISSING = 'Missing'

// Insights home (Phase 9)
export const INSIGHTS_PAGE_TITLE = 'Insights'
export const INSIGHTS_PAGE_SUBTITLE =
  'Actionable catalog signals — top highlights, next steps, and shortcuts to Identity and Processing.'
export const INSIGHTS_SECTION_SCORES = 'Scores & style'
export const INSIGHTS_SECTION_HIGHLIGHTS = 'Top scored photos'
export const INSIGHTS_SECTION_NEXT_ACTIONS = 'Next actions'
export const INSIGHTS_SECTION_PERSPECTIVE_COVERAGE = 'Perspective coverage'
export const INSIGHTS_SECTION_EXPLORE = 'Explore'
export const INSIGHTS_TOP_PHOTOS_TAB_UNPOSTED = 'Unposted'
export const INSIGHTS_TOP_PHOTOS_TAB_POSTED = 'Posted'
export const INSIGHTS_TOP_PHOTOS_TAB_ALL = 'All'
export const INSIGHTS_TOP_PHOTOS_REGION_ARIA = 'Top scored photos'
export const INSIGHTS_FOOTER_TIMEZONE =
  'Timestamps on catalog images follow Lightroom capture metadata where available.'
export const INSIGHTS_QUICK_IDENTITY_TITLE = 'Identity'
export const INSIGHTS_QUICK_IDENTITY_DESC = 'Mirror signature, and post-next suggestions.'
export const INSIGHTS_QUICK_PROCESSING_TITLE = 'Processing'
export const INSIGHTS_QUICK_PROCESSING_DESC = 'Matching, descriptions, scoring jobs, and perspectives.'
export const INSIGHTS_KPI_CATALOG_DESC = 'Lightroom catalog entries'
export const CATALOG_FILTER_LABEL_MIN_SCORE_ACTIVE = 'Min score (any active perspective)'
export const INSIGHTS_KPI_SCORING_9_PLUS = 'Scoring 9+'
export const INSIGHTS_KPI_SCORING_9_PLUS_DESC = 'Best on an active perspective'
export const INSIGHTS_KPI_BURST_STACKS = 'Burst stacks to cull'
export const INSIGHTS_KPI_BURST_STACKS_DESC = 'Pick a keeper, reject the rest'
export const INSIGHTS_KPI_UNSCORED_ACTIVE = 'Unscored on active perspectives'
export const INSIGHTS_KPI_UNSCORED_ACTIVE_DESC = 'Missing at least one active lens'
export const INSIGHTS_ACTION_CULL_BURST = 'Cull a burst stack'
export const INSIGHTS_ACTION_CULL_BURST_DESC =
  'Stacks grouped by date_taken. Open a representative, pick the keeper, reject the rest.'
export const INSIGHTS_ACTION_CONFIRM_STACKS = 'Stacks to confirm'
export const INSIGHTS_ACTION_CONFIRM_STACKS_DESC =
  'Visual matches date_taken missed — review pairs and confirm or reject.'
export const INSIGHTS_ACTION_FRAME_SUBSTANCE = 'Flagged frames'
export const INSIGHTS_ACTION_FRAME_SUBSTANCE_DESC =
  'Void or illegible frames withheld from ranking (net of overrides).'
export const INSIGHTS_ACTION_FRAME_SUBSTANCE_BREACH =
  'Latest detector run breached blast-radius guard'
export const INSIGHTS_LINK_CONFIRM_STACKS = '/stacks/confirm'
export const STACK_SUGGESTIONS_PAGE_TITLE = 'Stacks to confirm'
export const STACK_SUGGESTIONS_PAGE_SUBTITLE =
  'Catalog similarity found images that belong together but were never grouped by date_taken.'
export const STACK_SUGGESTIONS_EMPTY =
  'No pending stack suggestions. Run catalog similarity from Processing when new images are embedded.'
export const STACK_SUGGESTIONS_ACCEPT = 'Confirm stack'
export const STACK_SUGGESTIONS_REJECT = 'Reject'
export const STACK_SUGGESTIONS_TIME_GAP_SECONDS = (seconds: number) =>
  seconds < 60 ? `${seconds}s apart` : `${Math.round(seconds / 60)}m apart`
export const INSIGHTS_ACTION_FINISH_PASS = 'Undescribed + unscored'
export const INSIGHTS_ACTION_FINISH_PASS_DESC =
  'Images with no current score — run a score pass on Processing.'
export const INSIGHTS_COVERAGE_INACTIVE = 'Inactive'
export const INSIGHTS_LINK_CATALOG = '/images?tab=catalog'
export const INSIGHTS_LINK_SCORING_9_PLUS = '/images?tab=catalog&min_score_on_active=9'
export const INSIGHTS_LINK_BURST_STACKS = '/images?tab=catalog&burst_stack=true'
export const INSIGHTS_LINK_FRAME_SUBSTANCE_FLAGGED = '/images?tab=catalog&flagged=true'
export const INSIGHTS_LINK_SCORE_JOB = '/processing?tab=analyze'

// Actions
export const ACTION_CANCEL = 'Cancel'
export const ACTION_CANCELLING = 'Cancelling...'

export const MSG_FAILED_START_JOB = 'Failed to start job'

// API
export const API_DEFAULT_URL = '/api'
export const WS_DEFAULT_URL = ''

// Messages
export const MSG_NO_EXIF_DATA = 'No EXIF data available'
export const MSG_CLICK_FOR_DETAILS = 'Click for details'
export const MSG_PAGE_OF = 'Page {current} of {total}'
export const MSG_SHOWING_RANGE = 'Showing {start}-{end} of {total}'

/** Shared summary phrasing for paginated grids ("Showing 50 of 12,345 images"). */
export function msgShowingOf(shown: number, total: number, noun = 'items'): string {
  return `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} ${noun}`
}

// Modal
export const MODAL_TITLE_IMAGE_DETAILS = 'Image Details'
export const MODAL_CLOSE = 'Close'

// Metadata Sections
export const META_SECTION_BASIC_INFO = 'Basic Information'
export const META_SECTION_IMAGE_ANALYSIS = 'Image Analysis'
export const META_SECTION_EXIF_DATA = 'EXIF Data'
export const META_SECTION_CAPTION = 'Caption'
export const META_SECTION_FILE_LOCATION = 'File Location'

// Metadata Labels
export const LABEL_FILENAME = 'Filename'
export const LABEL_MEDIA_KEY = 'Media Key'
export const LABEL_SOURCE_FOLDER = 'Source Folder'
export const LABEL_DATE_FOLDER = 'Date Folder'
export const LABEL_ADDED = 'Added'
export const LABEL_VISUAL_HASH = 'Visual Hash (pHash)'
export const LABEL_GPS_COORDINATES = 'GPS Coordinates'
export const LABEL_DATE_TAKEN = 'Date Taken'
export const LABEL_CAMERA = 'Camera'
export const LABEL_LENS = 'Lens'
export const LABEL_ISO = 'ISO'
export const LABEL_APERTURE = 'Aperture'
export const LABEL_SHUTTER_SPEED = 'Shutter Speed'

// Hash explanation
export const HASH_EXPLANATION = 'This hash is used to detect visually identical images across your collection.'

// Pagination
export const PAGINATION_PREVIOUS = '← Previous'
export const PAGINATION_NEXT = 'Next →'

// Filters
export const FILTER_ALL_DATES = 'All dates'
export const FILTER_CLEAR = 'Clear'

/** FilterBar — primary reset (D-17); Catalog migration uses this label. */
export const FILTER_CLEAR_ALL = 'Clear all'

/** aria-label for per-chip remove control (D-16). */
export const FILTER_CHIP_REMOVE_ARIA = (filterLabel: string) => `Remove ${filterLabel} filter`

// Catalog tab — filters (extracted from CatalogTab.tsx during plan 04-04 migration)
export const CATALOG_FILTER_LABEL_STATUS = 'Status'
export const CATALOG_FILTER_LABEL_ANALYZED = 'Analyzed'
export const CATALOG_FILTER_LABEL_MONTH = 'Month'
export const CATALOG_FILTER_LABEL_KEYWORD = 'Keyword'
export const CATALOG_FILTER_LABEL_MIN_RATING = 'Min rating'
export const CATALOG_FILTER_LABEL_FROM = 'From'
export const CATALOG_FILTER_LABEL_TO = 'To'
export const CATALOG_FILTER_LABEL_DATE_RANGE = 'Date'
export const CATALOG_FILTER_LABEL_COLOR = 'Color label'
export const CATALOG_FILTER_LABEL_SCORE_PERSPECTIVE = 'Score perspective'
export const CATALOG_FILTER_LABEL_MIN_SCORE = 'Min score'
export const CATALOG_FILTER_LABEL_SORT_SCORE = 'Sort by score'
export const FILTER_LABEL_SORT_DATE = 'Sort by date'
export const FILTER_SORT_DATE_NONE = 'None'
export const FILTER_SORT_DATE_NEWEST = 'Newest first'
export const FILTER_SORT_DATE_OLDEST = 'Oldest first'

export const CATALOG_FILTER_POSTED_ALL = 'All Images'
export const CATALOG_FILTER_POSTED = 'Posted'
export const CATALOG_FILTER_NOT_POSTED = 'Not Posted'

export const IMAGE_DETAIL_POSTED_LABEL = 'Posted to Instagram'
export const IMAGE_DETAIL_POSTED_ARIA = 'Mark whether this photo has been posted to Instagram'

export const CATALOG_FILTER_ANALYZED_ALL = 'All'
export const CATALOG_FILTER_ANALYZED_ONLY = 'Analyzed only'
export const CATALOG_FILTER_NOT_ANALYZED = 'Not analyzed'

export const CATALOG_FILTER_MIN_RATING_ANY = 'Any'
export const CATALOG_FILTER_SCORE_ANY = 'Any'
export const CATALOG_FILTER_SORT_NONE = 'None'
export const CATALOG_FILTER_SORT_HIGH_LOW = 'High → Low'
export const CATALOG_FILTER_SORT_LOW_HIGH = 'Low → High'

export const CATALOG_FILTER_KEYWORD_PLACEHOLDER = 'Search…'
export const CATALOG_FILTER_KEYWORD_ARIA = 'Keyword search'
export const FILTER_DESCRIPTION_SEARCH_LABEL = 'Description search'
export const FILTER_DESCRIPTION_SEARCH_PLACEHOLDER = 'Search AI description…'
export const FILTER_DESCRIPTION_SEARCH_ARIA =
  'Search AI-generated description (summary and subjects), not Lightroom keywords'
export const CATALOG_FILTER_COLOR_PLACEHOLDER = 'e.g. Red'
export const CATALOG_FILTER_COLOR_ARIA = 'Color label'

export const CATALOG_FILTER_LABEL_FRAME_SUBSTANCE = 'Flagged frames'
export const CATALOG_FILTER_FRAME_SUBSTANCE_ONLY = 'Flagged only'

export const FRAME_SUBSTANCE_LABEL = 'Frame substance'
export const FRAME_SUBSTANCE_NO_RUN = 'Not judged yet — no detection run has recorded a verdict for this image.'
export const FRAME_SUBSTANCE_MOUNT_SHARE =
  'Preview unavailable — mount the share and re-run frame substance detection.'
export const FRAME_SUBSTANCE_DECODE_FAILED =
  'Preview could not be decoded — this file is broken and will not fix itself.'
export const FRAME_SUBSTANCE_OK = 'Judged OK by the pixel detector.'
// Deliberately not the OK message: an unknown verdict means the detector
// could not read the image, which is not the same as reading it and
// finding it fine.
export const FRAME_SUBSTANCE_UNKNOWN_UNSPECIFIED =
  'Not judged — the detector could not read this image, for a reason it did not record.'
export const FRAME_SUBSTANCE_PIXEL_VOID = 'Pixel detector: void frame (Tier A — excluded from scoring).'
export const FRAME_SUBSTANCE_PIXEL_ILLEGIBLE =
  'Pixel detector: illegible frame (Tier B — ranked with existing scores).'
export const FRAME_SUBSTANCE_STALE =
  'This verdict was judged against an older preview. Re-run detection to refresh it.'
export const FRAME_SUBSTANCE_ADVISORY_LABEL =
  'Advisory excusal hint — all optional lenses scored not attempted. No automatic exclusion.'
export const FRAME_SUBSTANCE_OVERRIDE_RESTORE = 'Restore to ranking'
export const FRAME_SUBSTANCE_OVERRIDE_RESCORE_WARN =
  'Restoring this void frame will return it to ranking after the next scoring run.'
export const FRAME_SUBSTANCE_RESTORED = 'Restored to ranking via your override.'
export const FRAME_SUBSTANCE_CULL_MARK = 'Mark for cull (lrt-cull)'
export const FRAME_SUBSTANCE_CULL_UNMARK = 'Remove cull mark'
export const FRAME_SUBSTANCE_CATALOG_UNAVAILABLE = 'Lightroom catalog unavailable'

// Phase 06 — stack expand/collapse (STACK-03). On-demand similarity copy was removed in Phase 9 (SIM-02 pivoted to job-driven materialized groups).
export const CATALOG_STACK_SHOW = 'Show stack'
export const CATALOG_STACK_HIDE = 'Hide stack'
export const CATALOG_STACK_MEMBERS_ERROR = 'Couldn’t load stack members'
export const CATALOG_STACK_MEMBERS_LOADING = 'Loading…'
export const CATALOG_STACK_MEMBERS_REGION_ARIA = 'Stack members'
export const ACTION_UNDO = 'Undo'
export const CATALOG_STACK_SPLIT_OUT = 'Split out'
export const CATALOG_STACK_MAKE_REPRESENTATIVE = 'Make representative'
export const CATALOG_STACK_MERGE_INTO = 'Merge stack into this'
export const CATALOG_STACK_MERGE_SOURCE_ARIA = 'Source stack ID to merge'
export const CATALOG_STACK_MERGE_PLACEHOLDER = 'e.g. 12'
export const CATALOG_STACK_MERGE_RUN = 'Merge'
export const CATALOG_STACK_CONFIRM_SPLIT_TITLE = 'Remove from stack?'
export const CATALOG_STACK_CONFIRM_SPLIT_BODY =
  'This photo will leave the burst stack. You can re-group it later with stack detection.'
export const CATALOG_STACK_CONFIRM_REP_TITLE = 'Change representative?'
export const CATALOG_STACK_CONFIRM_REP_BODY =
  'The grid thumbnail for this stack will switch to this photo.'
export const CATALOG_STACK_CONFIRM_MERGE_TITLE = 'Merge stacks?'
export const CATALOG_STACK_CONFIRM_MERGE_BODY =
  'All photos from the source stack join this one. The source stack row is removed.'
export const CATALOG_STACK_TOAST_REP_UPDATED = 'Representative updated'

export function formatStackCountBadge(n: number): string {
  return `${n} in stack`
}

// Config
export const ITEMS_PER_PAGE = 48

// Job Details Modal
export const JOB_DETAILS_TITLE = 'Job Details'
export const JOB_DETAILS_PROGRESS = 'Progress'
export const JOB_DETAILS_CURRENT_STEP = 'Current Step'
export const JOB_DETAILS_METADATA = 'Metadata'
// Metadata is truncated to a preview by default (mirrors the logs tail/expand
// pattern). The header switches to a "(N of M lines)" label and a
// "Show full metadata" button reveals the complete payload.
export const JOB_DETAILS_METADATA_TRUNCATED_HEADER = (shown: number, total: number) =>
  `Metadata (${shown} of ${total} lines)`
export const JOB_DETAILS_METADATA_SHOW_ALL = (total: number) =>
  `Show full metadata (${total} lines)`
export const JOB_DETAILS_METADATA_COLLAPSE = 'Collapse metadata'
export const JOB_DETAILS_RESULT = 'Result'
// Result follows the same pattern as metadata — large JSON payloads get a
// preview by default with an explicit "Show full result" affordance.
export const JOB_DETAILS_RESULT_TRUNCATED_HEADER = (shown: number, total: number) =>
  `Result (${shown} of ${total} lines)`
export const JOB_DETAILS_RESULT_SHOW_ALL = (total: number) =>
  `Show full result (${total} lines)`
export const JOB_DETAILS_RESULT_COLLAPSE = 'Collapse result'
export const JOB_DETAILS_ERROR = 'Error'
export const JOB_DETAILS_LOGS = 'Logs'
export const JOB_DETAILS_LOGS_TRUNCATED_HEADER = (shown: number, total: number) =>
  `Logs (${shown} of ${total})`
export const JOB_DETAILS_LOGS_SHOW_ALL = (total: number) => `Show all ${total} logs`
export const JOB_DETAILS_LOGS_SHOW_ALL_LOADING = 'Loading…'
export const JOB_DETAILS_LOADING_ARIA = 'Loading job details'
export const JOB_DETAILS_FETCH_ERROR =
  'Could not refresh job details. Showing the last known summary.'
export const JOB_DETAILS_EMBED_DIAGNOSTICS_TITLE = 'Embed diagnostics'
export const JOB_SKIP_MISSING_FILE = "Missing file"
export const JOB_SKIP_EMPTY_PATH = "Empty path"
export const JOB_SKIP_NO_DB_ROW = "No DB row"

// Job Queue
export const JOB_QUEUE_PAGINATION_RANGE = (start: number, end: number, total: number) =>
  `Showing ${start}–${end} of ${total}`

// Job Configuration Display
export const JOB_CONFIG_METHOD = 'Matching Method'
export const JOB_CONFIG_DATE_WINDOW = 'Date Window'
export const JOB_CONFIG_VISION_MODEL = 'Vision Model'
export const JOB_CONFIG_THRESHOLD = 'Match Threshold'
export const JOB_CONFIG_WEIGHTS = 'Scoring Weights'

// Job Config Labels
export const JOB_WEIGHT_PHASH = 'pHash:'
export const JOB_WEIGHT_DESC = 'Description:'
export const JOB_WEIGHT_VISION = 'Vision:'

// Matching Page Advanced Options
export const ADVANCED_OPTIONS_TITLE = 'Advanced Options'
export const ADVANCED_DATE_ALL = 'All time'
export const ADVANCED_DATE_1MONTH = 'Last month'
export const ADVANCED_DATE_2MONTHS = 'Last 2 months'
export const ADVANCED_DATE_3MONTHS = 'Last 3 months'
export const ADVANCED_DATE_6MONTHS = 'Last 6 months'
export const ADVANCED_DATE_9MONTHS = 'Last 9 months'
export const ADVANCED_DATE_12MONTHS = 'Last 12 months'
export const ADVANCED_DATE_18MONTHS = 'Last 18 months'
export const ADVANCED_DATE_24MONTHS = 'Last 24 months'
export const ADVANCED_DATE_YEAR_2026 = '2026 only'
export const ADVANCED_DATE_YEAR_2025 = '2025 only'
export const ADVANCED_DATE_YEAR_2024 = '2024 only'
export const ADVANCED_DATE_YEAR_2023 = '2023 only'

export const ADVANCED_WORKERS_LABEL = 'Parallel Workers'
export const ADVANCED_WORKERS_DESCRIPTION = 'Process multiple images in parallel (higher = faster, more load)'
export const ADVANCED_WORKERS_MIN = '1 (sequential)'
export const ADVANCED_WORKERS_MAX = '4 (parallel)'

// Identity (Phase 8 / 08-02)
export const IDENTITY_PAGE_TITLE = 'Identity'
export const IDENTITY_PAGE_SUBTITLE =
  'Your photographic signature from critique scores, and what to post next.'
export const IDENTITY_MIRROR_SECTION = 'Mirror'
export const IDENTITY_MIRROR_INTRO =
  'Across your {count} analyzed catalog photos with multi-lens coverage. Each technique below is one your photos win on more often than chance — shown through the peak photos that prove it. Click any photo to see what makes it stand out.'
export const IDENTITY_MIRROR_EMPTY =
  'Not enough multi-lens scored catalog data yet. Score images on at least two active perspectives.'
export const IDENTITY_MIRROR_LOW_COVERAGE = 'scored on ~{pct}% of your catalog'
export const IDENTITY_MIRROR_WHY_HERE = "Why it's here"
export const IDENTITY_MIRROR_STANDOUT = 'Standout dimension'
export const IDENTITY_MIRROR_OTHER_LENSES = 'Other lenses'
export const IDENTITY_MIRROR_OTHER_LENSES_SUMMARY =
  'Active perspectives that did not clear the distinctive-signature bar. Expand to browse exemplars.'
export const IDENTITY_DIVIDER_BACKWARD = 'Who you are'
export const IDENTITY_DIVIDER_FORWARD = 'What to post next'
export const IDENTITY_SECTION_ADVISOR = 'Advisor'
export const IDENTITY_INTRO_ADVISOR =
  'Unposted catalog photos ranked by peak within-perspective percentile, with the lens that drives each ranking and whether it matches your Mirror signature.'
export const IDENTITY_ADVISOR_HELP =
  'Coverage-eligible images you have not posted yet. Signature labels are informational only — ranking uses peak percentile alone.'
export const IDENTITY_ADVISOR_EMPTY_FALLBACK = 'No suggestions right now.'
export const IDENTITY_SIGNATURE_LABEL = 'signature'
export const IDENTITY_BEST_PHOTOS_EMPTY_FALLBACK =
  'No eligible ranked photos yet. Run scoring on more perspectives per image to meet coverage.'
export const IDENTITY_LABEL_AGGREGATE = 'Aggregate'
export const IDENTITY_LABEL_PEAK = 'Peak'
export const IDENTITY_LABEL_PERSPECTIVES_COVERED = 'Perspectives scored'
export const IDENTITY_COL_PERSPECTIVE = 'Perspective'
export const IDENTITY_COL_SCORE = 'Score'
export const IDENTITY_COL_PROMPT_VERSION = 'Prompt version'
export const IDENTITY_COL_MODEL = 'Model'
export const IDENTITY_FINGERPRINT_CHART_TITLE = 'Mean score by perspective (1–10)'
export const IDENTITY_FINGERPRINT_DISTRIBUTION = 'Aggregate score distribution'
export const IDENTITY_FINGERPRINT_TOKENS = 'Top rationale tokens'
export const IDENTITY_FINGERPRINT_EVIDENCE = 'Example images'
export const IDENTITY_FINGERPRINT_EMPTY =
  'Not enough scored catalog data to chart. Score images across active perspectives.'
export const IDENTITY_FINGERPRINT_LOW_DATA = 'Some perspectives have no scores yet.'
export const IDENTITY_ACTION_OPEN_CATALOG = 'Open in catalog'
export const IDENTITY_REASON_CODE_LABELS: Record<string, string> = {
  high_score_unposted: 'High peak (unposted)',
  eligible_unposted: 'Eligible unposted',
}

// Cache Status
export const CACHE_TITLE = 'Vision Cache'
export const CACHE_PREPARE_BUTTON = 'Prepare Catalog'
export const CACHE_PREPARING = 'Preparing...'
export const CACHE_STATUS_LOADING = 'Loading cache status...'
export const CACHE_STATUS_CACHED = 'cached'
export const CACHE_STATUS_OF = 'of'
export const CACHE_STATUS_IMAGES = 'images'
export const CACHE_SIZE_LABEL = 'Cache size'
export const CACHE_TOTAL_CATALOG_IMAGES = 'Total Catalog Images'
export const CACHE_MISSING = 'Missing'
export const CACHE_PERCENT_CACHED = (pct: number) => `${pct}% cached`
export const CACHE_REFRESH_BUTTON = 'Refresh'
export const CACHE_JOB_RUNNING = 'Cache preparation in progress...'
export const CACHE_JOB_COMPLETED = 'Cache preparation completed!'
export const CACHE_WARNING_NOT_READY = 'Catalog not fully cached. Matching may be slower.'
export const PROCESSING_EMBED_CATALOG_TITLE = 'Embed catalog images'
export const PROCESSING_EMBED_CATALOG_BODY =
  'Generate visual embeddings for catalog photos so similarity search can run without missing-embedding errors.'
export const PROCESSING_EMBED_CATALOG_START = 'Run Embed images job'
export const PROCESSING_EMBED_CATALOG_STARTING = 'Starting Embed images job…'
export const PROCESSING_EMBED_CATALOG_QUEUED =
  'Embed images job queued. Open Job Queue to monitor progress.'
export const PROCESSING_EMBED_CATALOG_FAILED_PREFIX = 'Couldn’t start Embed images job:'
export const PROCESSING_OPEN_JOB_QUEUE = 'Open Job Queue'
export const PROCESSING_JOB_QUEUE_ROUTE = '/processing?tab=jobs'
export const PROCESSING_CATALOG_CACHE_ROUTE = '/processing?tab=cache'

/** Catalog Cache tab — composite pipeline + Advanced stage triggers (Phase 08 / CACHE-01). */
export const CATALOG_CACHE_BUILD_CTA = 'Build catalog cache'
export const CATALOG_CACHE_BUILD_SUCCESS =
  'Catalog cache build started! Check the Job Queue tab for progress.'
export const CATALOG_CACHE_CARD_TITLE = 'Catalog Vision Cache'
export const CATALOG_CACHE_INTRO_BODY =
  'The vision cache stores preprocessed Lightroom catalog images for fast AI comparison. Rebuilding the cache will process all catalog images and may take several minutes.'
export const CATALOG_CACHE_STAT_TOTAL_LABEL = 'Total Images'
export const CATALOG_CACHE_STAT_TOTAL_HELPER = 'Images in Lightroom catalog'
export const CATALOG_CACHE_STAT_CACHED_LABEL = 'Cached Images'
export const CATALOG_CACHE_STAT_CACHED_HELPER = 'Processed for AI matching'
export const CATALOG_CACHE_STAT_MISSING_LABEL = 'Missing'
export const CATALOG_CACHE_STAT_MISSING_HELPER = 'Not yet cached'
export const CATALOG_CACHE_STAT_SIZE_LABEL = 'Cache Size'
export const CATALOG_CACHE_STAT_SIZE_HELPER = 'Disk space used'
export const CATALOG_CACHE_PROGRESS_LABEL = 'Cache Progress'
export const CATALOG_CACHE_LOCATION_PREFIX = 'Cache Location:'
export const CATALOG_CACHE_NAS_TROUBLESHOOTING =
  'Network share (NAS) paths must be mounted and readable by the backend host. If the embed job skips most images, verify the catalog path is accessible from the server.'
export const CATALOG_CACHE_NAS_TROUBLESHOOTING_LINK_LABEL = 'Storage & mount troubleshooting'
export const CATALOG_CACHE_NAS_TROUBLESHOOTING_DOC_URL =
  'https://github.com/ccanalesb/lightroom-tagger/blob/main/docs/STORAGE_MOUNT_REQUIREMENTS.md'
/** Advanced — embed catalog rows only (`image_type: catalog`). */
/** Disclosure label for the catalog cache pipeline section.
 *
 * Distinct from `ADVANCED_OPTIONS_TITLE` (matching-only) because the cache tab
 * exposes pipeline triggers, not vision matching weights/provider/thresholds.
 */
export const CATALOG_CACHE_PIPELINE_TITLE = 'Pipeline stages'
export const CATALOG_CACHE_SYNC_LABEL = 'Sync catalog'
export const CATALOG_CACHE_SYNC_HELPER =
  'Pull newly imported catalog images into library.db (additions only — does not update ratings or remove stale rows).'
export const CATALOG_CACHE_EMBED_CATALOG_LABEL = 'Embed catalog images'
export const CATALOG_CACHE_STACK_DETECT_LABEL = 'Run stack detection'
export const CATALOG_CACHE_SIMILARITY_LABEL = 'Run catalog similarity'
export const CATALOG_CACHE_PREPARE_CATALOG_TITLE = 'Pre-compress catalog images'

/** One-sentence explanations shown next to each pipeline trigger so users
 * understand what the job does before clicking. Kept short (≤ ~20 words). */
export const CATALOG_CACHE_EMBED_CATALOG_HELPER =
  'Compute CLIP visual embeddings for every catalog image so catalog similarity can find related shots. Catalog file paths must be readable from the server — mount NAS shares before running.'
export const CATALOG_CACHE_PIPELINE_JOB_QUEUED = (label: string) =>
  `${label} job queued. Open Job Queue to monitor progress.`
export const CATALOG_CACHE_STACK_DETECT_HELPER =
  'Group burst-shot catalog images into stacks by date so only the representative frame is described and scored.'
export const CATALOG_CACHE_SIMILARITY_HELPER =
  'Materialize catalog-to-catalog similarity groups for review (preview shown above).'

/** Last-run badge labels rendered next to each trigger.
 *
 * The status itself is already shown via a coloured `Badge`, so the inline
 * text only repeats the relative time. Format intentionally omits punctuation
 * so it reads cleanly next to the status pill (e.g. `completed · Last run
 * 5 minutes ago`). */
export const CATALOG_CACHE_LAST_RUN_NEVER = 'Never run'
export const CATALOG_CACHE_LAST_RUN_LABEL = (ago: string) => `Last run ${ago}`
export const CATALOG_CACHE_PREPARE_CATALOG_HELPER =
  "Decodes and compresses every catalog image (RAW → JPEG) so vision matching, description, and scoring jobs don't pay decode cost on the hot path. Optional — runs lazily on first use if skipped."

/** Primary card — latest similarity groups preview. */
export const CATALOG_CACHE_SIMILARITY_PREVIEW_TITLE = 'Latest similarity groups'
export const CATALOG_CACHE_SIMILARITY_EMPTY =
  'No catalog similarity groups yet. Run catalog similarity from Pipeline stages after Embed Images completes.'
export const CATALOG_CACHE_SIMILARITY_TOTAL_GROUPS_LABEL = (n: number) =>
  `${n} group${n === 1 ? '' : 's'}`
export const CATALOG_CACHE_SIMILARITY_VIEW_ALL = 'View all'
export const CATALOG_CACHE_SIMILARITY_BEST_MATCH_PCT = (pct: number) => `Best match ${pct}%`
export const CATALOG_CACHE_SIMILARITY_CANDIDATE_LABEL = (n: number) =>
  `${n} candidate${n === 1 ? '' : 's'}`

// Descriptions Page
export const DESC_PAGE_TITLE = 'AI Descriptions'
export const DESC_PAGE_TAB_ALL = 'All'
export const DESC_PAGE_TAB_CATALOG = 'Catalog'
export const DESC_PAGE_BATCH_CATALOG = 'Generate Catalog Descriptions'
export const DESC_PAGE_BATCH_ALL = 'Generate All Descriptions'
export const DESC_PAGE_BATCH_RUNNING = 'Generating...'
export const DESC_PAGE_MODEL_LABEL = 'Vision Model'
export const DESC_PAGE_SOURCE_CATALOG = 'Source: catalog file'
export const DESC_PAGE_FILTER_ALL = 'All time'
export const DESC_PAGE_FILTER_3M = 'Last 3 months'
export const DESC_PAGE_FILTER_6M = 'Last 6 months'
export const DESC_PAGE_FORCE = 'Force regenerate'
export const DESC_PAGE_GENERATE = 'Generate'
export const DESC_PAGE_REGENERATE = 'Regenerate'
export const DESC_PAGE_GENERATING = 'Generating...'
export const DESC_PAGE_NO_DESCRIPTION = 'No description yet'
export const DESC_PAGE_EMPTY = 'No images found.'

export const DESC_BATCH_JOB_STARTED = (idPrefix: string) => `Job started (ID: ${idPrefix})`
export const DESC_BATCH_VIEW_IN_JOBS = 'View in Jobs'
export const DESC_BATCH_FAILED_PREFIX = 'Failed:'

// Description Panel
export const DESC_PANEL_TITLE = 'AI Description'
export const DESC_PANEL_SUMMARY = 'Summary'
export const DESC_PANEL_COMPOSITION = 'Composition'
export const DESC_PANEL_TECHNICAL = 'Technical'
export const DESC_PANEL_SUBJECTS = 'Subjects'
export const DESC_PANEL_MODEL = 'Model'
export const DESC_PANEL_NO_DESCRIPTION = 'No AI description available'

export const DESC_COMPOSITION_DEPTH = 'Depth:'
export const DESC_COMPOSITION_BALANCE = 'Balance:'
export const DESC_TECHNICAL_MOOD = 'Mood:'
export const DESC_TECHNICAL_LIGHTING = 'Lighting:'
export const DESC_TECHNICAL_TIME = 'Time:'
export const DESC_TECHNICAL_COLORS = 'Colors:'

// Providers Page
export const NAV_PROVIDERS = 'Providers'
export const PROVIDER_TITLE = 'Provider Configuration'
export const PROVIDER_STATUS_AVAILABLE = 'Available'
export const PROVIDER_STATUS_UNAVAILABLE = 'Unavailable'
export const PROVIDER_MODELS_HEADING = 'Models'
export const PROVIDER_FALLBACK_HEADING = 'Fallback Order'
export const PROVIDER_FALLBACK_DESCRIPTION = 'When a provider fails, requests cascade in this order.'
export const PROVIDER_SOURCE_CONFIG = 'built-in'
export const PROVIDER_SOURCE_DISCOVERED = 'auto-discovered'
export const PROVIDER_SOURCE_USER = 'user-added'
export const PROVIDER_NO_MODELS = 'No models available'
export const PROVIDER_COL_MODEL = 'Model'
export const PROVIDER_COL_VISION = 'Vision'
export const PROVIDER_COL_SOURCE = 'Source'
export const PROVIDER_COL_ACTIONS = 'Actions'
export const PROVIDER_SELECT_LABEL = 'Provider'
export const PROVIDER_MODEL_SELECT_LABEL = 'Model'
export const PROVIDER_AUTO_DEFAULT = 'Auto (default)'
export const PROVIDER_MODEL_AUTO_FIRST = 'Auto (first available)'
export const PROVIDER_MOVE_UP = 'Move provider up in fallback order'
export const PROVIDER_MOVE_DOWN = 'Move provider down in fallback order'
export const PROVIDER_REMOVE_MODEL = 'Remove user-added model'
export const PROVIDER_ADD_MODEL_ID_LABEL = 'Model ID'
export const PROVIDER_ADD_MODEL_NAME_LABEL = 'Display name'
export const PROVIDER_ADD_MODEL_VISION_LABEL = 'Supports vision'
export const PROVIDER_ADD_MODEL_SUBMIT = 'Add model'
export const PROVIDER_ADD_MODEL_SUBMITTING = 'Adding…'
export const PROVIDER_ADD_MODEL_ERROR = 'Could not add model. Please try again.'

// Generic Buttons
export const BTN_DISMISS = 'Dismiss'
export const BTN_RETRY = 'Retry'

// Provider Inline Labels
export const PROVIDER_STATUS_SUFFIX_UNAVAILABLE = '(unavailable)'

// Description Generation Errors
export const DESC_ERROR_RATE_LIMIT = 'Rate limited — try a different provider or wait.'
export const DESC_ERROR_AUTH = 'Authentication failed — check your API key.'
export const DESC_ERROR_UNAVAILABLE = 'Provider unavailable — try a different provider.'
export const DESC_ERROR_GENERIC = 'Description generation failed.'

// Analyze (Processing → Analyze tab, Phase 3 / JOB-06)
export const ANALYZE_CARD_TITLE = 'Analyze Images'
export const ANALYZE_CARD_SUBTITLE =
  'Run AI description + scoring in a single job. Advanced options let you run stages separately.'
export const ANALYZE_PRIMARY_BUTTON = 'Analyze'
export const ANALYZE_PRIMARY_BUTTON_STARTING = 'Starting…'
export const ANALYZE_ADVANCED_RUN_SEPARATELY_TITLE = 'Run stages separately'
export const ANALYZE_ADVANCED_DESCRIBE_ONLY = 'Generate Descriptions only'
export const ANALYZE_ADVANCED_SCORE_ONLY = 'Run scoring only'
export const ANALYZE_FORCE_DESCRIBE_LABEL = 'Force regenerate descriptions'
export const ANALYZE_FORCE_SCORE_LABEL = 'Force regenerate scores'
export const ANALYZE_BACKFILL_VISUAL_TAGS_LABEL =
  'Backfill visual tags (re-describe images with missing color/mood data)'
export const ANALYZE_BACKFILL_FORCE_EXCLUSIVE_HINT =
  'Backfill and force regenerate cannot be combined — only one mode is active at a time.'
export const ANALYZE_JOB_STARTED =
  'Analyze job started! Check Job Queue tab to monitor progress.'
export const ANALYZE_DESCRIBE_JOB_STARTED =
  'Description generation job started! Check Job Queue tab to monitor progress.'
export const ANALYZE_SCORE_JOB_STARTED =
  'Batch scoring job started (1–10 scores + short rationale per perspective). Check Job Queue for progress.'
export const ANALYZE_JOB_FAILED_PREFIX = 'Failed to start job:'

// Cull UI (#340)
export const CULL_HEADING = (n: number) =>
  n === 1 ? '1 photo did not pass the cull' : `${n} photos did not pass the cull`
export const CULL_SUB_MANUAL = (m: number) => `${m} already sent manually.`
export const CULL_SUB_AUTO =
  'They are not described or scored automatically.'
export const CULL_LAST_CHECKED = 'Last checked'
export const CULL_SORT_HINT = 'Sorted by score forecast, highest first'
export const CULL_SELECT_ALL = (n: number) => `Select all ${n}`
export const CULL_AGREE = 'Agree with culling'
export const CULL_AGREED = 'Agreed'
export const CULL_CLEAR = 'Clear'
export const CULL_ALREADY_SCORED = (d: number) => `· ${d} already described and scored`
export const CULL_DETAIL_SECTION = 'Culling'
export const CULL_MANUALLY_CULL = 'Manually cull'
export const CULL_MANUALLY_CULL_NOTE =
  'Manually cull — never cut automatically again.'
export const CULL_SHOULD_HAVE_BEEN_CUT = 'Should have been cut'
export const CULL_RECIPES_SECTION = 'Culling recipes'
export const CULL_ADD_RECIPE = 'Add recipe'
export const CULL_DUPLICATE = 'Duplicate'
export const CULL_NOT_MEASURED = 'Not measured against AI scores'
export const CULL_ADVANCED = 'Advanced'
export const CULL_SCORE_FORECAST_THRESHOLD = 'Score forecast threshold'
export const CULL_THRESHOLD_NOTE =
  'Changing this re-checks every photo from stored answers (no new model run).'
export const CULL_SAVE = 'Save'
export const CULL_SAVE_ONLY = 'Save only'
export const CULL_SAVE_AND_QUEUE = 'Save and queue cull job'
export const CULL_RULE_SAVE_NOTE =
  'Saving re-checks every photo from stored answers (no new model run).'
export const CULL_SCORE_FORECAST = 'Score forecast'
export const CULL_MODAL_PREV = 'Prev'
export const CULL_MODAL_NEXT = 'Next'
export const CULL_RECIPE_MODEL = 'Model'
export const CULL_RECIPE_ADD_LEVEL = 'Add level'
export const CULL_RECIPE_ADD_LEVEL_SET = 'Add level set'
export const CULL_RECIPE_FAILS_AT = 'fails at'
export const CULL_RECIPE_STRONG_AT = 'strong at'
export const CULL_RECIPE_COMBINE_EVERY = 'Cut when every set cuts'
export const CULL_RECIPE_COMBINE_ANY = 'Cut when any set cuts'
export const CULL_RECIPE_RULE_ALL_FAIL = 'All of these fail'
export const CULL_RECIPE_RULE_N_FAIL = 'N or more fail unless one is strong'
export const CULL_RECIPE_RULE_MEAN = 'The average fails'
export const CULL_RECIPE_UNMEASURED_HINT =
  'Not measured against AI scores — check what it cuts in Processing → Cull.'
export const CULL_RECIPE_TEXT_SAVE_IMPACT = (photos: number, hours: number) =>
  `Saving text re-answers every catalog photo (~${hours.toFixed(2)} h, ${photos} photos × 2 s).`
export const CULL_RECIPE_ACTIVE = 'Active'
export const CULL_RECIPE_INACTIVE = 'Inactive'
export const CULL_RECIPE_ACTIVATE = 'Activate'
export const CULL_RECIPE_DEACTIVATE = 'Deactivate'

// Lightroom write-back (#341)
export const LR_WRITEBACK_SECTION = 'Lightroom write-back'
export const LR_WRITEBACK_SECTION_LEAD =
  'What the cull writes back to your Lightroom catalog. Off until you turn it on. Which level set gives stars is set in each culling recipe (Perspectives).'
export const LR_WRITEBACK_STARS_SWITCH = 'Write stars to Lightroom'
export const LR_WRITEBACK_STARS_HELP =
  "Stars from the culling recipe's strong dimensions: 1 strong ★, 2 strong ★★, 3 or more ★★★. Only photos with no rating; photos you rated are never touched. Marked with the keyword lrt-auto-stars."
export const LR_WRITEBACK_REJECT_SWITCH = 'Write the reject flag to Lightroom'
export const LR_WRITEBACK_REJECT_HELP =
  'Photos the culling recipe cut get the reject flag, only when they have no flag; flags you set are never touched. Photos held back by the score forecast are not flagged. Marked with the keyword lrt-auto-reject.'
export const LR_WRITEBACK_STARS_RECIPE = 'Culling recipe for stars'
export const LR_WRITEBACK_STATUS_TITLE = 'Lightroom write-back'
export const LR_WRITEBACK_STATUS_HELP =
  'Written automatically when a cull ends, if Lightroom is closed. Otherwise the photos wait until the next cull, or until you write them now.'
export const LR_WRITEBACK_PENDING = 'photos pending'
export const LR_WRITEBACK_WRITTEN = 'photos written'
export const LR_WRITEBACK_LR_OPEN = 'Lightroom is open'
export const LR_WRITEBACK_LR_CLOSED = 'Lightroom is closed'
export const LR_WRITEBACK_WRITE_NOW = 'Write pending now'
export const LR_WRITEBACK_CLOSE_LR = 'Close Lightroom to write'
export const LR_WRITEBACK_STARS_STRONG_FROM = 'Count a dimension as strong when it is'
export const LR_WRITEBACK_STARS_STRONG_FROM_HELP = 'Used for the stars written to Lightroom.'
export const LR_WRITEBACK_STRONG_FROM_7 = '7-level set'
export const LR_WRITEBACK_STRONG_FROM_10 = '10-level set'
export const LR_WRITEBACK_STRONG_FROM_EVERY = 'Strong in every level set (7 and 10)'
export const LR_WRITEBACK_STRONG_FROM_ANY = 'Strong in any level set (7 or 10)'
export const LR_WRITEBACK_DETAIL_SECTION = 'Lightroom'
export const LR_WRITEBACK_RATING = 'Rating'
export const LR_WRITEBACK_FLAG = 'Flag'
export const LR_WRITEBACK_KEYWORDS = 'Keywords'
export const LR_WRITEBACK_UNDO = 'Undo'
export const LR_WRITEBACK_BEFORE_NO_RATING = 'before: no rating'
export const LR_WRITEBACK_USER_CHANGED = 'You changed this in Lightroom after the app wrote it.'
export const LR_WRITEBACK_SWITCH_ON_TOAST = (n: number, kind: string) =>
  `${n.toLocaleString('en-US')} photos pending — written when the next cull ends (${kind})`
export const LR_WRITEBACK_WRITE_RESULT = (n: number) => `Wrote ${n.toLocaleString('en-US')} photos to Lightroom`
export const LR_WRITEBACK_LOADING = 'Loading Lightroom write-back…'
