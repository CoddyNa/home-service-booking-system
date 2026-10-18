import AuthForm from './components/AuthForm';
import Dashboard from './components/Dashboard';
import { useEffect, useState } from 'react';
import { csrfFetch, getCsrfToken } from './services/csrf';
import { apiFetch } from './services/api';
import './styles/AuthForm.css';
import PublicHome from './components/PublicHome';

function App() {
  const [user, setUser] = useState(null);
  const [csrfToken, setCsrfToken] = useState('');
  const [showAuth, setShowAuth] = useState(false);
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [profileResponse, token] = await Promise.all([
          apiFetch('/api/auth/me'),
          getCsrfToken(),
        ]);
        if (profileResponse.ok) {
          const profile = await profileResponse.json();
          if (mounted && profile?.user) { setCsrfToken(token); setUser(profile.user); }
        }
      } catch { /* AuthForm presents connection errors when the user submits. */ }
    })();
    return () => { mounted = false; };
  }, []);
  async function logout() {
    const response = await csrfFetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } });
    if (!response.ok) throw new Error('Could not log out. Refresh the page and try again.');
    setUser(null);
    setShowAuth(false);
    const token = await getCsrfToken(true);
    setCsrfToken(token);
  }
  if (user) return <Dashboard user={user} csrfToken={csrfToken} onLogout={logout} />;
  if (!showAuth) return <PublicHome onShowAuth={() => setShowAuth(true)} />;
  return <AuthForm onAuthenticated={(profile, token) => { setUser(profile); setCsrfToken(token); }} onBack={() => setShowAuth(false)} />;
}

export default App;
