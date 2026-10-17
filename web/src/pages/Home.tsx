import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { resolveJoinUrl } from '../lib/joinUrl';
import { useConfig } from '../lib/useConfig';

const SCREENS = [
  {
    to: '/join',
    title: 'Join the line',
    audience: 'Residents · phone',
    body: 'Pick a service, get a ticket number and follow your place in line live.',
    icon: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2',
  },
  {
    to: '/staff',
    title: 'Staff console',
    audience: 'Staff · desktop',
    body: 'Call the next resident, mark served or no-show, recall, and pause lines.',
    icon: 'M3 4h18v12H3zM8 20h8M12 16v4',
  },
  {
    to: '/display',
    title: 'Lobby display',
    audience: 'Waiting room · TV',
    body: 'Now serving board, recently called numbers and a QR code to join.',
    icon: 'M2 5h20v12H2zM7 21h10M9 17l-1 4M15 17l1 4',
  },
];

export default function Home() {
  const config = useConfig();
  const join = resolveJoinUrl(config);
  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <h1 className="text-3xl font-extrabold text-navy-900 sm:text-4xl">Virtual Queue</h1>
        <p className="mt-2 max-w-2xl text-lg text-muted">
          Residents wait wherever they like and are alerted when it’s their turn. Open each screen in its own window. They stay in sync in real time.
        </p>
        <ul className="mt-8 grid gap-4 md:grid-cols-3">
          {SCREENS.map((s) => (
            <li key={s.to}>
              <Link to={s.to} className="card group flex h-full flex-col p-6 transition-colors hover:border-primary hover:bg-primary-lighter">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-lighter text-primary group-hover:bg-primary group-hover:text-white">
                  <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d={s.icon} />
                  </svg>
                </span>
                <span className="mt-4 text-xs font-semibold uppercase tracking-wider text-muted">{s.audience}</span>
                <span className="mt-1 text-xl font-bold text-navy-900">{s.title}</span>
                <span className="mt-2 flex-1 text-muted">{s.body}</span>
                <span className="mt-4 font-semibold text-primary group-hover:underline">Open {s.title.toLowerCase()} →</span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-8 rounded-md bg-white p-4 text-muted">
          <strong className="text-ink">On a phone?</strong> Join at <span className="break-all font-mono font-semibold text-primary-dark">{join.url}</span> (same Wi-Fi network).
        </p>
      </main>
    </div>
  );
}
