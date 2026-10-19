import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth, RequireRole } from './auth/AuthContext';
import AdminUsersPage from './pages/AdminUsersPage';
import EmailsPage from './pages/EmailsPage';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import MakesPage from './pages/MakesPage';
import PodPage from './pages/PodPage';
import SwapDetailPage from './pages/SwapDetailPage';
import SwapJoinPage from './pages/SwapJoinPage';
import SwapMemberPage from './pages/SwapMemberPage';
import SwapMembersPage from './pages/SwapMembersPage';
import SwapFormPage from './pages/SwapFormPage';
import SwapPodsPage from './pages/SwapPodsPage';
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
            path="/makes"
            element={
              <RequireAuth>
                <MakesPage />
              </RequireAuth>
            }
          />
          <Route
            path="/emails"
            element={
              <RequireAuth>
                <EmailsPage />
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
            path="/swaps/:swapId/join"
            element={
              <RequireAuth>
                <SwapJoinPage />
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
          <Route
            path="/manage/swaps/:swapId/members"
            element={
              <RequireAuth>
                <SwapMembersPage />
              </RequireAuth>
            }
          />
          <Route
            path="/manage/swaps/:swapId/members/:userId"
            element={
              <RequireAuth>
                <SwapMemberPage />
              </RequireAuth>
            }
          />
          <Route
            path="/manage/swaps/:swapId/pods"
            element={
              <RequireAuth>
                <SwapPodsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/manage/swaps/:swapId/pods/:podId"
            element={
              <RequireAuth>
                <PodPage />
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
