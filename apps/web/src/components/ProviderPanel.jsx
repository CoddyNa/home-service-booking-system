import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../services/api';
import { csrfFetch } from '../services/csrf';

export default function ProviderPanel({ user, csrfToken, onNotice }) {
  const [categories, setCategories] = useState([]);
  const [services, setServices] = useState([]);
  const [application, setApplication] = useState(null);
  const [profile, setProfile] = useState({ businessName: '', bio: '', phone: '', serviceArea: '', yearsExperience: '0' });
  const [listing, setListing] = useState({ categoryId: '', title: '', description: '', basePrice: '', priceUnit: 'per job', serviceArea: '' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const provider = user.role === 'provider';
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const requests = [
        apiFetch('/api/marketplace/categories'),
        apiFetch(provider ? '/api/marketplace/provider/services' : '/api/marketplace/provider/applications/me'),
      ];
      if (provider) requests.push(apiFetch('/api/marketplace/profile'));
      const responses = await Promise.all(requests);
      const [catRes,dataRes,profileRes]=responses;
      const [catData, data, profileData] = await Promise.all([catRes.json(), dataRes.json(), profileRes ? profileRes.json() : null]);
      if (!catRes.ok || !dataRes.ok) throw new Error(data.error || catData.error || 'Could not load provider information.');
      setCategories(catData.categories || []);
      if (provider) { setServices(data.services || []); if(profileRes?.ok&&profileData?.profile)setProfile({businessName:profileData.profile.business_name||'',bio:profileData.profile.bio||'',phone:profileData.profile.phone||'',serviceArea:(profileData.profile.service_area||[]).join(', '),yearsExperience:String(profileData.profile.years_experience||0),username:profileData.profile.username||user.username}); }
      else setApplication(data.application);
    } catch (e) { setError(e.message || 'Could not load provider information.'); }
    finally { setLoading(false); }
  }, [provider, user.username]);
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  async function submitApplication(event) {
    event.preventDefault(); setBusy(true);
    try {
      const response = await csrfFetch('/api/marketplace/provider/applications', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ ...profile, serviceArea: profile.serviceArea.split(',').map((area) => area.trim()).filter(Boolean), yearsExperience: Number(profile.yearsExperience) }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not submit your application.');
      setApplication(data.application); onNotice?.('Provider application submitted for review.');
    } catch (e) { onNotice?.(e.message || 'Could not submit your application.'); }
    finally { setBusy(false); }
  }

  async function submitListing(event) {
    event.preventDefault(); setBusy(true);
    try {
      const response = await csrfFetch('/api/marketplace/provider/services', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ ...listing, categoryId: Number(listing.categoryId), basePrice: Number(listing.basePrice), serviceArea: listing.serviceArea.split(',').map((area) => area.trim()).filter(Boolean) }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not create listing.');
      setListing({ categoryId: '', title: '', description: '', basePrice: '', priceUnit: 'per job', serviceArea: '' }); onNotice?.(data.message); await load();
    } catch (e) { onNotice?.(e.message || 'Could not create listing.'); }
    finally { setBusy(false); }
  }

  async function saveProviderProfile(event) {
    event.preventDefault();setBusy(true);
    try { const response=await csrfFetch('/api/marketplace/profile',{method:'PATCH',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({...profile,username:profile.username||user.username,serviceArea:profile.serviceArea.split(',').map((area)=>area.trim()).filter(Boolean),yearsExperience:Number(profile.yearsExperience)})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not update provider profile.');onNotice?.('Profile updated and queued for review.');await load(); }
    catch(e){onNotice?.(e.message||'Could not update provider profile.');}finally{setBusy(false);}
  }

  if (loading) return <div className="marketplace-empty"><i className="bx bx-loader-alt bx-spin"/><strong>Loading provider workspace</strong></div>;
  if (!provider) return <section className="marketplace-view"><div className="marketplace-section-heading"><div><span className="dashboard-eyebrow">PROVIDER PROGRAM</span><h2>Offer your home services</h2><p>Apply to join the marketplace. Our team reviews provider profiles before listings go public.</p></div></div>{application ? <div className="application-status-card"><span className={`booking-status status-${application.status}`}>{application.status}</span><h3>{application.business_name}</h3><p>{application.status==='pending'?'Your application is waiting for administrator review.':'Application updated '+new Date(application.reviewed_at || application.created_at).toLocaleDateString()}</p>{application.status==='rejected' && <p>You can submit a new application after updating your details.</p>}</div> : null}{(!application || application.status==='rejected') && <form className="market-form-card" onSubmit={submitApplication}><h3>Provider application</h3><label>Business or trading name<input required maxLength="120" value={profile.businessName} onChange={(e)=>setProfile({...profile,businessName:e.target.value})}/></label><label>Tell us about your experience<textarea required minLength="10" maxLength="2000" rows="4" value={profile.bio} onChange={(e)=>setProfile({...profile,bio:e.target.value})}/></label><div className="market-form-row"><label>Service areas (comma separated)<input placeholder="City, neighborhood" value={profile.serviceArea} onChange={(e)=>setProfile({...profile,serviceArea:e.target.value})}/></label><label>Years of experience<input type="number" min="0" max="80" value={profile.yearsExperience} onChange={(e)=>setProfile({...profile,yearsExperience:e.target.value})}/></label></div><button className="dashboard-primary" disabled={busy}>{busy?'Submitting…':'Submit for review'}</button></form>}</section>;

  return <section className="marketplace-view"><div className="marketplace-section-heading"><div><span className="dashboard-eyebrow">PROVIDER WORKSPACE</span><h2>Your service listings</h2><p>New listings are reviewed before they appear in customer search results.</p></div></div>
    <form className="market-form-card" onSubmit={saveProviderProfile}><h3>Public provider profile</h3><p className="form-help-text">Profile edits are reviewed before your services return to public search.</p><div className="market-form-row"><label>Business name<input required maxLength="120" value={profile.businessName} onChange={(e)=>setProfile({...profile,businessName:e.target.value})}/></label><label>Phone<input maxLength="40" value={profile.phone} onChange={(e)=>setProfile({...profile,phone:e.target.value})}/></label></div><label>Business description<textarea required minLength="10" maxLength="2000" rows="3" value={profile.bio} onChange={(e)=>setProfile({...profile,bio:e.target.value})}/></label><div className="market-form-row"><label>Service areas (comma separated)<input value={profile.serviceArea} onChange={(e)=>setProfile({...profile,serviceArea:e.target.value})}/></label><label>Years of experience<input type="number" min="0" max="80" value={profile.yearsExperience} onChange={(e)=>setProfile({...profile,yearsExperience:e.target.value})}/></label></div><button className="dashboard-primary" disabled={busy}>{busy?'Saving…':'Save profile for review'}</button></form>
    <form className="market-form-card" onSubmit={submitListing}><h3>Create a service listing</h3><div className="market-form-row"><label>Category<select required value={listing.categoryId} onChange={(e)=>setListing({...listing,categoryId:e.target.value})}><option value="">Choose category</option>{categories.map((c)=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>Service title<input required maxLength="140" value={listing.title} onChange={(e)=>setListing({...listing,title:e.target.value})}/></label></div><label>Description<textarea required minLength="10" maxLength="4000" rows="4" value={listing.description} onChange={(e)=>setListing({...listing,description:e.target.value})}/></label><div className="market-form-row"><label>Starting price<input required type="number" min="0.01" step="0.01" value={listing.basePrice} onChange={(e)=>setListing({...listing,basePrice:e.target.value})}/></label><label>Price unit<input required maxLength="40" value={listing.priceUnit} onChange={(e)=>setListing({...listing,priceUnit:e.target.value})}/></label><label>Service areas<input placeholder="City, neighborhood" value={listing.serviceArea} onChange={(e)=>setListing({...listing,serviceArea:e.target.value})}/></label></div><button className="dashboard-primary" disabled={busy}>{busy?'Submitting…':'Submit listing for approval'}</button></form>
    {error && <div className="dashboard-notice" role="alert">{error}</div>}<div className="provider-listings">{services.map((service)=><article className="provider-listing" key={service.id}><div><span className={`booking-status status-${service.approval_status}`}>{service.approval_status}</span><h3>{service.title}</h3><p>{service.category} · {Number(service.base_price).toFixed(2)} {service.price_unit}</p></div><span className={`account-status ${service.is_active?'active':'inactive'}`}>{service.is_active?'Active':'Paused'}</span></article>)}{!services.length && <div className="marketplace-empty"><i className="bx bx-store"/><strong>No service listings yet</strong><span>Create your first listing above.</span></div>}</div>
  </section>;
}
