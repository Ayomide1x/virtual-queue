// The staff key for each office lives in localStorage on staff devices.
const storageKey = (officeId: string) => `vq.staffKey.${officeId}`;

export function getStaffKey(officeId: string): string | null {
  try {
    return localStorage.getItem(storageKey(officeId));
  } catch {
    return null;
  }
}

export function setStaffKey(officeId: string, key: string): void {
  try {
    localStorage.setItem(storageKey(officeId), key);
  } catch {
    /* private mode: key lasts for this page only */
  }
}

export function clearStaffKey(officeId: string): void {
  try {
    localStorage.removeItem(storageKey(officeId));
  } catch {
    /* ignore */
  }
}

/**
 * Staff links carry the key in the URL fragment (#key=…), which browsers never
 * send to the server. Save it, then remove it from the address bar.
 */
export function captureKeyFromUrl(officeId: string): string | null {
  const match = window.location.hash.match(/(?:^#|&)key=([^&]+)/);
  if (!match) return null;
  const key = decodeURIComponent(match[1]);
  setStaffKey(officeId, key);
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return key;
}
