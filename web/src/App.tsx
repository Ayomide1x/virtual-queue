import { Navigate, Route, Routes, useParams } from 'react-router-dom';
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

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/o/:officeId" element={<OfficeRoot />} />
      <Route path="/o/:officeId/join" element={<Resident />} />
      <Route path="/o/:officeId/staff" element={<Staff />} />
      <Route path="/o/:officeId/display" element={<Display />} />
      <Route path="/o/:officeId/settings" element={<Settings />} />
      <Route path="/o/:officeId/book" element={<Book />} />
      <Route path="/o/:officeId/appointment/:apptId" element={<AppointmentPage />} />
      <Route path="/o/:officeId/appointments" element={<StaffAppointments />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
