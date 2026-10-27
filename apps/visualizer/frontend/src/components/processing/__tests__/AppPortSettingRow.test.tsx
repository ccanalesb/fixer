import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppPortSettingRow } from '../AppPortSettingRow';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

type WindowWithTauri = Window & { __TAURI_INTERNALS__?: object };

function withTauriHost(run: () => void | Promise<void>) {
  const w = window as WindowWithTauri;
  w.__TAURI_INTERNALS__ = {};
  return Promise.resolve(run()).finally(() => {
    delete w.__TAURI_INTERNALS__;
  });
}

describe('AppPortSettingRow', () => {
  afterEach(() => {
    invokeMock.mockReset();
  });

  it('is absent in a normal browser', () => {
    const w = window as WindowWithTauri;
    delete w.__TAURI_INTERNALS__;
    const { container } = render(<AppPortSettingRow />);
    expect(container).toBeEmptyDOMElement();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('shows the port field in the desktop host', async () => {
    await withTauriHost(async () => {
      invokeMock.mockResolvedValueOnce(5107);
      render(<AppPortSettingRow />);
      expect(await screen.findByLabelText('Local port')).toHaveValue(5107);
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
  });

  it('calls the host to save a new port', async () => {
    await withTauriHost(async () => {
      invokeMock.mockResolvedValueOnce(5101);
      invokeMock.mockResolvedValueOnce(undefined);

      render(<AppPortSettingRow />);
      const input = await screen.findByLabelText('Local port');
      await waitFor(() => expect(input).toHaveValue(5101));

      fireEvent.change(input, { target: { value: '5109' } });
      screen.getByRole('button', { name: 'Save' }).click();

      await waitFor(() =>
        expect(invokeMock).toHaveBeenCalledWith('set_app_port', { port: 5109 }),
      );
      expect(
        screen.getByText('Saved. Restart Fixer for this port to take effect.'),
      ).toBeInTheDocument();
    });
  });
});
