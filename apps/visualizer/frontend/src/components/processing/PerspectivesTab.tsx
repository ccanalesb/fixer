import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { Suspense, useCallback, useEffect, useState, useTransition } from 'react';
import { ErrorBoundary, ErrorState, invalidateAll, useQuery } from '../../data';
import { Modal } from '../modal/Modal';
import { Badge } from '../ui/badges';
import { Button } from '../ui/Button';
import { FoldingCard } from '../ui/Card';
import { NAV_PERSPECTIVES_HELP, PERSPECTIVES_SUMMARY } from '../../constants/strings';
import { PerspectivesAPI, type PerspectiveSummary } from '../../services/api';
import { CullingRecipesSection } from '../cull/CullingRecipesSection';

const NEW_TEMPLATE = `# Perspective

Add instructions for this critique lens. Include theory basis and scoring anchors as needed.
`;

function slugifyDisplay(slug: string): string {
  return slug
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

function PerspectivesListPanel({
  rows,
  selectedSlug,
  onSelect,
  onToggleActive,
  onRefresh,
  onAdd,
}: {
  rows: PerspectiveSummary[];
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
  onToggleActive: (row: PerspectiveSummary, next: boolean) => void;
  onRefresh: () => void;
  onAdd: () => void;
}) {
  return (
    <div className="w-full lg:w-72 shrink-0 space-y-3">
      <div className="flex gap-2">
        <Button type="button" variant="primary" size="sm" onClick={onAdd}>
          Add perspective
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
      <div className="border border-border rounded-base divide-y divide-border max-h-[480px] overflow-y-auto bg-bg">
        {rows.length === 0 ? (
          <p className="p-3 text-sm text-text-secondary">No perspectives</p>
        ) : (
          rows.map((row) => (
            <div
              key={row.slug}
              className={`p-3 cursor-pointer hover:bg-surface transition-colors ${
                selectedSlug === row.slug ? 'bg-surface border-l-2 border-l-accent' : ''
              }`}
              onClick={() => onSelect(row.slug)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                  ev.preventDefault();
                  onSelect(row.slug);
                }
              }}
              role="button"
              tabIndex={0}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-medium text-text">{row.slug}</div>
                  <div className="text-xs text-text-secondary mt-0.5">{row.display_name}</div>
                </div>
                <Badge variant={row.active ? 'success' : 'default'}>
                  {row.active ? 'Active' : 'Inactive'}
                </Badge>
              </div>
              <label
                className="mt-2 flex items-center gap-2 text-sm text-text cursor-pointer"
                onClick={(ev) => ev.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={row.active}
                  onChange={(ev) => void onToggleActive(row, ev.target.checked)}
                  className="w-4 h-4 rounded border-border text-accent focus:ring-accent focus:ring-offset-0"
                />
                <span>Active</span>
              </label>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function PerspectiveEditorBody({
  slug,
  onDeleted,
  onError,
  saving,
  setSaving,
}: {
  slug: string;
  onDeleted: () => void;
  onError: (msg: string | null) => void;
  saving: boolean;
  setSaving: (v: boolean) => void;
}) {
  const detail = useQuery(['perspectives.detail', slug] as const, () => PerspectivesAPI.get(slug));

  const [displayName, setDisplayName] = useState(detail.display_name);
  const [description, setDescription] = useState(detail.description);
  const [promptMarkdown, setPromptMarkdown] = useState(detail.prompt_markdown);

  useEffect(() => {
    setDisplayName(detail.display_name);
    setDescription(detail.description);
    setPromptMarkdown(detail.prompt_markdown);
  }, [detail]);

  async function handleSave() {
    setSaving(true);
    onError(null);
    try {
      await PerspectivesAPI.update(slug, {
        display_name: displayName,
        description,
        prompt_markdown: promptMarkdown,
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleResetDefault() {
    if (!window.confirm('Replace editor content from the default markdown file on disk?')) return;
    setSaving(true);
    onError(null);
    try {
      const updated = await PerspectivesAPI.resetDefault(slug);
      setPromptMarkdown(updated.prompt_markdown);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Reset failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete perspective "${slug}"? This cannot be undone.`)) return;
    setSaving(true);
    onError(null);
    try {
      await PerspectivesAPI.remove(slug);
      onDeleted();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-text mb-1">Display name</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full px-3 py-2 rounded-base border border-border bg-bg text-text focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-text mb-1">Description</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full px-3 py-2 rounded-base border border-border bg-bg text-text focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </div>
      </div>
      <div>
        <span className="block text-sm font-medium text-text mb-1">Prompt (markdown)</span>
        <CodeMirror
          value={promptMarkdown}
          height="min(50vh, 420px)"
          className="w-full border border-border rounded-base overflow-hidden text-sm"
          extensions={[markdown()]}
          onChange={(v) => setPromptMarkdown(v)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="primary" onClick={() => void handleSave()} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => void handleResetDefault()} disabled={saving}>
          Reset to default
        </Button>
        <Button type="button" variant="danger" onClick={() => void handleDelete()} disabled={saving}>
          Delete
        </Button>
      </div>
    </>
  );
}

function PerspectivesTabInner() {
  const [listRev, setListRev] = useState(0);
  const [, startTransition] = useTransition();
  const rows = useQuery(['perspectives.list', listRev] as const, () => PerspectivesAPI.list());

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [newSlug, setNewSlug] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newBody, setNewBody] = useState(NEW_TEMPLATE);

  const refreshList = useCallback(() => {
    invalidateAll(['perspectives.list']);
    startTransition(() => setListRev((n) => n + 1));
  }, [startTransition]);

  async function handleToggleActive(row: PerspectiveSummary, next: boolean) {
    setError(null);
    try {
      await PerspectivesAPI.update(row.slug, { active: next });
      startTransition(() => setListRev((n) => n + 1));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update active flag');
    }
  }

  async function handleCreatePerspective() {
    const slugRe = /^[a-z][a-z0-9_]{0,63}$/;
    if (!slugRe.test(newSlug.trim())) {
      setError('Slug must match [a-z][a-z0-9_]{0,63}');
      return;
    }
    const slug = newSlug.trim();
    const dn = newDisplayName.trim() || slugifyDisplay(slug);
    setSaving(true);
    setError(null);
    try {
      await PerspectivesAPI.create({
        slug,
        display_name: dn,
        prompt_markdown: newBody,
        active: true,
      });
      setAddOpen(false);
      setNewSlug('');
      setNewDisplayName('');
      setNewBody(NEW_TEMPLATE);
      setListRev((n) => n + 1);
      setSelectedSlug(slug);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <FoldingCard
        title="Perspective rubrics"
        summary={PERSPECTIVES_SUMMARY(rows.length, rows.filter((r) => r.active).length)}
        storageKey="lt.perspectives.rubrics.open"
      >
        <p className="text-sm text-text-secondary mb-4">{NAV_PERSPECTIVES_HELP}</p>
        {error && (
          <div className="mb-4 text-sm text-error" role="alert">
            {error}
          </div>
        )}
        <div className="flex flex-col lg:flex-row gap-6">
          <PerspectivesListPanel
            rows={rows}
            selectedSlug={selectedSlug}
            onSelect={setSelectedSlug}
            onToggleActive={handleToggleActive}
            onRefresh={refreshList}
            onAdd={() => setAddOpen(true)}
          />

          <div className="flex-1 min-w-0 space-y-4">
            {!selectedSlug ? (
              <p className="text-sm text-text-secondary">Select a perspective to edit.</p>
            ) : (
              <ErrorBoundary
                resetKeys={[selectedSlug]}
                fallback={({ error: err, reset }) => (
                  <ErrorState
                    error={err}
                    reset={() => {
                      invalidateAll(['perspectives.detail']);
                      reset();
                    }}
                  />
                )}
              >
                <Suspense fallback={<p className="text-sm text-text-secondary">Loading editor…</p>}>
                  <PerspectiveEditorBody
                    slug={selectedSlug}
                    onDeleted={() => {
                      setSelectedSlug(null);
                      setListRev((n) => n + 1);
                    }}
                    onError={setError}
                    saving={saving}
                    setSaving={setSaving}
                  />
                </Suspense>
              </ErrorBoundary>
            )}
          </div>
        </div>
      </FoldingCard>

      <CullingRecipesSection />

      {addOpen && (
        <Modal onClose={() => setAddOpen(false)} maxWidth="lg">
          <div className="p-6 flex flex-col gap-4 bg-bg max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-text">Add perspective</h2>
            <div>
              <label className="block text-sm font-medium text-text mb-1">Slug</label>
              <input
                type="text"
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value)}
                placeholder="e.g. color_theory"
                className="w-full px-3 py-2 rounded-base border border-border bg-bg text-text focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text mb-1">Display name (optional)</label>
              <input
                type="text"
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                className="w-full px-3 py-2 rounded-base border border-border bg-bg text-text focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <span className="block text-sm font-medium text-text mb-1">Template body</span>
              <CodeMirror
                value={newBody}
                height="220px"
                className="w-full border border-border rounded-base overflow-hidden text-sm"
                extensions={[markdown()]}
                onChange={(v) => setNewBody(v)}
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="ghost" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={() => void handleCreatePerspective()}
                disabled={saving}
              >
                Create
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function PerspectivesTab() {
  return (
    <ErrorBoundary
      fallback={({ error, reset }) => (
        <ErrorState
          error={error}
          reset={() => {
            invalidateAll(['perspectives']);
            reset();
          }}
        />
      )}
    >
      <Suspense fallback={<p className="text-sm text-text-secondary p-6">Loading perspectives…</p>}>
        <PerspectivesTabInner />
      </Suspense>
    </ErrorBoundary>
  );
}
