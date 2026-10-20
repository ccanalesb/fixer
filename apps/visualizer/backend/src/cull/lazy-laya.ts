/**
 * Laya loaded on the first `answer()` — so a run whose photos are all re-decide-only
 * or `no_image` never pays the start check or ~2–3.5 GB until something needs answers.
 */
import type { LayaPhotoResult } from '../laya/runtime.js';
import { startLayaWithCheck } from '../laya/runtime.js';
import type { LayaAnswerWant, LayaQuestionsByModel } from '../laya/sessions.js';
import type { LayaAnswerer } from './answer-photo.js';

export class LazyLaya implements LayaAnswerer {
  private runtime: Awaited<ReturnType<typeof startLayaWithCheck>>['runtime'] | null = null;
  private _started = false;

  /** True after the start check succeeded. */
  get started(): boolean {
    return this._started;
  }

  /** Seconds to load models on first start; 0 when never started. */
  loadSeconds = 0;

  constructor(
    private readonly modelsDir: string,
    private readonly questions?: LayaQuestionsByModel,
  ) {}

  get scoreForecastOn(): boolean {
    return this.runtime?.scoreForecastOn ?? true;
  }

  get broken(): boolean {
    return this.runtime?.broken ?? false;
  }

  async answer(file: string, want?: LayaAnswerWant): Promise<LayaPhotoResult> {
    if (!this.runtime) {
      const check = await startLayaWithCheck(this.modelsDir, this.questions);
      this.runtime = check.runtime;
      this.loadSeconds = check.loadSeconds;
      this._started = true;
    }
    return this.runtime.answer(file, want);
  }

  /** No-op when Laya was never started. */
  async close(): Promise<void> {
    if (this.runtime) await this.runtime.close();
  }
}
