import { useCallback, useEffect, useState } from 'react';
import { csrfFetch } from '../services/csrf';
import { apiFetch } from '../services/api';
import '../styles/Dashboard.css';
import Marketplace from './Marketplace';
import BookingsPanel from './BookingsPanel';
import ProviderPanel from './ProviderPanel';
import SupportPanel from './SupportPanel';
import AdminMarketplace from './AdminMarketplace';
import NotificationsPanel from './NotificationsPanel';
import ProfilePanel from './ProfilePanel';

const roleLabels = { admin: 'Administration', auditor: 'Audit console', staff: 'Staff workspace', user: 'My account', customer: 'Customer workspace', provider: 'Provider workspace', support_agent: 'Support workspace' };

export default function Dashboard({ user, csrfToken, onLogout }) {
  const [section, setSection] = useState('overview');
  const [users, setUsers] = useState([]);
  const [events, setEvents] = useState([]);
  const [backups, setBackups] = useState([]);
  const [backupOperations, setBackupOperations] = useState([]);
  const [preview, setPreview] = useState(null);
  const [notice, setNotice] = useState('');
  const [totp, setTotp] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(user.totp_enabled);
  const [recoveryConfigured, setRecoveryConfigured] = useState(false);
  const isAdmin = user.role === 'admin';
  const canAudit = ['admin', 'auditor'].includes(user.role);
  const isCustomer = ['customer', 'user'].includes(user.role);

  const loadAdminData = useCallback(async () => {
    const requests = await Promise.all([
      isAdmin ? apiFetch('/api/auth/admin/users') : null,
      canAudit ? apiFetch('/api/auth/admin/audit-logs') : null,
    ]);
    if (requests[0]?.ok) setUsers((await requests[0].json()).users);
    if (requests[1]?.ok) setEvents((await requests[1].json()).events);
  }, [isAdmin, canAudit]);
  useEffect(() => { queueMicrotask(() => { void loadAdminData(); }); }, [loadAdminData]);
  useEffect(() => {
    if (isAdmin && section === 'backups') apiFetch('/api/admin/backups').then((res) => res.ok ? res.json() : null).then((data) => { if (data) { setBackups(data.backups); setBackupOperations(data.operations || []); setRecoveryConfigured(data.recoveryConfigured); } }).catch(() => {});
  }, [isAdmin, section]);

  async function updateRole(id, role) {
    setNotice('');
    const response = await csrfFetch(`/api/auth/admin/users/${id}/role`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ role }) });
    const data = await response.json(); setNotice(data.message || data.error || 'Could not update role.');
    if (response.ok) loadAdminData();
  }
  async function deactivate(id) {
    if (!window.confirm('Deactivate this account? Its audit history will be retained.')) return;
    const response = await csrfFetch(`/api/auth/admin/users/${id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken } });
    const data = await response.json(); setNotice(data.message || data.error || 'Could not deactivate user.');
    if (response.ok) loadAdminData();
  }
  async function setup2fa() {
    setBusy(true);
    try { const response = await csrfFetch('/api/auth/2fa/setup', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setTotp(data); }
    catch (error) { setNotice(error.message || 'Could not set up authenticator.'); } finally { setBusy(false); }
  }
  async function verify2fa(event) {
    event.preventDefault(); setBusy(true);
    try { const response = await csrfFetch('/api/auth/2fa/verify', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ code }) }); const data = await response.json(); setNotice(data.message || data.error); if (response.ok) { setTotp(null); setCode(''); setTwoFactorEnabled(true); } }
    catch { setNotice('Could not verify authenticator code.'); } finally { setBusy(false); }
  }
  async function createBackup() {
    setBusy(true); setNotice('');
    try {
      const response = await csrfFetch('/api/admin/backups', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } }); const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Backup could not be started.');
      const id = data.backup.operationId; setNotice(`Backup started: ${id}`);
      for (let attempt = 0; attempt < 240; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const status = await apiFetch(`/api/admin/backups/operations/${id}`); const payload = await status.json();
        if (!status.ok) throw new Error(payload.error || 'Could not read backup status.');
        const op = payload.operation;
        if (op.status === 'complete' || op.status === 'failed') {
          setNotice(op.status === 'complete' ? `Verified S3 backup created: ${id}` : `Backup failed: ${op.error_message || 'See server logs for details.'}`);
          const list = await apiFetch('/api/admin/backups'); if (list.ok) { const records = await list.json(); setBackups(records.backups); setBackupOperations(records.operations || []); setRecoveryConfigured(records.recoveryConfigured); }
          break;
        }
        setNotice(`Backup running · database ${op.database_status} · upload ${op.upload_status} · verification ${op.verification_status}`);
      }
    }
    catch (error) { setNotice(error.message || 'Backup could not be created.'); } finally { setBusy(false); }
  }
  async function verifyBackup(id) {
    setBusy(true); setNotice('Verifying S3 object, checksum, encryption, and PostgreSQL archive…');
    try {
      const response = await csrfFetch(`/api/admin/backups/${id}/verify`, { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Verification could not start.');
      for (let attempt = 0; attempt < 240; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const status = await apiFetch(`/api/admin/backups/operations/${data.verification.operationId}`); const payload = await status.json();
        if (!status.ok) throw new Error(payload.error || 'Could not read verification status.');
        if (payload.operation.status === 'complete') { setNotice(`Backup verified: S3 size, SHA-256, encryption, and PostgreSQL archive checks passed.`); break; }
        if (payload.operation.status === 'failed') throw new Error(payload.operation.error_message || 'Verification failed.');
        setNotice(`Verifying backup · ${payload.operation.verification_status}`);
      }
      const list = await apiFetch('/api/admin/backups'); if (list.ok) { const records = await list.json(); setBackups(records.backups); setBackupOperations(records.operations || []); }
    }
    catch (error) { setNotice(error.message || 'Verification failed.'); } finally { setBusy(false); }
  }
  async function cleanupExpired() {
    if (!window.confirm('Permanently delete eligible S3 backups older than seven days?')) return;
    setBusy(true); setNotice('');
    try { const response = await csrfFetch('/api/admin/backups/cleanup', { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Retention cleanup failed.'); setNotice(`${data.deleted} expired backup${data.deleted === 1 ? '' : 's'} deleted.`); const list = await apiFetch('/api/admin/backups'); if (list.ok) { const records = await list.json(); setBackups(records.backups); setBackupOperations(records.operations || []); } }
    catch (error) { setNotice(error.message || 'Retention cleanup failed.'); } finally { setBusy(false); }
  }
  async function previewRestore(id) {
    setBusy(true); setNotice('');
    try { const response = await csrfFetch(`/api/admin/backups/${id}/preview`, { method: 'POST', headers: { 'X-CSRF-Token': csrfToken } }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Restore point could not be read.'); setPreview(data.preview); setNotice('Restore preview verified. This did not change database data.'); }
    catch (error) { setNotice(error.message || 'Restore point could not be read.'); } finally { setBusy(false); }
  }
  async function restoreBackup(id) {
    const confirmation = window.prompt(`Restore into the configured separate recovery database. The active database will remain unchanged. Type RESTORE ${id} to continue.`);
    if (confirmation !== `RESTORE ${id}`) return;
    setBusy(true); setNotice('');
    try {
      const response = await csrfFetch(`/api/admin/backups/${id}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ confirmation }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Restore failed.');
      setNotice(data.message);
      for (let attempt = 0; attempt < 240; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const status = await apiFetch(`/api/admin/backups/operations/${data.operationId}`); const payload = await status.json();
        if (!status.ok) throw new Error(payload.error || 'Could not read restore status.');
        if (payload.operation.status === 'complete') { setNotice('Restore to the separate recovery database completed. The active application database was not changed.'); break; }
        if (payload.operation.status === 'failed') throw new Error(payload.operation.error_message || 'Restore failed.');
        setNotice(`Restore running · ${payload.operation.database_status}`);
      }
      const list = await apiFetch('/api/admin/backups'); if (list.ok) { const records = await list.json(); setBackups(records.backups); setBackupOperations(records.operations || []); }
    }
    catch (error) { setNotice(error.message || 'Restore failed.'); } finally { setBusy(false); }
  }

  return <main className={`dashboard ${isAdmin ? 'dashboard-admin' : ''}`}>
    <aside className="dashboard-sidebar"><div className="dashboard-brand"><div><strong>Secure Auth</strong><small>Identity console</small></div></div>
      <div className="dashboard-role">{roleLabels[user.role] || 'Account'}</div>
      <nav>{[
        ['overview', 'Overview'],
        ...(!isAdmin && !['auditor','staff'].includes(user.role) ? [['marketplace', 'Find services']] : []),
        ...(isCustomer ? [['provider', 'Become a provider'], ['bookings', 'My bookings']] : []),
        ...(user.role === 'provider' ? [['provider', 'My services'], ['bookings', 'Bookings']] : []),
        ...(isAdmin ? [['users', 'User directory'], ['market-admin', 'Marketplace admin'], ['bookings','All bookings'], ['backups', 'Backups & restore']] : []),
        ...(canAudit ? [['audit', 'Audit history']] : []),
        ...(['customer','user','provider','support_agent','admin'].includes(user.role) ? [['support', user.role === 'support_agent' ? 'Support desk' : 'Support']] : []),
        ...(!['provider'].includes(user.role) ? [['profile','My profile']] : []),
        ['notifications', 'Notifications'], ['security', 'Security settings'],
      ].map(([id, label]) => <button className={section === id ? 'selected' : ''} key={id} onClick={() => setSection(id)}><i className={`bx ${id === 'users' ? 'bx-group' : id === 'audit' ? 'bx-file' : id === 'security' ? 'bx-shield' : id === 'backups' ? 'bx-data' : id === 'marketplace' ? 'bx-store' : id === 'market-admin' ? 'bx-cog' : id === 'provider' ? 'bx-briefcase' : id === 'bookings' ? 'bx-calendar' : id === 'support' ? 'bx-support' : id === 'profile' ? 'bx-user' : id === 'notifications' ? 'bx-bell' : 'bx-grid-alt'}`} />{label}</button>)}</nav>
      <div className="dashboard-sidebar-bottom"><div className="dashboard-avatar">{user.username?.slice(0, 1).toUpperCase()}</div><div className="dashboard-user"><strong>{user.username}</strong><small>{user.role}</small></div><button aria-label="Log out" title="Log out" onClick={onLogout}><i className="bx bx-log-out" /></button></div>
    </aside>
    <section className="dashboard-main"><header className="dashboard-header"><div><span className="dashboard-eyebrow">{roleLabels[user.role]}</span><h1>{section === 'users' ? 'User directory' : section === 'audit' ? 'Audit history' : section === 'security' ? 'Security settings' : section==='marketplace'?'Find home services':section==='provider'?(isCustomer?'Become a provider':'My services'):section==='bookings'?(isAdmin?'All bookings':'Bookings'):section==='market-admin'?'Marketplace management':section==='support'?'Support':section==='profile'?'My profile':section==='notifications'?'Notifications':`Welcome, ${user.username}`}</h1></div><div className="dashboard-header-user"><span className="dashboard-status-dot" /> Secure session</div></header>
      {notice && <div className="dashboard-notice" role="status">{notice}</div>}
      {section === 'overview' && <div className="dashboard-overview-grid">
        <div className="dashboard-overview-primary">
          <div className="dashboard-welcome"><div className="dashboard-welcome-copy"><span className="welcome-kicker">{isAdmin ? 'ADMINISTRATOR WORKSPACE' : 'YOUR SECURE WORKSPACE'}</span><h2>{isAdmin ? `Welcome back, ${user.username}` : `Good to see you, ${user.username}`}</h2><p>{isAdmin ? 'Your control center for account access, audit activity, and secure recovery.' : 'Your account is protected and ready. Review your security and keep your sign-in details up to date.'}</p><button className="welcome-action" onClick={() => setSection(isAdmin ? 'users' : 'security')}>{isAdmin ? 'Manage users' : 'Review security'}<i className="bx bx-right-arrow-alt" /></button></div><div className="welcome-art"><i className="bx bx-shield-quarter welcome-fallback-icon" /><img className="welcome-professional-image" src="/images/home-service-professional.png" alt="Plumber and electrician" onError={(event) => { event.currentTarget.hidden = true; }} /><span className="welcome-orbit orbit-one"/><span className="welcome-orbit orbit-two"/></div></div>
          <div className="dashboard-cards"><article><div className="stat-icon role-icon"><i className="bx bx-id-card" /></div><span>Account role</span><strong>{user.role}</strong><small>Role-based access is active</small></article><article><div className="stat-icon twofa-icon"><i className="bx bx-shield" /></div><span>Two-factor security</span><strong>{user.totp_enabled ? 'Protected' : 'Available'}</strong><small>{user.totp_enabled ? 'Authenticator enabled' : 'Add another layer of protection'}</small></article><article><div className="stat-icon hash-icon"><i className="bx bx-lock-alt" /></div><span>Password protection</span><strong>Argon2id</strong><small>Salted and peppered on the server</small></article></div>
          <div className="dashboard-panel profile-panel"><div className="panel-heading"><div><h3>Account details</h3><p>Your profile and access information</p></div><span className="profile-avatar-large">{user.username?.slice(0, 1).toUpperCase()}</span></div><div className="dashboard-details"><span>Full name</span><strong>{user.username}</strong><span>Email address</span><strong>{user.email}</strong><span>Account role</span><strong><span className="role-pill">{user.role}</span></strong></div></div>
        </div>
        <aside className="dashboard-overview-rail"><div className="rail-card security-summary"><div className="rail-card-heading"><span className="rail-icon"><i className="bx bx-shield-quarter" /></span><span className={`security-indicator ${user.totp_enabled ? 'is-secure' : ''}`}><i/> {user.totp_enabled ? 'Protected' : 'Action needed'}</span></div><h3>Account security</h3><p>{user.totp_enabled ? 'Two-factor authentication is enabled for this account.' : 'Turn on an authenticator to add a second sign-in check.'}</p><div className="security-progress"><span style={{width:user.totp_enabled?'100%':'68%'}}/></div><button className="rail-link" onClick={() => setSection('security')}>{user.totp_enabled ? 'View security settings' : 'Set up two-factor'}<i className="bx bx-chevron-right" /></button></div>
          <div className="rail-card session-summary"><span className="rail-label">SESSION STATUS</span><div className="session-state"><span className="dashboard-status-dot"/>Active and encrypted</div><p>Your sign-in is protected by a secure, httpOnly session.</p></div>
          <div className="rail-card access-summary"><span className="rail-label">YOUR ACCESS</span><h3>{roleLabels[user.role]}</h3><p>{user.role === 'admin' ? 'Manage user accounts, role assignments, backups, and security history.' : user.role === 'auditor' ? 'Review authentication and access events across the system.' : user.role === 'staff' ? 'Your staff workspace is active with role-based permissions.' : 'Your private account area is active and available.'}</p>{isAdmin && <div className="rail-metric"><strong>{users.length}</strong><span>accounts in directory</span></div>}{canAudit && <div className="rail-metric"><strong>{events.length}</strong><span>recent audit events</span></div>}</div>
        </aside>
      </div>}
      {section === 'users' && isAdmin && <div className="dashboard-panel"><div className="panel-heading"><div><h3>All accounts</h3><p>Credential metadata is restricted to administrators.</p></div><span className="count-pill">{users.length} accounts</span></div><div className="table-wrap"><table><thead><tr><th>Account</th><th>Role</th><th>Status</th><th>Hash algorithm</th><th>Password hash and salt</th><th>Actions</th></tr></thead><tbody>{users.map((item) => <tr key={item.id}><td><strong>{item.username}</strong><small>{item.email}</small></td><td><select value={item.role} disabled={Number(item.id) === Number(user.id)} onChange={(event) => updateRole(item.id, event.target.value)}>{['customer','provider','support_agent','staff','auditor','admin'].map((role) => <option key={role}>{role}</option>)}</select></td><td><span className={`account-status ${item.is_active ? 'active' : 'inactive'}`}>{item.is_active ? 'Active' : 'Inactive'}</span></td><td>Argon2id</td><td><details><summary>View credential metadata</summary><code>{item.password_hash}</code><small>Per-user salt: {item.password_salt || 'Legacy hash; embedded salt'}</small></details></td><td>{item.is_active && Number(item.id) !== Number(user.id) && <button className="danger-button" onClick={() => deactivate(item.id)}>Deactivate</button>}</td></tr>)}</tbody></table></div><p className="privacy-note">Passwords cannot be recovered or displayed. The server pepper is kept outside the database and is never exposed in this console.</p></div>}
      {section === 'audit' && canAudit && <div className="dashboard-panel"><div className="panel-heading"><div><h3>Security events</h3><p>Recent authentication and access changes</p></div><span className="count-pill">{events.length} events</span></div><div className="table-wrap"><table><thead><tr><th>Event</th><th>Actor</th><th>Target</th><th>Result</th><th>Time</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}><td><strong>{event.event_type}</strong><small>{event.metadata?.email || ''}</small></td><td>{event.actor_user_id || 'System'}</td><td>{event.target_user_id || '—'}</td><td><span className="account-status active">{event.outcome || 'success'}</span></td><td>{new Date(event.created_at).toLocaleString()}</td></tr>)}</tbody></table></div></div>}
      {section === 'backups' && isAdmin && <div className="dashboard-panel"><div className="panel-heading"><div><h3>Encrypted S3 database backups</h3><p>Manual backups are encrypted with AES-256-GCM, uploaded to your private S3 bucket, then downloaded and checked for size, SHA-256 integrity, decryption, and PostgreSQL archive validity.</p></div><div className="backup-actions"><button className="dashboard-primary" disabled={busy} onClick={createBackup}>{busy ? 'Working…' : 'Create backup now'}</button><button className="danger-button" disabled={busy} onClick={cleanupExpired}>Clean up expired</button></div></div><div className="table-wrap"><table><thead><tr><th>Backup</th><th>Created / expires</th><th>Database · files</th><th>Upload · verification</th><th>Size</th><th>Actions</th></tr></thead><tbody>{backups.map((backup) => <tr key={backup.backup_id}><td><code>{backup.backup_id}</code><small>SHA-256: {backup.checksum || '—'}</small></td><td>{new Date(backup.created_at).toLocaleString()}<small>Expires: {backup.expires_at ? new Date(backup.expires_at).toLocaleString() : 'Not set'}</small></td><td>{backup.status} · {backup.files_status || 'not_applicable'}</td><td>{backup.upload_status || '—'} · {backup.verification_status || 'pending'}</td><td>{backup.size_bytes ? `${(Number(backup.size_bytes) / 1024 / 1024).toFixed(2)} MB` : '—'}</td><td><button className="danger-button" disabled={busy || backup.status !== 'complete'} onClick={() => verifyBackup(backup.backup_id)}>Verify</button>{' '}<button className="danger-button" disabled={busy || backup.status !== 'complete'} onClick={() => previewRestore(backup.backup_id)}>Preview</button>{' '}<button className="danger-button" disabled={busy || backup.status !== 'complete' || !recoveryConfigured} title={recoveryConfigured ? 'Restore to configured isolated recovery database' : 'Configure separate RECOVERY_DATABASE_* first'} onClick={() => restoreBackup(backup.backup_id)}>Restore to recovery</button></td></tr>)}</tbody></table></div>{backupOperations.length > 0 && <div className="backup-operations"><h3>Recent operations</h3><div className="table-wrap"><table><thead><tr><th>Operation</th><th>Started</th><th>Status</th><th>Database / upload / verify</th><th>Details</th></tr></thead><tbody>{backupOperations.map((op) => <tr key={op.operation_id}><td><code>{op.operation_id}</code></td><td>{new Date(op.created_at).toLocaleString()}</td><td>{op.status}</td><td>{op.database_status} / {op.upload_status} / {op.verification_status}</td><td>{op.error_message || op.files_status}</td></tr>)}</tbody></table></div></div>}{preview && <div className="backup-preview"><h3>Preview: {preview.backupId}</h3><p>{preview.objectCount} database objects · {preview.sizeBytes ? `${(preview.sizeBytes / 1024 / 1024).toFixed(2)} MB` : ''}</p><ul>{preview.entries.map((entry) => <li key={entry}>{entry}</li>)}</ul></div>}<p className="privacy-note">Service images and file uploads are not backed up: this project currently has no Supabase Storage or file-upload integration. Restore runs only into the separately configured recovery database, never the active application database. Seven-day deletion is administrator-triggered; it is not automatic.</p></div>}
      {section === 'security' && <div className="dashboard-panel security-panel"><h3>Two-factor authentication</h3><p>Use an authenticator app to generate a time-based one-time password for sign-in.</p>{!totp ? <button className="dashboard-primary" disabled={busy || twoFactorEnabled} onClick={setup2fa}>{twoFactorEnabled ? 'Authenticator enabled' : 'Set up authenticator'}</button> : <><img className="totp-qr" src={totp.qrCodeDataUrl} alt="Authenticator setup QR code"/><p>Scan this QR code or enter the setup key in your authenticator app.</p><code className="totp-secret">{totp.secret}</code><form onSubmit={verify2fa}><input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" pattern="[0-9]{6}" placeholder="6-digit code" required/><button className="dashboard-primary" disabled={busy}>Verify and enable</button></form></>}</div>}
      {section === 'marketplace' && <Marketplace csrfToken={csrfToken} canBook={isCustomer} onRequestLogin={() => setNotice('Sign in with a customer account to request a booking.')} onNotice={setNotice}/>}
      {section === 'provider' && (isCustomer || user.role === 'provider') && <ProviderPanel user={user} csrfToken={csrfToken} onNotice={setNotice}/>}
      {section === 'bookings' && (isCustomer || user.role === 'provider' || isAdmin) && <BookingsPanel user={user} csrfToken={csrfToken} onNotice={setNotice}/>}
      {section === 'support' && <SupportPanel user={user} csrfToken={csrfToken} onNotice={setNotice}/>}
      {section === 'notifications' && <NotificationsPanel csrfToken={csrfToken}/>}
      {section === 'market-admin' && isAdmin && <AdminMarketplace csrfToken={csrfToken} onNotice={setNotice}/>}
      {section === 'profile' && <ProfilePanel user={user} csrfToken={csrfToken} onNotice={setNotice}/>}
      {section === 'overview' && <div className="dashboard-panel"><h3>Your access</h3><p>{user.role === 'user' ? 'Your private account area is active. Contact an administrator if you need a different access level.' : user.role === 'auditor' ? 'You have read-only access to security event history.' : user.role === 'staff' ? 'Your staff account is active with standard staff permissions.' : 'You have full administration tools, user management, and audit access.'}</p></div>}
    </section>
  </main>;
}
