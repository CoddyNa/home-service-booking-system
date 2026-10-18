// apps/web/src/components/AuthForm.jsx
import React, { useState, useEffect } from 'react';
import '../styles/AuthForm.css';
import { csrfFetch, getCsrfToken, rememberCsrfToken } from '../services/csrf';

const AuthForm = ({ onAuthenticated, onBack }) => {
  const [active, setActive] = useState(false); // false = login, true = register
  const [csrfToken, setCsrfToken] = useState('');
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('info');
  const [busy, setBusy] = useState(false);
  const [needs2FA, setNeeds2FA] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [totpSetup, setTotpSetup] = useState(null);
  const [setupCode, setSetupCode] = useState('');
  const [resetToken, setResetToken] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') || new URLSearchParams(window.location.search).get('token') || '');

  // Fetch CSRF token on mount
  useEffect(() => {
    let mounted = true;
    getCsrfToken().then((token) => { if (mounted) setCsrfToken(token); });
    return () => { mounted = false; };
  }, []);

  const handleRegisterClick = (e) => {
    e.preventDefault();
    setActive(true);
  };

  const handleLoginClick = (e) => {
    e.preventDefault();
    setActive(false);
  };

  const handleLoginSubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    setBusy(true); setMessage('');
    const payload = needs2FA ? { code: form.code.value } : { email: form.username.value, password: form.password.value };
    try {
      const res = await csrfFetch(needs2FA ? '/api/auth/2fa/verify' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok && data.requires2FA) {
        setNeeds2FA(true); setMessage('Enter the code from your authenticator app.'); setMessageType('info');
      } else if (res.ok) {
        if (data.csrfToken) { rememberCsrfToken(data.csrfToken); setCsrfToken(data.csrfToken); }
        if (!data.user) throw new Error('Login succeeded but the account profile was not returned.');
        onAuthenticated?.(data.user, data.csrfToken || csrfToken);
        setNeeds2FA(false); setAuthenticated(true); setMessage('Login successful'); setMessageType('success');
      } else {
        setMessage(data.error || 'Login failed'); setMessageType('error');
      }
    } catch {
      setMessage('Network error. Check that the API server is running.'); setMessageType('error');
    } finally { setBusy(false); }
  };

  const handleTotpSetup = async () => {
    setBusy(true);
    try {
      const res = await csrfFetch('/api/auth/2fa/setup', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start authenticator setup');
      setTotpSetup(data);
      setMessage('Add the secret below to your authenticator app, then verify a code.'); setMessageType('info');
    } catch (error) { setMessage(error.message); setMessageType('error'); }
    finally { setBusy(false); }
  };

  const handleTotpVerify = async (event) => {
    event?.preventDefault(); setBusy(true);
    try {
      const res = await csrfFetch('/api/auth/2fa/verify', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ code: setupCode }) });
      const data = await res.json();
      setMessage(data.message || data.error || 'Could not verify code.'); setMessageType(res.ok ? 'success' : 'error');
      if (res.ok) setTotpSetup(null);
    } catch { setMessage('Network error. Check that the API server is running.'); setMessageType('error'); }
    finally { setBusy(false); }
  };

  const handleLogout = async () => {
    try {
      const res = await csrfFetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } });
      if (!res.ok) throw new Error('Could not log out');
      setAuthenticated(false); setNeeds2FA(false); setTotpSetup(null); setMessage('Logged out'); setMessageType('success');
      const token = await getCsrfToken(true);
      if (token) setCsrfToken(token);
    } catch (error) { setMessage(error.message); setMessageType('error'); }
  };

  const handleRegisterSubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = {
      username: form.username.value,
      email: form.email.value,
      password: form.password.value,
    };
    setBusy(true); setMessage('');
    try {
      const res = await csrfFetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok) {
        setMessage('Registration successful. You can now log in.'); setMessageType('success');
      } else {
        setMessage(data.error || 'Registration failed'); setMessageType('error');
      }
    } catch {
      setMessage('Network error. Check that the API server is running.'); setMessageType('error');
    } finally { setBusy(false); }
  };

  const handleForgotPassword = async (e) => {
    e.preventDefault();
    const email = e.currentTarget.form.username.value;
    try {
      const res = await csrfFetch('/api/auth/password-reset/request', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ email }) });
      const data = await res.json();
      if (res.ok && data.resetToken) {
        setResetToken(data.resetToken);
        setMessage('Choose a new password to finish resetting your account.');
        setMessageType('info');
        return;
      }
      setMessage(data.message || data.error || 'Could not request password reset.');
      setMessageType(res.ok ? 'info' : 'error');
    } catch { setMessage('Network error. Check that the API server is running.'); setMessageType('error'); }
  };

  const handlePasswordReset = async (event) => {
    event.preventDefault(); setBusy(true);
    try {
      const res = await csrfFetch('/api/auth/password-reset/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ token: resetToken, password: event.currentTarget.resetPassword.value }) });
      const data = await res.json();
      setMessage(data.message || data.error || 'Could not reset password.'); setMessageType(res.ok ? 'success' : 'error');
      if (res.ok) { setResetToken(''); window.history.replaceState({}, '', window.location.pathname); }
    } catch { setMessage('Network error. Check that the API server is running.'); setMessageType('error'); }
    finally { setBusy(false); }
  };

  return (
    <div className={`container ${active ? 'active' : ''}`}>
      <button type="button" className="auth-back-link" onClick={onBack}><i className="bx bx-left-arrow-alt"/> Homewise</button>
      {/* Login Form */}
      <div className="form-box login">
        <form onSubmit={resetToken ? handlePasswordReset : handleLoginSubmit}>
          {resetToken ? <>
            <h1>Reset Password</h1>
            <p>Choose a new password with at least 12 characters.</p>
            <div className="input-box"><input type="password" name="resetPassword" placeholder="New password" minLength={12} required /><i className="bx bxs-lock-alt"></i></div>
            <button type="submit" className="btn" disabled={busy || !csrfToken}>{busy ? 'Please wait…' : 'Update password'}</button>
          </> : authenticated ? <>
            <h1>Account</h1>
            <p>You are signed in securely.</p>
            {!totpSetup ? <button type="button" className="btn" onClick={handleTotpSetup} disabled={busy || !csrfToken}>Set up authenticator</button> : <>
              <img className="totp-qr" src={totpSetup.qrCodeDataUrl} alt="Authenticator setup QR code" />
              <p>Enter this key in your authenticator app:</p>
              <code className="totp-secret">{totpSetup.secret}</code>
              <div className="input-box"><input type="text" inputMode="numeric" pattern="[0-9]{6}" placeholder="6-digit code" value={setupCode} onChange={(event) => setSetupCode(event.target.value)} required /></div>
              <button type="button" className="btn" disabled={busy || setupCode.length !== 6} onClick={() => handleTotpVerify()}>Verify and enable 2FA</button>
            </>}
            <button type="button" className="btn account-logout" onClick={handleLogout}>Log out</button>
          </> : <>
          <h1>Login</h1>
          <div className="input-box">
            {!needs2FA ? <input type="email" placeholder="Email" name="username" required /> : <input type="text" inputMode="numeric" pattern="[0-9]{6}" placeholder="6-digit authenticator code" name="code" required />}
            <i className="bx bxs-user"></i>
          </div>
          <div className="input-box">
            {!needs2FA && <input type="password" placeholder="Password" name="password" required />}
            <i className="bx bxs-lock-alt"></i>
          </div>
          <div className="forgot-link">
            {!needs2FA && <a href="#" onClick={handleForgotPassword}>Forgot Password?</a>}
          </div>
          <button type="submit" className="btn" disabled={busy || !csrfToken}>{busy ? 'Please wait…' : needs2FA ? 'Verify code' : 'Login'}</button>
          <p>or login with social platforms</p>
          <div className="social-icons">
            <a href="#"><i className="bx bxl-google"></i></a>
            <a href="#"><i className="bx bxl-facebook"></i></a>
            <a href="#"><i className="bx bxl-github"></i></a>
            <a href="#"><i className="bx bxl-linkedin"></i></a>
          </div>
          </>}
        </form>
      </div>

      {/* Register Form */}
      <div className="form-box register">
        <form onSubmit={handleRegisterSubmit}>
          <h1>Registration</h1>
          <div className="input-box">
            <input type="text" placeholder="Username" name="username" autoComplete="username" maxLength={80} required />
            <i className="bx bxs-user"></i>
          </div>
          <div className="input-box">
            <input type="email" placeholder="Email" name="email" autoComplete="email" maxLength={254} required />
            <i className="bx bxs-envelope"></i>
          </div>
          <div className="input-box">
            <input type="password" placeholder="Password (at least 12 characters)" name="password" autoComplete="new-password" minLength={12} maxLength={1024} required />
            <i className="bx bxs-lock-alt"></i>
          </div>
          <button type="submit" className="btn" disabled={busy || !csrfToken}>{busy ? 'Please wait…' : 'Register'}</button>
          <p>or register with social platforms</p>
          <div className="social-icons">
            <a href="#"><i className="bx bxl-google"></i></a>
            <a href="#"><i className="bx bxl-facebook"></i></a>
            <a href="#"><i className="bx bxl-github"></i></a>
            <a href="#"><i className="bx bxl-linkedin"></i></a>
          </div>
        </form>
      </div>

      {/* Toggle panels */}
      <div className="toggle-box">
        <div className="toggle-panel toggle-left">
          <h1>Hello, Welcome!</h1>
          <p>Don't have an account?</p>
          <button className="btn register-btn" onClick={handleRegisterClick}>Register</button>
        </div>
        <div className="toggle-panel toggle-right">
          <h1>Welcome Back!</h1>
          <p>Already have an account?</p>
          <button className="btn login-btn" onClick={handleLoginClick}>Login</button>
        </div>
      </div>
      {message && <div className={`status-message ${messageType}`} role="status">{message}</div>}
    </div>
  );
};

export default AuthForm;
