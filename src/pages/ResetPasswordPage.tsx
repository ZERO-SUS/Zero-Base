import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 10) {
      setError('Password must be at least 10 characters long.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const { error: updateErr } = await supabase.auth.updateUser({ password });
      if (updateErr) {
        setError(updateErr.message);
      } else {
        setDone(true);
        window.setTimeout(() => navigate('/login', { replace: true }), 1800);
      }
    } catch {
      setError('Failed to update password.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="zb-card w-full max-w-md p-6">
        <div className="mb-4 flex items-center gap-2.5">
          <img
            src="/assets/zero-base-logo.png"
            alt="ZERO BASE"
            className="h-8 w-8 object-contain"
          />
          <h1 className="text-base font-semibold text-text-primary">Set New Password</h1>
        </div>
        <p className="text-xs text-text-secondary">
          Choose a strong password for your ZERO BASE administrator account.
        </p>

        {error && (
          <div className="mt-4 rounded-lg border border-error/30 bg-error-soft px-3 py-2 text-xs text-error">
            {error}
          </div>
        )}

        {done ? (
          <div className="mt-4 rounded-lg border border-success/30 bg-success-soft px-3 py-2 text-xs text-success">
            Password updated successfully. Redirecting to sign in...
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-secondary">
                New Password
              </label>
              <input
                type="password"
                required
                minLength={10}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-text-secondary">
                Confirm New Password
              </label>
              <input
                type="password"
                required
                minLength={10}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="zb-btn-primary w-full rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {submitting ? 'Updating...' : 'Update Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
