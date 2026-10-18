import { describe, expect, it } from 'vitest';
import { defaultConfig, normalizeSettings, openStatus, zonedParts, type OfficeConfig } from '../src/officeConfig';

const base = defaultConfig('Test', 'America/New_York');
const scheduled: OfficeConfig = {
  ...base,
  hoursEnabled: true,
  hours: {
    mon: { open: '09:00', close: '17:00' },
    tue: { open: '09:00', close: '17:00' },
    wed: { open: '09:00', close: '17:00' },
    thu: { open: '09:00', close: '17:00' },
    fri: { open: '09:00', close: '17:00' },
    sat: null,
    sun: null,
  },
};
// 2026-03-04 is a Wednesday. New York is UTC-5 in early March.
const nyc = (iso: string) => new Date(`${iso}-05:00`).getTime();

describe('time zones', () => {
  it('computes the local date, weekday and time in the office time zone', () => {
    // 03:30 UTC Thursday is still Wednesday evening in New York.
    const ts = new Date('2026-03-05T03:30:00Z').getTime();
    expect(zonedParts(ts, 'America/New_York')).toEqual({ dateKey: '2026-03-04', weekday: 'wed', minutes: 22 * 60 + 30 });
    expect(zonedParts(ts, 'Asia/Tokyo')).toMatchObject({ dateKey: '2026-03-05', weekday: 'thu' });
  });
});

describe('opening hours', () => {
  it('is always open when hours are disabled', () => {
    expect(openStatus({ ...scheduled, hoursEnabled: false }, nyc('2026-03-07T03:00:00')).open).toBe(true);
  });

  it('is open during the day’s hours, and says until when', () => {
    expect(openStatus(scheduled, nyc('2026-03-04T09:00:00'))).toEqual({ open: true, message: 'Open until 5:00 PM' });
    expect(openStatus(scheduled, nyc('2026-03-04T16:59:00')).open).toBe(true);
  });

  it('closes at closing time and names the next opening', () => {
    expect(openStatus(scheduled, nyc('2026-03-04T17:00:00'))).toEqual({
      open: false,
      message: 'Joining is closed right now. We open again tomorrow at 9:00 AM.',
    });
    expect(openStatus(scheduled, nyc('2026-03-04T07:30:00')).message).toBe('Joining is closed right now. We open today at 9:00 AM.');
  });

  it('skips closed days (Friday evening → Monday)', () => {
    expect(openStatus(scheduled, nyc('2026-03-06T18:00:00')).message).toBe('Joining is closed right now. We open again Monday at 9:00 AM.');
    expect(openStatus(scheduled, nyc('2026-03-07T12:00:00')).open).toBe(false); // Saturday
  });

  it('uses the office time zone, not the server’s', () => {
    const tokyo = { ...scheduled, timezone: 'Asia/Tokyo' };
    // 10:00 Wednesday in Tokyo = 01:00 UTC.
    expect(openStatus(tokyo, new Date('2026-03-04T01:00:00Z').getTime()).open).toBe(true);
    expect(openStatus(scheduled, new Date('2026-03-04T01:00:00Z').getTime()).open).toBe(false);
  });

  it('reports closed with no hours set at all', () => {
    const none = { ...scheduled, hours: { ...scheduled.hours, mon: null, tue: null, wed: null, thu: null, fri: null } };
    expect(openStatus(none, nyc('2026-03-04T12:00:00'))).toEqual({ open: false, message: 'Joining is closed right now.' });
  });
});

describe('settings validation', () => {
  const settings = () => structuredClone(base) as unknown as Record<string, any>;

  it('assigns ids to new services and counters, keeping existing ones', () => {
    const s = settings();
    s.services.push({ name: 'Passports', code: 'p', defaultServiceSec: 600 });
    s.counters.push({ name: 'Window A' });
    const out = normalizeSettings(s);
    expect(out.services[0].id).toBe('license');
    expect(out.services[3]).toMatchObject({ name: 'Passports', code: 'P' });
    expect(out.services[3].id).toMatch(/^s[0-9a-f]{8}$/);
    expect(out.counters.at(-1)).toEqual({ id: 5, name: 'Window A' });
  });

  it('rejects two services sharing a ticket letter', () => {
    const s = settings();
    s.services[1].code = 'D';
    expect(() => normalizeSettings(s)).toThrow(/both use the letter D/);
  });

  it('rejects bad letters, unknown time zones and inverted hours', () => {
    const a = settings();
    a.services[0].code = 'DL';
    expect(() => normalizeSettings(a)).toThrow(/single letter/);
    const b = settings();
    b.timezone = 'Mars/Olympus';
    expect(() => normalizeSettings(b)).toThrow(/time zone/);
    const c = settings();
    c.hours.mon = { open: '17:00', close: '09:00' };
    expect(() => normalizeSettings(c)).toThrow(/after opening/);
  });

  it('requires at least one service and one counter', () => {
    expect(() => normalizeSettings({ ...settings(), services: [] })).toThrow(/at least one service/);
    expect(() => normalizeSettings({ ...settings(), counters: [] })).toThrow(/at least one counter/);
  });
});
