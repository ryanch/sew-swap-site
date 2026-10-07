import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth, RequireRole } from './auth/AuthContext';
import AdminUsersPage from './pages/AdminUsersPage';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import SwapDetailPage from './pages/SwapDetailPage';
import SwapFormPage from './pages/SwapFormPage';
import SwapsPage from './pages/SwapsPage';
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
          <Route
            path="/swaps"
            element={
              <RequireAuth>
                <SwapsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/swaps/:swapId"
            element={
              <RequireAuth>
                <SwapDetailPage />
              </RequireAuth>
            }
          />
          <Route
            path="/manage/swaps"
            element={
              <RequireAuth>
                <RequireRole role="swap_manager">
                  <SwapsPage mine />
                </RequireRole>
              </RequireAuth>
            }
          />
          <Route
            path="/manage/swaps/new"
            element={
              <RequireAuth>
                <RequireRole role="swap_manager">
                  <SwapFormPage />
                </RequireRole>
              </RequireAuth>
            }
          />
          <Route
            path="/manage/swaps/:swapId/edit"
            element={
              <RequireAuth>
                <RequireRole role="swap_manager">
                  <SwapFormPage />
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
