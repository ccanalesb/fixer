import type { Job } from '../types/job'
import {
  catalogCacheBuildStageState,
  catalogCacheBuildSyncComplete,
  parseEmbedProgressDetail,
} from './catalogCacheBuildProgress'

/** Display total for CLIP vision ONNX (matches backend `CLIP_MODEL_PROGRESS_TOTAL_MB`). */
export const CLIP_MODEL_PROGRESS_TOTAL_MB = 352

export const CLIP_DOWNLOAD_ROW_LABEL = 'Downloading the image model (once)'

const CLIP_DOWNLOAD_STEP_PREFIX = 'Downloading the image model (once)'

export function isJobClipDownloading(job: Job | null | undefined): boolean {
  if (!job) return false
  if (job.clip_model_download_loaded_bytes != null || job.clip_model_download_total_bytes != null) {
    return true
  }
  return job.current_step?.startsWith(CLIP_DOWNLOAD_STEP_PREFIX) ?? false
}

export function isClipDownloadJobFailure(job: Job | null | undefined): boolean {
  if (!job || job.status !== 'failed') return false
  const err = job.error ?? ''
  return err.includes('huggingface.co') && err.includes('image model')
}

export function clipDownloadProgressLabel(job: Job | null | undefined): string {
  if (!job) return ''
  const loaded = job.clip_model_download_loaded_bytes ?? 0
  if (loaded <= 0) return 'Connecting to huggingface.co…'
  const loadedMb = Math.min(
    Math.round(loaded / 1_000_000),
    CLIP_MODEL_PROGRESS_TOTAL_MB,
  )
  return `${loadedMb} / ${CLIP_MODEL_PROGRESS_TOTAL_MB} MB`
}

export function clipDownloadFailureRightLabel(job: Job | null | undefined): string {
  if (!job) return ''
  const loaded = job.clip_model_download_loaded_bytes ?? 0
  const loadedMb = Math.min(
    Math.round(loaded / 1_000_000),
    CLIP_MODEL_PROGRESS_TOTAL_MB,
  )
  if (loadedMb <= 0) return "couldn't connect"
  return `stopped at ${loadedMb} / ${CLIP_MODEL_PROGRESS_TOTAL_MB} MB`
}

export type ClipDownloadRowState = 'hidden' | 'pending' | 'current' | 'done' | 'failed'

export function clipDownloadRowState(
  job: Job | null | undefined,
  expectDownloadInRun: boolean,
): ClipDownloadRowState {
  if (!job || !expectDownloadInRun) return 'hidden'
  const syncDone = catalogCacheBuildSyncComplete(job)
  if (!syncDone && !isClipDownloadJobFailure(job)) return 'hidden'
  if (isClipDownloadJobFailure(job)) return 'failed'
  if (job.status === 'completed') return 'done'
  if (isJobClipDownloading(job)) return 'current'
  if (syncDone && (job.status === 'running' || job.status === 'pending')) {
    if (parseEmbedProgressDetail(job.current_step) != null) return 'done'
    if (catalogCacheBuildStageState('stack', job) !== 'pending') return 'done'
    return 'current'
  }
  return 'hidden'
}
