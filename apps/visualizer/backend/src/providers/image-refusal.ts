/** Max length stored for a provider's image-refusal message. */
export const IMAGE_REFUSAL_REASON_MAX = 500;

/**
 * Whether an HTTP failure means this model does not accept images.
 *
 * Used by the vision client and by tests that pin the classification table.
 */
export function isImageRefusalResponse(
  status: number,
  body: string,
  requestPath: string,
): boolean {
  const normalizedPath = requestPath.replace(/\?.*$/, '');
  if (status === 404 && normalizedPath.endsWith('/chat/completions')) return true;
  if (status < 400 || status >= 500) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes('multimodal') ||
    lower.includes('image_url') ||
    lower.includes('modality') ||
    lower.includes('image input') ||
    lower.includes('image data')
  );
}

export function trimImageRefusalReason(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= IMAGE_REFUSAL_REASON_MAX) return trimmed;
  return `${trimmed.slice(0, IMAGE_REFUSAL_REASON_MAX - 1)}…`;
}
