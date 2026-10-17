import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Display from './pages/Display';
import Home from './pages/Home';
import Resident from './pages/Resident';
import Staff from './pages/Staff';

const TITLES: Record<string, string> = {
  '/': 'City Services — Virtual Queue',
  '/join': 'Join the Line — City Services',
  '/staff': 'Staff Console — City Services',
  '/display': 'Now Serving — City Services',
};

export default function App() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = TITLES[pathname] ?? TITLES['/'];
  }, [pathname]);

  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/join" element={<Resident />} />
      <Route path="/staff" element={<Staff />} />
      <Route path="/display" element={<Display />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
