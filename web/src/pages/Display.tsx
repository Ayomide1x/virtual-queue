import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useRef, useState } from 'react';
import { ConnectionBanner, LiveDot } from '../components/ConnectionStatus';
import { Seal } from '../components/Header';
import { OfficeGate } from '../components/OfficeGate';
import { ServiceBadge } from '../components/ServiceBadge';
import { useNow } from '../lib/clock';
import { formatClock, formatRangeShort, speakableTicket } from '../lib/format';
import { useChannel } from '../lib/socket';
import { audioUnlocked, playChime, speak, unlockAudio } from '../lib/sound';
import { officeLinks, publicBase } from '../lib/urls';
import { useOfficeId } from '../lib/useOffice';
import { useTitle } from '../lib/useTitle';
import type { LobbyState, OfficeResponse } from '../types';

export default function Display() {
  const officeId = useOfficeId();
  return (
    <OfficeGate officeId={officeId} dark>
      {(data) => <DisplayScreen key={officeId} officeId={officeId} initial={data} />}
    </OfficeGate>
  );
}

function DisplayScreen({ officeId, initial }: { officeId: string; initial: OfficeResponse }) {
  const { data: lobby } = useChannel<LobbyState>({ officeId, role: 'lobby' }, 'lobby:state');
  const office = lobby?.office ?? initial.office;
  useTitle(`Now Serving — ${office.name}`);
  const now = useNow(1000);
  const { base, reachable } = publicBase(initial);
  const joinUrl = officeLinks(base, officeId).join;
  const [soundOn, setSoundOn] = useState(audioUnlocked());
  const [announced, setAnnounced] = useState<string | null>(null);
  const codeOf = (serviceId: string) => office.services.find((s) => s.id === serviceId)?.code ?? '•';

  // Announce each new call (and recall) with a chime and voice.
  const lastSeen = useRef<number | null>(null);
  useEffect(() => {
    if (!lobby) return;
    const latest = lobby.recent[0];
    const latestAt = latest?.at ?? 0;
    if (lastSeen.current === null) {
      lastSeen.current = latestAt; // don't announce what was already on screen at load
      return;
    }
    if (latest && latestAt > lastSeen.current) {
      lastSeen.current = latestAt;
      setAnnounced(`${latest.number}:${latest.at}`);
      if (audioUnlocked()) {
        playChime(0.5);
        setTimeout(() => speak(`Ticket ${speakableTicket(latest.number)}, please go to ${latest.counterName}.`), 1100);
      }
    }
  }, [lobby]);

  return (
    <div className="flex h-screen min-h-[600px] flex-col overflow-hidden bg-navy-950 text-white">
      <ConnectionBanner dark />
      <header className="flex items-center justify-between gap-6 border-b border-white/10 px-[3vw] py-[1.6vh]">
        <div className="flex min-w-0 items-center gap-4">
          <Seal className="h-[5vh] min-h-[40px] w-auto shrink-0" />
          <div className="min-w-0">
            <div className="text-[clamp(12px,1.1vw,20px)] font-semibold uppercase tracking-widest text-primary-light">Now Serving</div>
            <div className="truncate text-[clamp(18px,1.8vw,34px)] font-bold leading-tight">{office.name}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-6">
          {!soundOn && (
            <button
              type="button"
              onClick={async () => setSoundOn(await unlockAudio())}
              className="rounded-full border border-white/30 px-4 py-2 text-sm font-semibold text-white/90 hover:bg-white/10"
            >
              Enable sound announcements
            </button>
          )}
          <LiveDot light />
          <time className="tabular text-[clamp(24px,2.6vw,52px)] font-bold">{formatClock(now)}</time>
        </div>
      </header>

      {!office.status.open && (
        <div role="status" className="bg-warning px-[3vw] py-[1.2vh] text-center text-[clamp(16px,1.6vw,32px)] font-bold text-ink">
          {office.status.message ?? 'Joining is closed right now.'}
        </div>
      )}

      <main className="grid flex-1 grid-cols-1 gap-[2vw] overflow-hidden p-[2vw] lg:grid-cols-3">
        {/* Now serving */}
        <section className="flex flex-col overflow-hidden rounded-2xl bg-navy-900 lg:col-span-2" aria-labelledby="now-serving">
          <div className="flex items-baseline justify-between border-b border-white/10 px-[2vw] py-[1.5vh]">
            <h1 id="now-serving" className="text-[clamp(24px,2.6vw,52px)] font-extrabold">
              Now Serving
            </h1>
            <div className="hidden text-[clamp(14px,1.3vw,26px)] font-semibold uppercase tracking-wider text-primary-light sm:block">Ticket → Go to</div>
          </div>
          <ul className="flex-1 overflow-hidden" aria-live="polite">
            {!lobby && <li className="p-[3vw] text-[clamp(18px,2vw,40px)] text-white/70">Connecting…</li>}
            {lobby?.nowServing.length === 0 && (
              <li className="flex h-full flex-col items-center justify-center p-[3vw] text-center">
                <p className="text-[clamp(22px,2.6vw,52px)] font-bold">Please have a seat</p>
                <p className="mt-2 text-[clamp(16px,1.6vw,32px)] text-white/70">Numbers will appear here when called.</p>
              </li>
            )}
            {lobby?.nowServing.slice(0, 6).map((s, i) => {
              const isNew = announced?.startsWith(`${s.number}:`) || now - s.calledAt < 12_000;
              return (
                <li
                  key={`${s.number}-${s.calledAt}`}
                  className={`flex items-center justify-between gap-[2vw] border-b border-white/10 px-[2vw] py-[1.8vh] ${isNew ? 'animate-highlight' : ''} ${i === 0 ? 'bg-white/[0.04]' : ''}`}
                >
                  <div className="flex items-center gap-[1.5vw]">
                    <span className="hidden sm:inline-flex">
                      <ServiceBadge code={codeOf(s.service)} size="lg" tone="dark" />
                    </span>
                    <span className="tabular text-[clamp(40px,5.6vw,120px)] font-extrabold leading-none tracking-tight">{s.number}</span>
                  </div>
                  <div className="flex min-w-0 items-center gap-[1.5vw]">
                    <svg viewBox="0 0 24 24" className="h-[4vh] min-h-[24px] w-auto shrink-0 text-white/50" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                    <span className="min-w-0 truncate text-right text-[clamp(28px,3.6vw,80px)] font-extrabold leading-none text-warning">{s.counterName}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Join + recent */}
        <aside className="flex flex-col gap-[2vw] overflow-hidden">
          <section className={`flex items-center gap-[1.5vw] rounded-2xl bg-white p-[1.5vw] text-ink ${office.status.open ? '' : 'opacity-60'}`} aria-labelledby="join-heading">
            <div className="shrink-0 rounded-lg bg-white p-1">
              <QRCodeSVG value={joinUrl} size={256} level="M" marginSize={0} className="h-[clamp(110px,11.5vw,240px)] w-[clamp(110px,11.5vw,240px)]" title="QR code to join the line" />
            </div>
            <div className="min-w-0">
              <h2 id="join-heading" className="text-[clamp(18px,1.7vw,34px)] font-extrabold leading-tight text-navy-900">
                {office.status.open ? 'Join the line from your phone' : 'The line is closed'}
              </h2>
              <p className="mt-1 text-[clamp(13px,1.05vw,20px)] text-muted">
                {office.status.open ? 'Scan with your camera. We’ll alert you when it’s your turn.' : 'Scan to see when we open again.'}
              </p>
              <p className="mt-2 break-all font-mono text-[clamp(10px,0.75vw,15px)] font-semibold text-primary-dark">{joinUrl.replace(/^https?:\/\//, '')}</p>
              {!reachable && (
                <p className="mt-2 rounded bg-warning-light px-2 py-1 text-[clamp(11px,0.85vw,16px)] font-semibold">
                  Phones can’t reach “localhost”. Set PUBLIC_URL on the server, or open this screen using the computer’s network address.
                </p>
              )}
            </div>
          </section>

          <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-navy-900" aria-labelledby="recent-heading">
            <h2 id="recent-heading" className="border-b border-white/10 px-[1.5vw] py-[1.2vh] text-[clamp(18px,1.6vw,32px)] font-bold">
              Recently called
            </h2>
            <ul className="flex-1 overflow-hidden">
              {lobby?.recent.length === 0 && <li className="px-[1.5vw] py-[1.2vh] text-white/60">No calls yet today.</li>}
              {lobby?.recent.slice(0, 8).map((r) => (
                <li
                  key={`${r.number}-${r.at}`}
                  className="grid grid-cols-[1fr_1.6fr_1fr] items-center gap-2 border-b border-white/5 px-[1.5vw] py-[1vh] text-[clamp(16px,1.4vw,28px)]"
                >
                  <span className="tabular font-bold">{r.number}</span>
                  <span className="truncate text-white/80">
                    {r.counterName}
                    {r.recall && <span className="ml-2 rounded bg-warning px-1.5 text-[0.6em] font-bold uppercase text-ink">Recall</span>}
                  </span>
                  <span className="tabular text-right text-white/50">{formatClock(r.at)}</span>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </main>

      <footer className="flex flex-wrap gap-x-[3vw] gap-y-2 border-t border-white/10 px-[2vw] py-[1.6vh]">
        {office.services.map((svc) => {
          const s = lobby?.services.find((x) => x.id === svc.id);
          return (
            <div key={svc.id} className="flex min-w-0 items-center gap-[1vw]">
              <ServiceBadge code={svc.code} tone="dark" />
              <div className="min-w-0">
                <div className="truncate text-[clamp(14px,1.3vw,26px)] font-bold">{svc.name}</div>
                <div className="text-[clamp(12px,1.1vw,22px)] text-white/75">
                  {!s ? (
                    ' '
                  ) : s.paused ? (
                    <span className="font-semibold text-warning">Paused briefly</span>
                  ) : (
                    <>
                      {s.waitingCount} waiting · {s.waitingCount ? `${formatRangeShort(s.estimate)} wait` : 'no wait'}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </footer>
    </div>
  );
}
