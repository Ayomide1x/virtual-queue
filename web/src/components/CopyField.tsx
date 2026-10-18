import { useState } from 'react';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context (https or localhost); fall back for LAN http.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function CopyField({ label, value, hint, secret = false }: { label: string; value: string; hint?: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const id = `copy-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div>
      <label htmlFor={id} className="mb-1 flex items-center gap-2 font-bold">
        {label}
        {secret && <span className="rounded bg-warning-light px-1.5 py-0.5 text-xs font-bold uppercase tracking-wide text-ink">Private</span>}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="min-h-[48px] min-w-0 flex-1 rounded-md border-2 border-muted-lighter bg-muted-lightest px-3 font-mono text-sm"
        />
        <button
          type="button"
          className={copied ? 'btn-success min-w-[96px]' : 'btn-outline min-w-[96px]'}
          onClick={async () => {
            if (await copyText(value)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }
          }}
          aria-label={`Copy ${label}`}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <a href={value} target="_blank" rel="noreferrer" className="btn-secondary hidden px-3 sm:inline-flex" aria-label={`Open ${label} in a new tab`}>
          Open ↗
        </a>
      </div>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      <span className="sr-only" aria-live="polite">
        {copied ? `${label} copied` : ''}
      </span>
    </div>
  );
}
