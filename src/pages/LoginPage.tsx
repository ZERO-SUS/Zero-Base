import React, { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Lock, Mail } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { isSupabaseConfigured, supabase } from '../lib/supabase';

export function LoginPage() {
  const { user, loading, authError } = useAuth();
  const [mode, setMode] = useState<'login' | 'forgot'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!loading && user) {
    return <Navigate to="/" replace />;
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (!isSupabaseConfigured) {
      setError('Supabase credentials are not configured in environment variables.');
      return;
    }

    setSubmitting(true);
    try {
      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInErr) {
        setError(signInErr.message);
      }
    } catch {
      setError('Unable to sign in. Check your network connection.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (!isSupabaseConfigured) {
      setError('Supabase credentials are not configured in environment variables.');
      return;
    }

    setSubmitting(true);
    try {
      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (resetErr) {
        setError(resetErr.message);
      } else {
        setMessage('If this email corresponds to an authorized administrator account, a password reset link has been sent.');
      }
    } catch {
      setError('Unable to send password reset email.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <div className="mx-auto inline-flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-sm font-bold tracking-tight text-accent-fg">
            ZB
          </div>
          <h1 className="mt-4 text-lg font-semibold tracking-[0.18em] text-text-primary uppercase">
            ZERO BASE
          </h1>
          <p className="mt-1 text-xs text-text-secondary">
            Private Business Management Portal — Authorized Administrators Only
          </p>
        </div>

        <div className="zb-card p-6 sm:p-7">
          {(error || authError) && (
            <div className="mb-4 rounded-lg border border-error/30 bg-error-soft px-3.5 py-2.5 text-xs text-error">
              {error ?? authError}
            </div>
          )}

          {message && (
            <div className="mb-4 rounded-lg border border-success/30 bg-success-soft px-3.5 py-2.5 text-xs text-success">
              {message}
            </div>
          )}

          {mode === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-text-secondary">
                  Administrator Email
                </label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-text-muted" />
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@company.com"
                    className="w-full rounded-lg border pl-9 pr-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-text-secondary">
                  Password
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-text-muted" />
                  <input
                    type="password"
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="w-full rounded-lg border pl-9 pr-3 py-2 text-sm"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="zb-btn-primary w-full rounded-lg px-4 py-2.5 text-sm font-medium transition disabled:opacity-50"
              >
                {submitting ? 'Signing in...' : 'Sign In'}
              </button>

              <div className="pt-1 text-center">
                <button
                  type="button"
                  onClick={() => {
                    setMode('forgot');
                    setError(null);
                    setMessage(null);
                  }}
                  className="text-xs font-medium text-accent hover:underline"
                >
                  Forgot password?
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleResetRequest} className="space-y-4">
              <div>
                <h2 className="text-sm font-semibold text-text-primary">Reset Password</h2>
                <p className="mt-1 text-xs text-text-secondary">
                  Enter your administrator email address to receive a recovery link.
                </p>
              </div>

              <div>
                <label className="mb-1.5 block text-xs font-medium text-text-secondary">
                  Email Address
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@company.com"
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="zb-btn-primary w-full rounded-lg px-4 py-2.5 text-sm font-medium transition disabled:opacity-50"
              >
                {submitting ? 'Sending link...' : 'Send Reset Link'}
              </button>

              <div className="pt-1 text-center">
                <button
                  type="button"
                  onClick={() => {
                    setMode('login');
                    setError(null);
                    setMessage(null);
                  }}
                  className="text-xs font-medium text-text-secondary hover:text-text-primary"
                >
                  Back to sign in
                </button>
              </div>
            </form>
          )}
        </div>

        <p className="text-center text-[11px] text-text-muted">
          Public registration is disabled. Accounts are provisioned exclusively by the system administrator.
        </p>
      </div>
    </div>
  );
}
