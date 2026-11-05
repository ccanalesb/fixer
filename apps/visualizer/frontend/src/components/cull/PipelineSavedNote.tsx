import { Link } from 'react-router-dom'
import {
  CULLING_MODELS_SAVED,
  CULLING_MODELS_SAVED_JOB_WAITING,
  CULLING_MODELS_VIEW_QUEUE,
  PROCESSING_JOB_QUEUE_ROUTE,
} from '../../constants/strings'

/** After a culling pipeline change: saved, whether its re-decide job is queued or waiting, and a link to the queue. */
export function PipelineSavedNote({ jobId }: { jobId: string | null }) {
  return (
    <p className="text-sm text-success">
      {jobId ? CULLING_MODELS_SAVED : CULLING_MODELS_SAVED_JOB_WAITING}{' '}
      <Link to={PROCESSING_JOB_QUEUE_ROUTE} className="text-accent underline">
        {CULLING_MODELS_VIEW_QUEUE}
      </Link>
    </p>
  )
}
