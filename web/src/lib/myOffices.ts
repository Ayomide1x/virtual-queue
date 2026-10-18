// Offices this device has created or staffed, for quick access from the home page.
const KEY = 'vq.myOffices';

export interface SavedOffice {
  id: string;
  name: string;
  savedAt: number;
}

export function listMyOffices(): SavedOffice[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function rememberOffice(id: string, name: string): void {
  try {
    const list = listMyOffices().filter((o) => o.id !== id);
    list.unshift({ id, name, savedAt: Date.now() });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 10)));
  } catch {
    /* ignore */
  }
}

export function forgetOffice(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(listMyOffices().filter((o) => o.id !== id)));
  } catch {
    /* ignore */
  }
}
