import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../services/api';
import { csrfFetch } from '../services/csrf';

const serviceIcons = { Plumbing: 'bx-water', Electrical: 'bx-bulb', Cleaning: 'bx-broom', Painting: 'bx-paint', Carpentry: 'bx-hammer', 'Appliance repair': 'bx-wrench', Gardening: 'bx-leaf', 'Air conditioning': 'bx-wind' };
const bookingMinDateTime = new Date(Date.now() + 3600000).toISOString().slice(0, 16);

export default function Marketplace({ csrfToken, canBook = false, onRequestLogin, onNotice }) {
  const [categories, setCategories] = useState([]);
  const [services, setServices] = useState([]);
  const [filters, setFilters] = useState({ q: '', category: '', location: '', minPrice: '', maxPrice: '' });
  const [appliedFilters, setAppliedFilters] = useState({ q: '', category: '', location: '', minPrice: '', maxPrice: '' });
  const [selected, setSelected] = useState(null);
  const [bookingTime, setBookingTime] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const query = new URLSearchParams(Object.entries(appliedFilters).filter(([, value]) => value !== ''));
      const [categoryResponse, serviceResponse] = await Promise.all([
        apiFetch('/api/marketplace/categories'),
        apiFetch(`/api/marketplace/services?${query.toString()}`),
      ]);
      const [categoryData, serviceData] = await Promise.all([categoryResponse.json(), serviceResponse.json()]);
      if (!categoryResponse.ok || !serviceResponse.ok) throw new Error(serviceData.error || 'Marketplace is unavailable right now.');
      setCategories(categoryData.categories || []); setServices(serviceData.services || []);
    } catch (e) { setError(e.message || 'Could not load services.'); }
    finally { setLoading(false); }
  }, [appliedFilters]);
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  async function bookService(event) {
    event.preventDefault();
    if (!canBook) { onRequestLogin?.(); return; }
    setBusy(true);
    try {
      const response = await csrfFetch('/api/marketplace/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ serviceId: selected.id, requestedAt: new Date(bookingTime).toISOString(), description }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not request this booking.');
      setSelected(null); setBookingTime(''); setDescription(''); onNotice?.(data.message || 'Booking request sent.');
    } catch (e) { onNotice?.(e.message || 'Could not request this booking.'); }
    finally { setBusy(false); }
  }

  return <section className="marketplace-view">
    <div className="marketplace-intro"><div><span className="dashboard-eyebrow">TRUSTED HOME PROFESSIONALS</span><h2>Find help for your home</h2><p>Browse approved providers, compare services, and request a time that works for you.</p></div><span className="marketplace-intro-icon"><i className="bx bx-home-heart" /></span></div>
    <form className="marketplace-filters" onSubmit={(event) => { event.preventDefault(); setAppliedFilters(filters); }}>
      <label className="market-search"><i className="bx bx-search"/><input aria-label="Search services" placeholder="What do you need help with?" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })}/></label>
      <select aria-label="Service category" value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}><option value="">All categories</option>{categories.map((category) => <option key={category.id} value={category.slug}>{category.name}</option>)}</select>
      <input aria-label="Location" placeholder="Area or city" value={filters.location} onChange={(e) => setFilters({ ...filters, location: e.target.value })}/>
      <input aria-label="Minimum price" type="number" min="0" step="0.01" placeholder="Min price" value={filters.minPrice} onChange={(e) => setFilters({ ...filters, minPrice: e.target.value })}/>
      <input aria-label="Maximum price" type="number" min="0" step="0.01" placeholder="Max price" value={filters.maxPrice} onChange={(e) => setFilters({ ...filters, maxPrice: e.target.value })}/>
      <button className="dashboard-primary" type="submit">Search services</button>
    </form>
    <div className="marketplace-category-row"><span>Browse by category</span><div>{categories.slice(0, 8).map((category) => <button type="button" className={filters.category === category.slug ? 'category-chip active' : 'category-chip'} key={category.id} onClick={() => { const next={...filters,category:filters.category===category.slug?'':category.slug};setFilters(next);setAppliedFilters(next); }}><i className={`bx ${serviceIcons[category.name] || 'bx-wrench'}`}/>{category.name}</button>)}</div></div>
    <div className="marketplace-results-heading"><div><h3>Available services</h3><p>{loading ? 'Finding approved providers…' : `${services.length} services found`}</p></div><button className="market-refresh" onClick={() => setAppliedFilters(filters)} aria-label="Refresh services"><i className="bx bx-refresh"/></button></div>
    {error && <div className="dashboard-notice" role="alert">{error}</div>}
    {loading ? <div className="marketplace-empty"><i className="bx bx-loader-alt bx-spin"/><strong>Loading trusted services</strong><span>We’re finding the right professionals for you.</span></div> : services.length ? <div className="service-grid">{services.map((service) => <article className="service-card" key={service.id}><div className="service-card-art"><span className="service-icon"><i className={`bx ${serviceIcons[service.category] || 'bx-wrench'}`}/></span><span className="service-rating"><i className="bx bxs-star"/> {Number(service.rating).toFixed(1)} <small>({service.review_count})</small></span></div><div className="service-card-body"><span className="service-category-label">{service.category}</span><h4>{service.title}</h4><p>{service.description}</p><div className="service-provider"><span className="provider-avatar">{service.provider_name?.slice(0,1).toUpperCase()}</span><div><strong>{service.provider_name}</strong><small>{service.service_area?.length ? service.service_area.join(', ') : 'Service area available on request'}</small></div></div><div className="service-card-footer"><span><small>Starting from</small><strong>{Number(service.base_price).toFixed(2)} <small>{service.price_unit}</small></strong></span><button className="service-book-button" onClick={() => { if (canBook) setSelected(service); else onRequestLogin?.(); }}>{canBook ? 'Request' : 'Sign in to book'}<i className="bx bx-right-arrow-alt"/></button></div></div></article>)}</div> : <div className="marketplace-empty"><i className="bx bx-search-alt"/><strong>No services found</strong><span>Try another category or location, or check back soon as providers join.</span></div>}
    {selected && <div className="booking-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}><section className="booking-modal" role="dialog" aria-modal="true" aria-labelledby="booking-title"><button className="modal-close" onClick={() => setSelected(null)} aria-label="Close booking form"><i className="bx bx-x"/></button><span className="service-category-label">{selected.category}</span><h2 id="booking-title">Request {selected.title}</h2><p>{selected.provider_name} · Starting from {Number(selected.base_price).toFixed(2)} {selected.price_unit}</p><form onSubmit={bookService}><label>Preferred date and time<input type="datetime-local" min={bookingMinDateTime} value={bookingTime} onChange={(e) => setBookingTime(e.target.value)} required/></label><label>Tell the provider what you need<textarea rows="4" maxLength="2000" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe the issue or work needed"/></label><button className="dashboard-primary" disabled={busy}>{busy ? 'Sending request…' : 'Send booking request'}</button></form></section></div>}
  </section>;
}
