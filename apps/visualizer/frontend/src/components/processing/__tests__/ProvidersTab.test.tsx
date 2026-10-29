import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import {
  PROVIDERS_GROUP_OPENAI,
  PROVIDERS_GROUP_SYSTEM_ONE,
} from '../../../constants/strings';
import { ProvidersTab } from '../ProvidersTab';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  getFallbackOrder: vi.fn(),
  getDefaults: vi.fn(),
  cullingGet: vi.fn(),
  addressChangeImpact: vi.fn(),
}));

vi.mock('../../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/api')>();
  return {
    ...actual,
    ProvidersAPI: {
      ...actual.ProvidersAPI,
      list: mocks.list,
      getFallbackOrder: mocks.getFallbackOrder,
      getDefaults: mocks.getDefaults,
      addressChangeImpact: mocks.addressChangeImpact,
      create: vi.fn(),
      update: vi.fn(),
      probe: vi.fn(),
      listModels: vi.fn().mockResolvedValue([]),
      updateFallbackOrder: vi.fn(),
      updateDefaults: vi.fn(),
    },
    CullingModelsAPI: {
      ...actual.CullingModelsAPI,
      get: mocks.cullingGet,
    },
  };
});

describe('ProvidersTab', () => {
  beforeEach(() => {
    mocks.list.mockResolvedValue([
      {
        id: 'ollama',
        name: 'Ollama',
        protocol: 'openai',
        available: true,
        tool_calling: false,
        enabled: true,
        base_url: { from: 'literal', value: 'http://localhost:11434' },
        auth: { mode: 'none', has_key: false },
        address_probe: null,
      },
      {
        id: 'studio',
        name: 'Studio',
        protocol: 'system_one',
        available: true,
        tool_calling: false,
        enabled: true,
        base_url: { from: 'literal', value: 'http://studio:8000' },
        auth: { mode: 'bearer', has_key: true, secret_from: 'literal' },
        address_probe: { answered: true, probed_at: '2020-01-01T00:00:00.000Z' },
      },
    ]);
    mocks.getFallbackOrder.mockResolvedValue({ order: ['ollama'] });
    mocks.getDefaults.mockResolvedValue({ description: { provider: 'ollama', model: null } });
    mocks.cullingGet.mockResolvedValue({
      culling_profile: { endpoint: 'studio', model: 'm1', answered: { photos: 0, model: null } },
      score_forecast: { endpoint: 'this_app', model: null, answered: { photos: 0, model: null } },
      total_photos: 0,
      system_one_providers: [],
    });
    mocks.addressChangeImpact.mockResolvedValue({
      photos: 12,
      stages: [{ kind: 'culling_profile', name: 'Culling profile' }],
    });
  });

  it('shows OpenAI-compatible and System One providers in separate groups', async () => {
    render(
      <MemoryRouter>
        <ProvidersTab />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(PROVIDERS_GROUP_OPENAI)).toBeInTheDocument());
    expect(screen.getByText(PROVIDERS_GROUP_SYSTEM_ONE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ollama Available/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Studio Available/ })).toBeInTheDocument();
    expect(screen.getByText(/Used by Culling profile/)).toBeInTheDocument();
  });
});
