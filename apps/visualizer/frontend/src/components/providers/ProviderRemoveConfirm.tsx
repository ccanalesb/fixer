import type { Job, Provider, ProviderModel } from '../../services/api';
import {
  PROVIDER_REMOVE_CONFIRM_CANCEL,
  PROVIDER_REMOVE_CONFIRM_OK,
  PROVIDER_REMOVE_CONFIRM_SWITCH_HINT,
} from '../../constants/strings';
import { ConfirmModalFrame } from '../ui/ConfirmUndoAction';

const VISION_JOB_TYPES = new Set([
  'single_describe',
  'batch_describe',
  'batch_score',
  'batch_analyze',
]);

export function jobsUsingProvider(jobs: Job[], providerId: string): Job[] {
  return jobs.filter(
    job =>
      VISION_JOB_TYPES.has(job.type) &&
      (job.metadata?.provider_id === providerId ||
        (job.type === 'batch_analyze' && job.metadata?.provider_id === providerId)),
  );
}

interface ProviderRemoveConfirmProps {
  provider: Provider;
  models: ProviderModel[];
  activeJobs: Job[];
  isDescriptionDefault: boolean;
  cullingStageNames?: string[];
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}

export function ProviderRemoveConfirm({
  provider,
  models,
  activeJobs,
  isDescriptionDefault,
  cullingStageNames,
  onConfirm,
  onCancel,
  busy = false,
}: ProviderRemoveConfirmProps) {
  const using = jobsUsingProvider(activeJobs, provider.id);

  return (
    <ConfirmModalFrame
      title={`Remove ${provider.name}?`}
      confirmLabel={PROVIDER_REMOVE_CONFIRM_OK}
      cancelLabel={PROVIDER_REMOVE_CONFIRM_CANCEL}
      onConfirm={onConfirm}
      onCancel={onCancel}
      busy={busy}
    >
      <ul className="list-disc pl-5 text-sm text-text-secondary space-y-2">
        {using.length > 0 ? (
          <li>
            {using.length} running or queued job{using.length === 1 ? '' : 's'} name this provider.
            They will continue on the rest of the cascade.
          </li>
        ) : null}
        {isDescriptionDefault ? (
          <li>The description default points here. It will move to the next provider that can read a photo.</li>
        ) : null}
        {cullingStageNames && cullingStageNames.length > 0 ? (
          <li>
            {cullingStageNames.join(' and ')} use this endpoint today. They will have no endpoint until you choose
            another in Culling models.
          </li>
        ) : null}
        {models.length > 0 ? (
          <li>
            Its models ({models.map(m => m.name || m.id).join(', ')}) will be removed from Fixer.
          </li>
        ) : null}
      </ul>
      <p className="text-sm text-text-secondary">{PROVIDER_REMOVE_CONFIRM_SWITCH_HINT}</p>
    </ConfirmModalFrame>
  );
}
