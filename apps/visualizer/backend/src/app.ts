/**
 * Application factory.
 *
 * Side-effect free: constructing the app must not start the job processor or
 * write to stdout. Diagnostics go to stderr so OpenAPI export output stays JSON.
 */
import { cors } from 'hono/cors';
import { config } from './config.js';
import { HttpError } from './utils/responses.js';
import { createOpenApiApp, openApiDoc } from './api/openapi.js';
import { appModelsRoutes } from './api/app-models.js';
import { descriptionsRoutes } from './api/descriptions.js';
import { identityRoutes } from './api/identity.js';
import { jobsRoutes } from './api/jobs.js';
import { cullingModelsRoutes } from './api/culling-models.js';
import { catalogRoutes } from './api/images/catalog.js';
import { stacksRoutes } from './api/images/stacks.js';
import { ltConfigRoutes } from './api/lt-config.js';
import { perspectivesRoutes } from './api/perspectives.js';
import { cullReviewRoutes } from './api/cull-review.js';
import { cullingProfilesRoutes } from './api/culling-profiles.js';
import { scoreForecastQuestionsRoutes } from './api/score-forecast-questions.js';
import { lrWritebackRoutes } from './api/lr-writeback.js';
import { providersRoutes } from './api/providers.js';
import { scoresRoutes } from './api/scores.js';
import { systemRoutes } from './api/system.js';
import { systemOneRoutes } from './api/systemone.js';

export function createApp() {
  const app = createOpenApiApp();

  app.use(
    '/api/*',
    cors({
      origin: config.FRONTEND_ORIGINS,
      credentials: true,
    }),
  );

  // One route group per domain area; url_prefix values match the frontend contract.
  //
  // Order matters within the images tree: `/images/catalog/months` and
  // `/images/catalog-similarity-groups` must be registered before the
  // `/images/catalog/{image_key}` catch-all, or they are matched as image keys.
  // `catalogRoutes` declares them in that order internally.
  app.route('/api', jobsRoutes);
  app.route('/api', catalogRoutes);
  app.route('/api', stacksRoutes);
  app.route('/api', systemRoutes);
  app.route('/api', descriptionsRoutes);
  app.route('/api', ltConfigRoutes);
  app.route('/api', perspectivesRoutes);
  app.route('/api', cullReviewRoutes);
  app.route('/api', cullingProfilesRoutes);
  app.route('/api', lrWritebackRoutes);
  app.route('/api', appModelsRoutes);
  app.route('/api', cullingModelsRoutes);
  app.route('/api', scoreForecastQuestionsRoutes);
  app.route('/api', providersRoutes);
  app.route('/api', identityRoutes);
  app.route('/api/scores', scoresRoutes);
  app.route('/', systemOneRoutes);

  /**
   * `/api/images/<bad_type>/<key>` for a family that is not mounted.
   *
   * Registered after the images groups so real paths resolve first. Also catches a
   * non-numeric stack id (`/api/images/stacks/abc/members`) with 400 rather than 404.
   *
   * The error message uses a tuple repr; the frontend depends on this exact string.
   */
  app.all('/api/images/:bad_type/*', (c) => {
    if (c.req.method !== 'GET') return c.notFound();
    return c.json(
      { error: "invalid image_type; expected one of ('catalog', 'instagram')" },
      400,
    );
  });

  /**
   * Uncaught errors become a 500 carrying the message.
   *
   * Centralized here instead of declaring 500 on every route — only some routes list
   * 500 in the OpenAPI contract.
   */
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });

  // Backend-authoritative OpenAPI (ADR-0013). `scripts/export-openapi.ts` reads this.
  app.doc('/apidoc/openapi.json', openApiDoc());

  return app;
}
