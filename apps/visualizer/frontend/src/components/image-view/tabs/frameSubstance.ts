import { FrameSubstanceAPI, type FrameSubstanceResponse } from '../../../services/api'
import { keys } from '../../../data/keys'
import {
  FRAME_SUBSTANCE_DECODE_FAILED,
  FRAME_SUBSTANCE_MOUNT_SHARE,
  FRAME_SUBSTANCE_NO_RUN,
  FRAME_SUBSTANCE_OK,
  FRAME_SUBSTANCE_PIXEL_ILLEGIBLE,
  FRAME_SUBSTANCE_PIXEL_VOID,
  FRAME_SUBSTANCE_UNKNOWN_UNSPECIFIED,
} from '../../../constants/strings'

export const frameSubstanceQuery = (imageKey: string) =>
  [keys.frameSubstance(imageKey), () => FrameSubstanceAPI.get(imageKey)] as const

// An unknown verdict never falls back to the OK message: absence of a
// reading is not a clean reading, and reading silence as approval is the
// one thing this block must never do.
function unknownReasonMessage(reason: string | null | undefined): string {
  switch (reason) {
    case 'no_cache_row':
    case 'oversized_sentinel':
    case 'cache_file_missing':
      return FRAME_SUBSTANCE_MOUNT_SHARE
    case 'decode_failed':
      return FRAME_SUBSTANCE_DECODE_FAILED
    default:
      return reason ? `${FRAME_SUBSTANCE_UNKNOWN_UNSPECIFIED} (${reason})` : FRAME_SUBSTANCE_UNKNOWN_UNSPECIFIED
  }
}

export function frameVerdictSummary(data: FrameSubstanceResponse): string {
  if (data.verdict == null) return FRAME_SUBSTANCE_NO_RUN
  if (data.verdict === 'unknown') return unknownReasonMessage(data.unknown_reason)
  if (data.verdict === 'ok') return FRAME_SUBSTANCE_OK
  if (data.instrument?.kind === 'pixel_detector') {
    return data.verdict === 'void' ? FRAME_SUBSTANCE_PIXEL_VOID : FRAME_SUBSTANCE_PIXEL_ILLEGIBLE
  }
  return data.verdict
}

/** A frame the detector read and found OK, with nothing else to report, needs no block. */
export function frameSaysNothing(data: FrameSubstanceResponse): boolean {
  return data.verdict === 'ok' && !data.is_stale && !data.has_override && data.instrument == null
}

/** Left out of ranking and not put back by the user. */
export function frameHeldBack(data: FrameSubstanceResponse): boolean {
  return data.flagged && !data.has_override
}
