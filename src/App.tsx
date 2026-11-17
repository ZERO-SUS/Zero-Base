import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { CustomerProfilePage } from './pages/CustomerProfilePage';
import { CustomersPage } from './pages/CustomersPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { PaymentsPage } from './pages/PaymentsPage';
import { RemindersPage } from './pages/RemindersPage';
import { ReportsPage } from './pages/ReportsPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { SearchPage } from './pages/SearchPage';
import { ServiceArchivePage } from './pages/ServiceArchivePage';
import { ServiceDetailPage } from './pages/ServiceDetailPage';
import { ServiceHistoryPage } from './pages/ServiceHistoryPage';
import { SettingsPage } from './pages/SettingsPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <div className="text-center space-y-3">
          <img
            src="/assets/zero-base-logo.png"
            alt="ZERO BASE"
            className="mx-auto h-12 w-12 object-contain"
          />
          <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <p className="text-xs font-medium tracking-wider text-text-secondary uppercase">
            Verifying Session...
          </p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

export function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <AppShell />
                </ProtectedRoute>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="archive" element={<ServiceArchivePage />} />
              <Route path="search" element={<SearchPage />} />
              <Route path="history" element={<ServiceHistoryPage />} />
              <Route path="customers" element={<CustomersPage />} />
              <Route path="customers/:id" element={<CustomerProfilePage />} />
              <Route path="services/:id" element={<ServiceDetailPage />} />
              <Route path="reminders" element={<RemindersPage />} />
              <Route path="payments" element={<PaymentsPage />} />
              <Route path="reports" element={<ReportsPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
