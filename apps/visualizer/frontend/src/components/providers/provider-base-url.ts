const TRAILING_API_PATH = /\/(?:chat\/completions|messages)(?:\/|$)/i;

function normalizeBaseUrlInput(raw: string): string {
  let s = raw.trim();
  if (!s) return s;
  s = s.replace(/\/+$/, '');
  s = s.replace(TRAILING_API_PATH, '');
  s = s.replace(/\/+$/, '');
  return s;
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function normalizedPort(u: URL): number {
  if (u.port) return Number(u.port);
  return u.protocol === 'https:' ? 443 : 80;
}

function stripOptionalV1Path(pathname: string): string {
  let p = pathname.replace(/\/+$/, '') || '/';
  if (p.endsWith('/v1')) {
    p = p.slice(0, -3) || '/';
  }
  return p;
}

/** Whether two stored bases count as the same address (mirrors backend rules). */
export function providerAddressesEquivalent(a: string, b: string): boolean {
  const na = normalizeBaseUrlInput(a);
  const nb = normalizeBaseUrlInput(b);
  if (na === nb) return true;
  const ua = parseUrl(na);
  const ub = parseUrl(nb);
  if (!ua || !ub) return na === nb;
  if (ua.protocol !== ub.protocol) return false;
  if (ua.hostname.toLowerCase() !== ub.hostname.toLowerCase()) return false;
  if (normalizedPort(ua) !== normalizedPort(ub)) return false;
  return stripOptionalV1Path(ua.pathname) === stripOptionalV1Path(ub.pathname);
}
