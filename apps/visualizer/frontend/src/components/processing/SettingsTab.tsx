import { CatalogSettingRow } from './CatalogSettingRow';
import { LightroomWritebackSection } from './LightroomWritebackSection';
import { StackDetectionSettingRow } from './StackDetectionSettingRow';

export function SettingsTab() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-card-title text-text mb-2">General Settings</h3>
        <p className="text-sm text-text-secondary">
          Configure catalog path and application preferences
        </p>
      </div>

      <div className="divide-y divide-border rounded-base border border-border bg-bg">
        <CatalogSettingRow />
        <StackDetectionSettingRow />
      </div>

      <LightroomWritebackSection />
    </div>
  );
}
