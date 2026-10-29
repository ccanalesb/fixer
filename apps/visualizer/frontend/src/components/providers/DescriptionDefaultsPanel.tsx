import type { Provider, ProviderModel } from '../../services/api';
import { PROVIDER_DESCRIPTIONS_WILL_NOT_RUN } from '../../constants/strings';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { ProviderModelSelect } from '../ui/ProviderModelSelect';
import { anyPhotoProvider } from './providerUsability';

interface DescriptionDefaultsPanelProps {
  providers: Provider[];
  fallbackOrder: string[];
  modelCache: Record<string, ProviderModel[]>;
  descriptionProvider: string | null;
  descriptionModel: string | null;
  onDescriptionChange: (providerId: string | null, modelId: string | null) => void;
  defaultsNotice: string | null;
  onSave: () => void;
  saveMessage: string | null;
}

export function DescriptionDefaultsPanel({
  providers,
  fallbackOrder,
  modelCache,
  descriptionProvider,
  descriptionModel,
  onDescriptionChange,
  defaultsNotice,
  onSave,
  saveMessage,
}: DescriptionDefaultsPanelProps) {
  const canRun = anyPhotoProvider(providers, fallbackOrder, modelCache);

  return (
    <Card padding="lg">
      <h4 className="text-base font-semibold text-text mb-1">Default models</h4>
      <p className="text-sm font-medium text-text mb-3">Descriptions</p>
      {defaultsNotice ? (
        <p className="text-sm text-warning mb-3" role="status">
          {defaultsNotice}
        </p>
      ) : null}
      {!canRun ? (
        <p className="text-sm text-error mb-3" role="status">
          {PROVIDER_DESCRIPTIONS_WILL_NOT_RUN}
        </p>
      ) : null}
      <ProviderModelSelect
        providerId={descriptionProvider}
        modelId={descriptionModel}
        onChange={onDescriptionChange}
      />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={!canRun || !descriptionProvider} onClick={onSave}>
          Save
        </Button>
        {saveMessage ? (
          <span className="text-sm text-success" role="status">
            {saveMessage}
          </span>
        ) : null}
      </div>
    </Card>
  );
}
