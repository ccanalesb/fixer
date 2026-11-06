import type { components } from './api.gen'

/** Generated from backend OpenAPI — see ADR-0013. */
export type ConfigCatalogChangePreviewResponse =
  components['schemas']['ConfigCatalogChangePreviewResponse']
export type ConfigCatalogGetResponse =
  components['schemas']['ConfigCatalogGetResponse']
export type ConfigCatalogPickResponse =
  components['schemas']['ConfigCatalogPickResponse']
export type ConfigCatalogPickFolderResponse =
  components['schemas']['ConfigCatalogPickFolderResponse']
export type ConfigCatalogPutResponse =
  components['schemas']['ConfigCatalogPutResponse']
export type ConfigStackDetectionGetResponse =
  components['schemas']['ConfigStackDetectionGetResponse']
export type ConfigStackDetectionPutResponse =
  components['schemas']['ConfigStackDetectionPutResponse']
export type ConfigCatalogPutRequest =
  components['schemas']['ConfigCatalogPutRequest']

export type CatalogKind = ConfigCatalogGetResponse['catalog_kind']
export type CatalogChangeMode = ConfigCatalogPutRequest['change']
