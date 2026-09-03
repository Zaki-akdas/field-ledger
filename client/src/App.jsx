import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, SyncProvider, ToastProvider, useAuth } from './lib/context.jsx';
import { Loading } from './components/ui.jsx';

import Login from './pages/Login.jsx';
import FieldLayout from './components/FieldLayout.jsx';
import AdminLayout from './components/AdminLayout.jsx';

import StartDay from './pages/field/StartDay.jsx';
import Bills from './pages/field/Bills.jsx';
import BillDetail from './pages/field/BillDetail.jsx';
import Collect from './pages/field/Collect.jsx';
import CancelBill from './pages/field/CancelBill.jsx';
import Shortage from './pages/field/Shortage.jsx';
import FieldUpload from './pages/field/Upload.jsx';
import Me from './pages/field/Me.jsx';
import EndDay from './pages/field/EndDay.jsx';

import Reconciliation from './pages/admin/Reconciliation.jsx';
import Salesmen from './pages/admin/Salesmen.jsx';
import SalesmanDetail from './pages/admin/SalesmanDetail.jsx';
import AdminBills from './pages/admin/Bills.jsx';
import Cancellations from './pages/admin/Cancellations.jsx';
import Shortages from './pages/admin/Shortages.jsx';
import CashRollup from './pages/admin/CashRollup.jsx';
import AdminUpload from './pages/admin/Upload.jsx';

function Guard({ children, role }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading label="Opening your book…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (role && user.role !== role) {
    return <Navigate to={user.role === 'admin' ? '/admin' : '/field/bills'} replace />;
  }
  return children;
}

function Home() {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={user.role === 'admin' ? '/admin' : '/field/start'} replace />;
}

function NotFound() {
  return (
    <div className="mx-auto max-w-md px-6 py-24 text-center">
      <p className="num text-[42px] font-medium text-line-strong">404</p>
      <h1 className="mt-2 text-[20px] font-semibold">That page isn’t in the book</h1>
      <p className="mt-1 text-[14px] text-ink-soft">Check the address, or head back to your dashboard.</p>
      <a href="/" className="mt-5 inline-block rounded-lg bg-ink px-4 py-2.5 text-[14px] font-medium text-paper">Go home</a>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <SyncProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<Home />} />

            <Route path="/field" element={<Guard role="salesman"><FieldLayout /></Guard>}>
              <Route index element={<StartDay />} />
              <Route path="start" element={<StartDay />} />
              <Route path="bills" element={<Bills />} />
              <Route path="collect" element={<Bills mode="collect" />} />
              <Route path="bills/:id" element={<BillDetail />} />
              <Route path="bills/:id/collect" element={<Collect />} />
              <Route path="bills/:id/cancel" element={<CancelBill />} />
              <Route path="bills/:id/shortage" element={<Shortage />} />
              <Route path="upload" element={<FieldUpload />} />
              <Route path="me" element={<Me />} />
              <Route path="end" element={<EndDay />} />
            </Route>

            <Route path="/admin" element={<Guard role="admin"><AdminLayout /></Guard>}>
              <Route index element={<Reconciliation />} />
              <Route path="salesmen" element={<Salesmen />} />
              <Route path="salesmen/:id" element={<SalesmanDetail />} />
              <Route path="bills" element={<AdminBills />} />
              <Route path="cancellations" element={<Cancellations />} />
              <Route path="shortages" element={<Shortages />} />
              <Route path="cash" element={<CashRollup />} />
              <Route path="upload" element={<AdminUpload />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </SyncProvider>
      </ToastProvider>
    </AuthProvider>
  );
}
