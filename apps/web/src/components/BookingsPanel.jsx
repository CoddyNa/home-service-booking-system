import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../services/api';
import { csrfFetch } from '../services/csrf';

const labels = { PENDING: 'Awaiting provider', CONFIRMED: 'Confirmed', REJECTED: 'Declined', IN_PROGRESS: 'In progress', COMPLETED: 'Completed', CANCELLED: 'Cancelled' };

export default function BookingsPanel({ user, csrfToken, onNotice }) {
  const [bookings, setBookings] = useState([]);
  const [reviews, setReviews] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const customer = ['customer', 'user'].includes(user.role);
  const provider = user.role === 'provider';
  const load = useCallback(async () => {
    setLoading(true);
    try { const response = await apiFetch('/api/marketplace/bookings'); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not load bookings.'); setBookings(data.bookings || []); setError(''); }
    catch (e) { setError(e.message || 'Could not load bookings.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  async function changeStatus(booking, status) {
    setBusyId(booking.id);
    try {
      const response = await csrfFetch(`/api/marketplace/bookings/${booking.id}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ status }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not update booking.');
      onNotice?.(`Booking ${status.toLowerCase().replace('_',' ')}.`); await load();
    } catch (e) { onNotice?.(e.message || 'Could not update booking.'); }
    finally { setBusyId(null); }
  }

  async function submitReview(event, booking) {
    event.preventDefault(); setBusyId(booking.id);
    try {
      const response = await csrfFetch(`/api/marketplace/bookings/${booking.id}/reviews`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(reviews[booking.id] || { rating: 5, comment: '' }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not submit review.');
      onNotice?.('Thanks, your review has been submitted.'); await load();
    } catch (e) { onNotice?.(e.message || 'Could not submit review.'); }
    finally { setBusyId(null); }
  }

  if (loading) return <div className="marketplace-empty"><i className="bx bx-loader-alt bx-spin"/><strong>Loading bookings</strong></div>;
  return <section className="marketplace-view"><div className="marketplace-section-heading"><div><span className="dashboard-eyebrow">{provider ? 'PROVIDER WORKSPACE' : 'BOOKING HISTORY'}</span><h2>{provider ? 'Incoming requests' : 'Your bookings'}</h2><p>{provider ? 'Review requests and update each job as it progresses.' : 'Track provider responses and review your completed services.'}</p></div><button className="market-refresh" aria-label="Refresh bookings" onClick={() => void load()}><i className="bx bx-refresh"/></button></div>
    {error && <div className="dashboard-notice" role="alert">{error}</div>}
    {!bookings.length ? <div className="marketplace-empty"><i className="bx bx-calendar"/><strong>No bookings yet</strong><span>{provider ? 'New customer requests will appear here.' : 'Once you request a service, you can follow its status here.'}</span></div> : <div className="booking-list">{bookings.map((booking) => <article className="booking-card" key={booking.id}><div className="booking-card-head"><div><span className="service-category-label">{booking.category}</span><h3>{booking.service_title}</h3><p>{provider ? `Customer: ${booking.customer_name}` : `Provider: ${booking.provider_name || booking.provider_username}`}</p></div><span className={`booking-status status-${booking.status.toLowerCase()}`}>{labels[booking.status] || booking.status}</span></div><div className="booking-card-meta"><span><i className="bx bx-calendar"/>{new Date(booking.requested_at).toLocaleString()}</span><span><i className="bx bx-wallet"/>{Number(booking.agreed_price).toFixed(2)}</span></div>{booking.description && <p className="booking-description">{booking.description}</p>}
      {booking.status === 'PENDING' && provider && <div className="booking-actions"><button className="dashboard-primary" disabled={busyId===booking.id} onClick={() => changeStatus(booking,'CONFIRMED')}>Accept request</button><button className="danger-button" disabled={busyId===booking.id} onClick={() => changeStatus(booking,'REJECTED')}>Decline</button></div>}
      {booking.status === 'CONFIRMED' && provider && <div className="booking-actions"><button className="dashboard-primary" disabled={busyId===booking.id} onClick={() => changeStatus(booking,'IN_PROGRESS')}>Start service</button></div>}
      {booking.status === 'IN_PROGRESS' && provider && <div className="booking-actions"><button className="dashboard-primary" disabled={busyId===booking.id} onClick={() => changeStatus(booking,'COMPLETED')}>Mark completed</button></div>}
      {customer && ['PENDING','CONFIRMED'].includes(booking.status) && <div className="booking-actions"><button className="danger-button" disabled={busyId===booking.id} onClick={() => changeStatus(booking,'CANCELLED')}>Cancel booking</button></div>}
      {customer && booking.status==='COMPLETED' && !booking.has_review && <form className="review-form" onSubmit={(event)=>submitReview(event,booking)}><label>Rate your experience<select value={reviews[booking.id]?.rating || '5'} onChange={(event)=>setReviews({...reviews,[booking.id]:{...reviews[booking.id],rating:Number(event.target.value),comment:reviews[booking.id]?.comment||''}})}>{[5,4,3,2,1].map((rating)=><option key={rating} value={rating}>{rating} star{rating>1?'s':''}</option>)}</select></label><input maxLength="1500" placeholder="Share a short review (optional)" value={reviews[booking.id]?.comment||''} onChange={(event)=>setReviews({...reviews,[booking.id]:{rating:Number(reviews[booking.id]?.rating||5),comment:event.target.value}})}/><button className="dashboard-primary" disabled={busyId===booking.id}>Submit review</button></form>}
    </article>)}</div>}
  </section>;
}
