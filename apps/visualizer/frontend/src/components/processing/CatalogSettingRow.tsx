import { useState } from 'react';
import { useCatalogPicker } from '../../hooks';
import { Button } from '../ui/Button/Button';
import { Input } from '../ui/Input/Input';
import { PathSummary, SettingRow } from './SettingRow';

export function CatalogSettingRow() {
  const {
    status,
    draftPath,
    setDraftPath,
    changesCatalog,
    loading,
    picking,
    saving,
    error,
    pick,
    save,
  } = useCatalogPicker();
  // `null` means the user has not touched the disclosure, so it follows whether
  // there is a dialog to prefer over it.
  const [typing, setTyping] = useState<boolean | null>(null);

  if (loading) {
    return <SettingRow name="Lightroom Classic catalog" description="Loading…" control={null} />;
  }

  // No status and not loading means the read failed. Without this the row would
  // sit on "Loading…" forever and the error would have nowhere to go.
  if (!status) {
    return (
      <SettingRow
        name="Lightroom Classic catalog"
        description={<span className="text-error">{error ?? 'Could not read the setting'}</span>}
        control={null}
      />
    );
  }

  // Typing is the fallback where a dialog is on offer and the only way in where
  // it is not, so with no usable dialog the field starts open.
  const manual = typing ?? !status.pickerUsable;
  const busy = picking || saving;

  // Only a saved path closes the field: on failure the value stays where the
  // user can correct it.
  const commit = async () => {
    if (await save()) setTyping(null);
  };

  const cancel = () => {
    setDraftPath(status.path);
    setTyping(null);
  };

  const saveButton = (
    <Button
      type="button"
      size="sm"
      variant="primary"
      onClick={commit}
      disabled={busy || !changesCatalog}
    >
      {saving ? 'Saving…' : 'Save'}
    </Button>
  );

  const cancelButton = (
    <Button type="button" size="sm" variant="ghost" onClick={cancel} disabled={saving}>
      Cancel
    </Button>
  );

  return (
    <SettingRow
      name="Lightroom Classic catalog"
      description={
        changesCatalog ? (
          <span className="flex min-w-0 text-warning">
            <PathSummary path={draftPath} />
            <span className="flex-shrink-0">&nbsp;— not saved</span>
          </span>
        ) : status.exists ? (
          <PathSummary path={status.resolvedPath} />
        ) : (
          <span className="text-error">
            {status.path ? 'No file at this path — catalog sync will fail' : 'Not set'}
          </span>
        )
      }
      control={
        <>
          {status.pickerUsable && (
            // One way in at a time: with the field open, the dialog would
            // overwrite what is being typed.
            <Button
              type="button"
              size="sm"
              variant={status.exists || changesCatalog ? 'secondary' : 'primary'}
              onClick={pick}
              disabled={manual || busy}
            >
              {picking ? 'Choosing…' : 'Choose…'}
            </Button>
          )}
          {!manual && changesCatalog && (
            <>
              {saveButton}
              {cancelButton}
            </>
          )}
        </>
      }
      under={
        <>
          {/* Two warnings, because saving does not end the problem: the draft one
              says a sync will be needed, and `needsSync` says it still is. */}
          {changesCatalog ? (
            <p className="mb-3 text-sm text-warning">
              A different catalog than the library database was built from. Run a catalog sync after
              saving, or what you see stays out of date.
            </p>
          ) : (
            status.needsSync && (
              <p className="mb-3 text-sm text-warning">
                The library database was built from a different catalog. Run a catalog sync, or what
                you see stays out of date.
              </p>
            )
          )}
          {error && <p className="mb-3 text-sm text-error">{error}</p>}
          <details open={manual} className="group">
            <summary
              // Locked while the dialog is open or a save is in flight: opening
              // the field then would let the dialog's answer land on top of
              // whatever was being typed.
              aria-disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                if (busy) return;
                setTyping(!manual);
              }}
              className={`inline-flex list-none items-center gap-1 text-sm [&::-webkit-details-marker]:hidden ${
                busy ? 'cursor-default text-text-tertiary' : 'cursor-pointer text-accent'
              }`}
            >
              <span className="inline-block transition-transform group-open:rotate-90">›</span>
              Enter a path manually
            </summary>
            <div className="mt-3 space-y-3">
              <Input
                label="Catalog path (.lrcat)"
                value={draftPath}
                onChange={(e) => setDraftPath(e.target.value)}
                fullWidth
              />
              <div className="flex flex-wrap gap-2">
                {saveButton}
                {cancelButton}
              </div>
            </div>
          </details>
        </>
      }
    />
  );
}
