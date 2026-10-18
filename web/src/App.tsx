import { useEffect, useRef, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { LangScope, useI18n } from './i18n';
import AppointmentPage from './pages/Appointment';
import Book from './pages/Book';
import Display from './pages/Display';
import Home from './pages/Home';
import Resident from './pages/Resident';
import Settings from './pages/Settings';
import Staff from './pages/Staff';
import StaffAppointments from './pages/StaffAppointments';

function OfficeRoot() {
  const { officeId } = useParams();
  return <Navigate to={`/o/${officeId}/join`} replace />;
}

/** Resident pages follow the resident's language choice. */
const resident = (page: ReactNode) => <LangScope>{page}</LangScope>;
/** Staff and admin pages are English-only for now. */
const staff = (page: ReactNode) => <LangScope fixed="en">{page}</LangScope>;

export default function App() {
  return (
    <>
      <SkipLink />
      <FocusOnNavigate />
      <Routes>
        <Route path="/" element={staff(<Home />)} />
        <Route path="/o/:officeId" element={<OfficeRoot />} />
        <Route path="/o/:officeId/join" element={resident(<Resident />)} />
        <Route path="/o/:officeId/staff" element={staff(<Staff />)} />
        <Route path="/o/:officeId/display" element={resident(<Display />)} />
        <Route path="/o/:officeId/settings" element={staff(<Settings />)} />
        <Route path="/o/:officeId/book" element={resident(<Book />)} />
        <Route path="/o/:officeId/appointment/:apptId" element={resident(<AppointmentPage />)} />
        <Route path="/o/:officeId/appointments" element={staff(<StaffAppointments />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

const focusMain = () => {
  const main = document.getElementById('main');
  const target = main?.querySelector<HTMLElement>('h1') ?? main;
  if (!target) return;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus();
};

/** First thing a keyboard user reaches: jumps past the header to the page content. */
function SkipLink() {
  const { pathname } = useLocation();
  const staffPage = /\/(staff|settings|appointments)$/.test(pathname) || pathname === '/';
  return (
    <LangScope fixed={staffPage ? 'en' : undefined}>
      <SkipLinkInner />
    </LangScope>
  );
}

function SkipLinkInner() {
  const { t } = useI18n();
  return (
    <a
      href="#main"
      onClick={(e) => {
        e.preventDefault(); // keep the URL as is (iOS saves it for the Home Screen app)
        focusMain();
      }}
      className="sr-only z-50 rounded-md bg-white px-4 py-3 font-bold text-primary-dark shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
    >
      {t.common.skipToContent}
    </a>
  );
}

/**
 * In a single-page app, following a link doesn't move focus. Move it to the new
 * page's heading, so screen readers announce where the person landed.
 */
function FocusOnNavigate() {
  const { pathname } = useLocation();
  const last = useRef(pathname);
  useEffect(() => {
    if (last.current === pathname) return; // first render (also safe when effects run twice)
    last.current = pathname;
    // The new page may still be loading its office: wait (briefly) for its heading.
    let tries = 0;
    const id = setInterval(() => {
      if (document.querySelector('#main h1') || ++tries > 20) {
        clearInterval(id);
        focusMain();
      }
    }, 50);
    return () => clearInterval(id);
  }, [pathname]);
  return null;
}
