import { useId } from 'react';
import { LANGUAGES, isLang, useI18n } from '../i18n';
import { useLargeText } from '../lib/textSize';

/** Language menu. Each option is written in its own language, so people can find theirs. */
export function LanguagePicker({ tone = 'dark' }: { tone?: 'dark' | 'light' }) {
  const { lang, setLang, t } = useI18n();
  const id = useId();
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={id} className="shrink-0">
        <span className="sr-only">{t.common.language}</span>
        <GlobeIcon />
      </label>
      <select
        id={id}
        value={lang}
        onChange={(e) => isLang(e.target.value) && setLang(e.target.value)}
        className={`min-h-[44px] rounded-md border-2 py-1 pl-2 pr-8 text-base font-semibold ${
          tone === 'dark' ? 'border-white/60 bg-navy-900 text-white' : 'border-muted-light bg-white text-ink'
        }`}
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code} lang={l.code}>
            {l.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** On/off switch for larger text across the app. */
export function TextSizeToggle({ tone = 'dark' }: { tone?: 'dark' | 'light' }) {
  const { t } = useI18n();
  const [large, setLarge] = useLargeText();
  const off = tone === 'dark' ? 'border-white/60 text-white hover:bg-white/10' : 'border-muted-light bg-white text-ink hover:bg-muted-lightest';
  const on = tone === 'dark' ? 'border-white bg-white text-navy-900' : 'border-primary bg-primary text-white';
  return (
    <button
      type="button"
      aria-pressed={large}
      onClick={() => setLarge(!large)}
      title={t.common.largerText}
      className={`flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border-2 px-2 font-bold ${large ? on : off}`}
    >
      <span aria-hidden="true" className="leading-none">
        A<span className="text-lg">A</span>
      </span>
      <span className="sr-only">{t.common.largerText}</span>
    </button>
  );
}

function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}
