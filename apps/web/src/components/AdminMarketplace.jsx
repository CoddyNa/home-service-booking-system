import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../services/api';
import { csrfFetch } from '../services/csrf';

const tabs = [['applications','Provider applications'],['providers','Provider profiles'],['listings','Service listings'],['reviews','Reviews'],['categories','Categories']];

export default function AdminMarketplace({ csrfToken, onNotice }) {
  const [tab,setTab]=useState('applications');
  const [applications,setApplications]=useState([]);
  const [providers,setProviders]=useState([]);
  const [listings,setListings]=useState([]);
  const [reviews,setReviews]=useState([]);
  const [categories,setCategories]=useState([]);
  const [category,setCategory]=useState({name:'',slug:'',description:''});
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const load=useCallback(async()=>{
    setError('');
    try {
      const [applicationResponse,providerResponse,listingResponse,reviewResponse,categoryResponse]=await Promise.all([
        apiFetch('/api/marketplace/admin/provider-applications'),
        apiFetch('/api/marketplace/admin/providers'),
        apiFetch('/api/marketplace/admin/services'),
        apiFetch('/api/marketplace/admin/reviews'),
        apiFetch('/api/marketplace/admin/categories'),
      ]);
      const [appData,providerData,listingData,reviewData,categoryData]=await Promise.all([applicationResponse.json(),providerResponse.json(),listingResponse.json(),reviewResponse.json(),categoryResponse.json()]);
      if(!applicationResponse.ok||!providerResponse.ok||!listingResponse.ok||!reviewResponse.ok||!categoryResponse.ok)throw new Error(appData.error||providerData.error||listingData.error||reviewData.error||categoryData.error||'Could not load marketplace management data.');
      setApplications(appData.applications||[]);setProviders(providerData.providers||[]);setListings(listingData.services||[]);setReviews(reviewData.reviews||[]);setCategories(categoryData.categories||[]);
    } catch(e){setError(e.message||'Could not load admin marketplace data.');}
  },[]);
  useEffect(()=>{queueMicrotask(()=>{void load();});},[load]);
  async function reviewApplication(application,status){
    setBusy(true);
    try{const response=await csrfFetch(`/api/marketplace/admin/provider-applications/${application.id}`,{method:'PATCH',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({status})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not update application.');onNotice?.(data.message);await load();}
    catch(e){onNotice?.(e.message||'Could not update application.');}finally{setBusy(false);}
  }
  async function reviewListing(listing,status){
    setBusy(true);
    try{const response=await csrfFetch(`/api/marketplace/admin/services/${listing.id}/review`,{method:'PATCH',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({status})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not update listing.');onNotice?.(data.message);await load();}
    catch(e){onNotice?.(e.message||'Could not update listing.');}finally{setBusy(false);}
  }
  async function createCategory(event){
    event.preventDefault();setBusy(true);
    try{const response=await csrfFetch('/api/marketplace/admin/categories',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify(category)});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not create category.');setCategory({name:'',slug:'',description:''});onNotice?.('Category added.');await load();}
    catch(e){onNotice?.(e.message||'Could not create category.');}finally{setBusy(false);}
  }
  async function toggleCategory(item){
    setBusy(true);
    try{const response=await csrfFetch(`/api/marketplace/admin/categories/${item.id}`,{method:'PATCH',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({name:item.name,description:item.description,isActive:!item.is_active})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not update category.');await load();}
    catch(e){onNotice?.(e.message||'Could not update category.');}finally{setBusy(false);}
  }
  async function moderateReview(review,status){
    setBusy(true);
    try{const response=await csrfFetch(`/api/marketplace/admin/reviews/${review.id}`,{method:'PATCH',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({status})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not moderate review.');onNotice?.(data.message);await load();}
    catch(e){onNotice?.(e.message||'Could not moderate review.');}finally{setBusy(false);}
  }
  async function updateProvider(provider,status){
    setBusy(true);
    try{const response=await csrfFetch(`/api/marketplace/admin/providers/${provider.user_id}/status`,{method:'PATCH',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({status})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not update provider status.');onNotice?.(data.message);await load();}
    catch(e){onNotice?.(e.message||'Could not update provider status.');}finally{setBusy(false);}
  }
  return <section className="marketplace-view"><div className="marketplace-section-heading"><div><span className="dashboard-eyebrow">ADMINISTRATION</span><h2>Marketplace management</h2><p>Review provider access, moderate service listings, and manage categories.</p></div><button className="market-refresh" onClick={()=>void load()} aria-label="Refresh"><i className="bx bx-refresh"/></button></div><div className="admin-market-tabs">{tabs.map(([id,label])=><button key={id} className={tab===id?'active':''} onClick={()=>setTab(id)}>{label}<span>{id==='applications'?applications.filter(a=>a.status==='pending').length:id==='listings'?listings.filter(s=>s.approval_status==='pending').length:id==='reviews'?reviews.length:categories.length}</span></button>)}</div>{error&&<div className="dashboard-notice" role="alert">{error}</div>}
    {tab==='applications'&&<div className="dashboard-panel admin-list-panel"><div className="panel-heading"><div><h3>Provider applications</h3><p>Only approved providers can publish services.</p></div></div>{applications.length?<div className="admin-card-list">{applications.map((application)=><article className="admin-review-card" key={application.id}><div className="admin-review-head"><div><h3>{application.business_name}</h3><p>{application.username} · {application.email}</p></div><span className={`booking-status status-${application.status}`}>{application.status}</span></div><p className="admin-review-bio">{application.bio}</p><div className="admin-review-meta"><span>{application.years_experience} years' experience</span><span>{application.service_area?.join(', ')||'No areas supplied'}</span><span>Submitted {new Date(application.created_at).toLocaleDateString()}</span></div>{application.status==='pending'&&<div className="booking-actions"><button className="dashboard-primary" disabled={busy} onClick={()=>reviewApplication(application,'approved')}>Approve provider</button><button className="danger-button" disabled={busy} onClick={()=>reviewApplication(application,'rejected')}>Reject application</button></div>}</article>)}</div>:<div className="marketplace-empty"><i className="bx bx-user-check"/><strong>No applications yet</strong><span>Provider applications will appear here.</span></div>}</div>}
    {tab==='providers'&&<div className="dashboard-panel admin-list-panel"><div className="panel-heading"><div><h3>Provider profiles</h3><p>Approve profile changes or suspend marketplace access.</p></div></div>{providers.length?<div className="admin-card-list">{providers.map(provider=><article className="admin-review-card" key={provider.user_id}><div className="admin-review-head"><div><h3>{provider.business_name}</h3><p>{provider.username} · {provider.email}</p></div><span className={`booking-status status-${provider.approval_status}`}>{provider.approval_status}</span></div><p className="admin-review-bio">{provider.bio}</p><div className="admin-review-meta"><span>{provider.years_experience} years' experience</span><span>{provider.service_area?.join(', ')||'No areas supplied'}</span></div><div className="booking-actions">{provider.approval_status!=='approved'&&<button className="dashboard-primary" disabled={busy} onClick={()=>updateProvider(provider,'approved')}>Approve profile</button>}{provider.approval_status!=='suspended'&&<button className="danger-button" disabled={busy} onClick={()=>updateProvider(provider,'suspended')}>Suspend provider</button>}{provider.approval_status==='suspended'&&<button className="dashboard-primary" disabled={busy} onClick={()=>updateProvider(provider,'approved')}>Restore provider</button>}</div></article>)}</div>:<div className="marketplace-empty"><i className="bx bx-briefcase"/><strong>No provider profiles</strong><span>Approved applications will appear here.</span></div>}</div>}
    {tab==='listings'&&<div className="dashboard-panel admin-list-panel"><div className="panel-heading"><div><h3>Service listings</h3><p>Approve listings before customers can discover them.</p></div></div>{listings.length?<div className="admin-card-list">{listings.map((listing)=><article className="admin-review-card" key={listing.id}><div className="admin-review-head"><div><h3>{listing.title}</h3><p>{listing.category} · {listing.business_name} ({listing.username})</p></div><span className={`booking-status status-${listing.approval_status}`}>{listing.approval_status}</span></div><p className="admin-review-bio">{listing.description}</p><div className="admin-review-meta"><span>Starting at {Number(listing.base_price).toFixed(2)} {listing.price_unit}</span><span>{listing.service_area?.join(', ')||'All provider service areas'}</span><span>Submitted {new Date(listing.created_at).toLocaleDateString()}</span></div>{listing.approval_status==='pending'&&<div className="booking-actions"><button className="dashboard-primary" disabled={busy} onClick={()=>reviewListing(listing,'approved')}>Approve listing</button><button className="danger-button" disabled={busy} onClick={()=>reviewListing(listing,'rejected')}>Reject listing</button></div>}</article>)}</div>:<div className="marketplace-empty"><i className="bx bx-store"/><strong>No listings yet</strong><span>Submitted provider services will appear here.</span></div>}</div>}
    {tab==='reviews'&&<div className="dashboard-panel admin-list-panel"><div className="panel-heading"><div><h3>Customer reviews</h3><p>Hide inappropriate reviews while preserving the moderation record.</p></div></div>{reviews.length?<div className="admin-card-list">{reviews.map(review=><article className="admin-review-card" key={review.id}><div className="admin-review-head"><div><h3>{review.business_name||review.provider_username} <span className="review-stars">★ {review.rating}/5</span></h3><p>By {review.customer_name} · Booking #{review.booking_id}</p></div><span className={`booking-status status-${review.moderation_status}`}>{review.moderation_status}</span></div><p className="admin-review-bio">{review.comment||'No written comment.'}</p>{review.moderation_status==='visible'?<button className="danger-button" disabled={busy} onClick={()=>moderateReview(review,'hidden')}>Hide review</button>:<button className="dashboard-primary" disabled={busy} onClick={()=>moderateReview(review,'visible')}>Restore review</button>}</article>)}</div>:<div className="marketplace-empty"><i className="bx bx-star"/><strong>No reviews yet</strong><span>Reviews for completed bookings will appear here.</span></div>}</div>}
    {tab==='categories'&&<><form className="market-form-card" onSubmit={createCategory}><h3>Add a service category</h3><div className="market-form-row"><label>Name<input required maxLength="80" value={category.name} onChange={e=>setCategory({...category,name:e.target.value})}/></label><label>URL slug<input required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength="80" placeholder="air-conditioning" value={category.slug} onChange={e=>setCategory({...category,slug:e.target.value})}/></label></div><label>Description<input maxLength="500" value={category.description} onChange={e=>setCategory({...category,description:e.target.value})}/></label><button className="dashboard-primary" disabled={busy}>Add category</button></form><div className="category-admin-list">{categories.map(item=><article key={item.id}><div><strong>{item.name}</strong><small>/{item.slug} · {item.description}</small></div><button className={item.is_active?'category-toggle active':'category-toggle'} disabled={busy} onClick={()=>void toggleCategory(item)}>{item.is_active?'Active':'Inactive'}</button></article>)}</div></>}
  </section>;
}
