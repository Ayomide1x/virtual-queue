export interface ServiceDef {
  id: ServiceId;
  /** Single-letter prefix used in ticket numbers, e.g. "D" in D-042. */
  code: string;
  name: string;
  /** Used for wait estimates until real service times have been recorded. */
  defaultServiceSec: number;
}

export const SERVICE_IDS = ['license', 'registration', 'id'] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

export const SERVICES: readonly ServiceDef[] = [
  { id: 'license', code: 'D', name: "Driver's License", defaultServiceSec: 360 },
  { id: 'registration', code: 'V', name: 'Vehicle Registration', defaultServiceSec: 240 },
  { id: 'id', code: 'I', name: 'ID Card', defaultServiceSec: 180 },
];

export function isServiceId(value: unknown): value is ServiceId {
  return typeof value === 'string' && (SERVICE_IDS as readonly string[]).includes(value);
}

export function getService(id: ServiceId): ServiceDef {
  const svc = SERVICES.find((s) => s.id === id);
  if (!svc) throw new Error(`Unknown service: ${id}`);
  return svc;
}
