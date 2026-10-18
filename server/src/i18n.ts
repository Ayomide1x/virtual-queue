// Languages residents can choose. Each one needs an entry here (alert texts)
// and a message file in web/src/i18n (the pages). TypeScript checks both are complete.

export const LANGS = ['en', 'es'] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = 'en';

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && (LANGS as readonly string[]).includes(v);
}

/** Stored values may predate languages (or be junk): fall back to the default. */
export function langOr(v: unknown): Lang {
  return isLang(v) ? v : DEFAULT_LANG;
}

const LOCALES: Record<Lang, string> = { en: 'en-US', es: 'es-US' };

/** "9:45 AM" / "9:45 a. m." for a timestamp in the office's time zone. */
export function formatTimeIn(lang: Lang, ts: number, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALES[lang], { timeZone, hour: 'numeric', minute: '2-digit' }).format(ts);
}

/** "Tuesday, March 4" / "martes, 4 de marzo" for a timestamp in the office's time zone. */
export function formatDateIn(lang: Lang, ts: number, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALES[lang], { timeZone, weekday: 'long', month: 'long', day: 'numeric' }).format(ts);
}

export interface AlertTexts {
  nearTitle: (number: string) => string;
  nearBody: (ahead: number, office: string) => string;
  calledTitle: (number: string) => string;
  calledBody: (counter: string) => string;
  confirmTitle: string;
  confirmBody: (threshold: number, number: string) => string;
  reminderTitle: (time: string) => string;
  reminderBody: (service: string, office: string, opensAt: string) => string;
  reminderSetTitle: string;
  reminderSetBody: (time: string, date: string) => string;
  emailButton: string;
  emailFooter: string;
}

export const ALERT_TEXTS: Record<Lang, AlertTexts> = {
  en: {
    nearTitle: (n) => `Almost your turn: ${n}`,
    nearBody: (ahead, office) =>
      ahead === 0
        ? `You’re next at ${office}. Please be ready to go to the counter.`
        : `${ahead} ${ahead === 1 ? 'person is' : 'people are'} ahead of you at ${office}. Please make your way back so you’re ready.`,
    calledTitle: (n) => `It’s your turn: ${n}`,
    calledBody: (counter) => `Please go to ${counter} now.`,
    confirmTitle: 'Alerts are on',
    confirmBody: (k, n) => `We’ll let you know when you’re ${k} people away and when it’s your turn (ticket ${n}).`,
    reminderTitle: (time) => `Appointment at ${time}`,
    reminderBody: (service, office, opensAt) =>
      `${service} at ${office} in about an hour. Check in from your confirmation link when you arrive (from ${opensAt}).`,
    reminderSetTitle: 'Reminder set',
    reminderSetBody: (time, date) => `We’ll remind you before your ${time} appointment on ${date}, and alert you once you’ve checked in.`,
    emailButton: 'Open',
    emailFooter: 'You asked for alerts about your place in line. Your address is deleted when your visit ends.',
  },
  es: {
    nearTitle: (n) => `Ya casi es su turno: ${n}`,
    nearBody: (ahead, office) =>
      ahead === 0
        ? `Usted es el siguiente en ${office}. Prepárese para pasar a la ventanilla.`
        : `${ahead === 1 ? 'Hay 1 persona' : `Hay ${ahead} personas`} antes que usted en ${office}. Regrese para estar listo.`,
    calledTitle: (n) => `Es su turno: ${n}`,
    calledBody: (counter) => `Pase a ${counter} ahora.`,
    confirmTitle: 'Alertas activadas',
    confirmBody: (k, n) => `Le avisaremos cuando falten ${k} personas y cuando sea su turno (número ${n}).`,
    reminderTitle: (time) => `Cita a las ${time}`,
    reminderBody: (service, office, opensAt) =>
      `${service} en ${office} en aproximadamente una hora. Regístrese con su enlace de confirmación al llegar (a partir de las ${opensAt}).`,
    reminderSetTitle: 'Recordatorio programado',
    reminderSetBody: (time, date) => `Le recordaremos antes de su cita de las ${time} el ${date}, y le avisaremos cuando se haya registrado.`,
    emailButton: 'Abrir',
    emailFooter: 'Usted pidió alertas sobre su lugar en la fila. Su dirección se borra al terminar su visita.',
  },
};
