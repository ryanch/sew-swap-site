import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth, RequireRole } from './auth/AuthContext';
import AdminUsersPage from './pages/AdminUsersPage';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import StatusPage from './pages/StatusPage';
import VerifyPage from './pages/VerifyPage';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route
            path="/"
            element={
              <RequireAuth>
                <HomePage />
              </RequireAuth>
            }
          />
          <Route
            path="/admin/users"
            element={
              <RequireAuth>
                <RequireRole role="admin">
                  <AdminUsersPage />
                </RequireRole>
              </RequireAuth>
            }
          />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/login/verify" element={<VerifyPage />} />
          <Route path="/status" element={<StatusPage />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
