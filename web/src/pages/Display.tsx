import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useRef, useState } from 'react';
import { ConnectionBanner, LiveDot } from '../components/ConnectionStatus';
import { Seal } from '../components/Header';
import { ServiceIcon } from '../components/ServiceIcon';
import { useNow } from '../lib/clock';
import { formatClock, formatMinutes, speakableTicket } from '../lib/format';
import { resolveJoinUrl } from '../lib/joinUrl';
import { useChannel } from '../lib/socket';
import { audioUnlocked, playChime, speak, unlockAudio } from '../lib/sound';
import { useConfig } from '../lib/useConfig';
import type { LobbyState } from '../types';

export default function Display() {
  const lobby = useChannel<LobbyState>({ role: 'lobby' }, 'lobby:state');
  const config = useConfig();
  const now = useNow(1000);
  const join = resolveJoinUrl(config);
  const [soundOn, setSoundOn] = useState(audioUnlocked());
  const [announced, setAnnounced] = useState<string | null>(null);

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
        setTimeout(() => speak(`Ticket ${speakableTicket(latest.number)}, please go to counter ${latest.counter}.`), 1100);
      }
    }
  }, [lobby]);

  return (
    <div className="flex h-screen min-h-[600px] flex-col overflow-hidden bg-navy-950 text-white">
      <ConnectionBanner dark />
      <header className="flex items-center justify-between border-b border-white/10 px-[3vw] py-[1.6vh]">
        <div className="flex items-center gap-4">
          <Seal className="h-[5vh] min-h-[40px] w-auto" />
          <div>
            <div className="text-[clamp(12px,1.1vw,20px)] font-semibold uppercase tracking-widest text-primary-light">City of Riverside</div>
            <div className="text-[clamp(18px,1.8vw,34px)] font-bold leading-tight">City Services Office</div>
          </div>
        </div>
        <div className="flex items-center gap-6">
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

      <main className="grid flex-1 grid-cols-1 gap-[2vw] overflow-hidden p-[2vw] lg:grid-cols-3">
        {/* Now serving */}
        <section className="flex flex-col overflow-hidden rounded-2xl bg-navy-900 lg:col-span-2" aria-labelledby="now-serving">
          <div className="flex items-baseline justify-between border-b border-white/10 px-[2vw] py-[1.5vh]">
            <h1 id="now-serving" className="text-[clamp(24px,2.6vw,52px)] font-extrabold">
              Now Serving
            </h1>
            <div className="hidden text-[clamp(14px,1.3vw,26px)] font-semibold uppercase tracking-wider text-primary-light sm:block">Ticket → Counter</div>
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
                  className={`flex items-center justify-between border-b border-white/10 px-[2vw] py-[1.8vh] ${isNew ? 'animate-highlight' : ''} ${i === 0 ? 'bg-white/[0.04]' : ''}`}
                >
                  <div className="flex items-center gap-[1.5vw]">
                    <ServiceIcon service={s.service} className="h-[4.5vh] min-h-[28px] w-auto text-primary-light" />
                    <span className="tabular text-[clamp(40px,5.6vw,120px)] font-extrabold leading-none tracking-tight">{s.number}</span>
                  </div>
                  <div className="flex items-center gap-[1.5vw]">
                    <svg viewBox="0 0 24 24" className="h-[4vh] min-h-[24px] w-auto text-white/50" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                    <span className="text-right">
                      <span className="block text-[clamp(12px,1.1vw,22px)] font-semibold uppercase tracking-widest text-primary-light">Counter</span>
                      <span className="tabular block text-[clamp(40px,5.6vw,120px)] font-extrabold leading-none text-warning">{s.counter}</span>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Join + recent */}
        <aside className="flex flex-col gap-[2vw] overflow-hidden">
          <section className="flex items-center gap-[1.5vw] rounded-2xl bg-white p-[1.5vw] text-ink" aria-labelledby="join-heading">
            <div className="shrink-0 rounded-lg bg-white p-1">
              <QRCodeSVG value={join.url} size={256} level="M" marginSize={0} className="h-[clamp(110px,11.5vw,240px)] w-[clamp(110px,11.5vw,240px)]" title="QR code to join the line" />
            </div>
            <div className="min-w-0">
              <h2 id="join-heading" className="text-[clamp(18px,1.7vw,34px)] font-extrabold leading-tight text-navy-900">
                Join the line from your phone
              </h2>
              <p className="mt-1 text-[clamp(13px,1.05vw,20px)] text-muted">Scan with your camera. We’ll alert you when it’s your turn.</p>
              <p className="mt-2 whitespace-nowrap font-mono text-[clamp(10px,0.8vw,16px)] font-semibold text-primary-dark">{join.url.replace(/^https?:\/\//, '')}</p>
              {!join.reachable && (
                <p className="mt-2 rounded bg-warning-light px-2 py-1 text-[clamp(11px,0.85vw,16px)] font-semibold">
                  Phones can’t reach “localhost”. Open this screen using the computer’s network address, or set HOST_IP.
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
                <li key={`${r.number}-${r.at}`} className="grid grid-cols-[1fr_1.4fr_1fr] items-center border-b border-white/5 px-[1.5vw] py-[1vh] text-[clamp(16px,1.5vw,30px)]">
                  <span className="tabular font-bold">{r.number}</span>
                  <span className="text-white/80">
                    Counter {r.counter}
                    {r.recall && <span className="ml-2 rounded bg-warning px-1.5 text-[0.6em] font-bold uppercase text-ink">Recall</span>}
                  </span>
                  <span className="tabular text-right text-white/50">{formatClock(r.at)}</span>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </main>

      <footer className="grid grid-cols-3 gap-[2vw] border-t border-white/10 px-[2vw] py-[1.6vh]">
        {(lobby?.services ?? []).map((s) => (
          <div key={s.id} className="flex items-center gap-[1vw]">
            <ServiceIcon service={s.id} className="h-[4vh] min-h-[24px] w-auto shrink-0 text-primary-light" />
            <div className="min-w-0">
              <div className="truncate text-[clamp(14px,1.3vw,26px)] font-bold">{s.name}</div>
              <div className="text-[clamp(12px,1.1vw,22px)] text-white/75">
                {s.paused ? (
                  <span className="font-semibold text-warning">Paused briefly</span>
                ) : (
                  <>
                    {s.waitingCount} waiting · {s.waitingCount ? `~${formatMinutes(s.estimatedWaitSec)} wait` : 'no wait'}
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </footer>

    </div>
  );
}
