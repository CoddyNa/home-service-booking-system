import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../services/api';
import { csrfFetch } from '../services/csrf';

export default function SupportPanel({ user, csrfToken, onNotice }) {
  const [tickets, setTickets] = useState([]);
  const [agents, setAgents] = useState([]);
  const [agentId, setAgentId] = useState('');
  const [active, setActive] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState({ category: 'General', subject: '', message: '', priority: 'normal' });
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const supportStaff = ['support_agent','admin'].includes(user.role);
  const load = useCallback(async () => {
    setLoading(true);
    try { const response = await apiFetch('/api/marketplace/support/tickets'); const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Could not load support tickets.'); setTickets(data.tickets || []); if(user.role==='admin'){const agentResponse=await apiFetch('/api/marketplace/admin/support-agents');const agentData=await agentResponse.json();if(agentResponse.ok)setAgents(agentData.agents||[]);} setError(''); }
    catch (e) { setError(e.message || 'Could not load support tickets.'); }
    finally { setLoading(false); }
  }, [user.role]);
  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  async function createTicket(event) {
    event.preventDefault(); setBusy(true);
    try { const response = await csrfFetch('/api/marketplace/support/tickets', { method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify(draft) }); const data=await response.json(); if(!response.ok) throw new Error(data.error||'Could not create ticket.'); setDraft({category:'General',subject:'',message:'',priority:'normal'}); onNotice?.('Support ticket created.'); await load(); await openTicket(data.ticket.id); }
    catch(e){onNotice?.(e.message||'Could not create ticket.');} finally{setBusy(false);}
  }
  async function openTicket(ticketId) {
    try { const response=await apiFetch(`/api/marketplace/support/tickets/${ticketId}`); const data=await response.json(); if(!response.ok) throw new Error(data.error||'Could not open ticket.'); setActive(data.ticket); setMessages(data.messages||[]); setInternal(false); }
    catch(e){onNotice?.(e.message||'Could not open ticket.');}
  }
  async function sendReply(event) {
    event.preventDefault(); if(!active)return; setBusy(true);
    try { const response=await csrfFetch(`/api/marketplace/support/tickets/${active.id}/replies`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({message:reply,internal:supportStaff&&internal})}); const data=await response.json(); if(!response.ok) throw new Error(data.error||'Could not add reply.'); setReply(''); await openTicket(active.id); await load(); }
    catch(e){onNotice?.(e.message||'Could not add reply.');} finally{setBusy(false);}
  }
  async function updateTicket(event) {
    const [status,priority]=event.target.value.split('|'); if(!active)return;
    try { const response=await csrfFetch(`/api/marketplace/support/tickets/${active.id}`,{method:'PATCH',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({status,priority})}); const data=await response.json(); if(!response.ok) throw new Error(data.error||'Could not update ticket.'); setActive(data.ticket); await load(); }
    catch(e){onNotice?.(e.message||'Could not update ticket.');}
  }
  async function assignTicket() {
    if(!active)return;
    try { const response=await csrfFetch(`/api/marketplace/support/tickets/${active.id}/assign`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({agentId:user.role==='support_agent'?user.id:Number(agentId)})}); const data=await response.json(); if(!response.ok) throw new Error(data.error||'Could not assign ticket.'); onNotice?.(data.message); await load(); await openTicket(active.id); }
    catch(e){onNotice?.(e.message||'Could not assign ticket.');}
  }

  if(loading)return <div className="marketplace-empty"><i className="bx bx-loader-alt bx-spin"/><strong>Loading support desk</strong></div>;
  return <section className="marketplace-view"><div className="marketplace-section-heading"><div><span className="dashboard-eyebrow">{supportStaff?'CUSTOMER CARE':'WE ARE HERE TO HELP'}</span><h2>{supportStaff?'Support desk':'Support tickets'}</h2><p>{supportStaff?'Review your assigned cases and respond to customers.':'Create a ticket and follow the conversation with our support team.'}</p></div></div>{error&&<div className="dashboard-notice" role="alert">{error}</div>}
    <div className="support-layout"><div className="support-ticket-list"><div className="support-list-heading"><h3>{supportStaff?'Assigned tickets':'Your conversations'}</h3><span>{tickets.length}</span></div>{tickets.map((ticket)=><button key={ticket.id} className={`support-ticket-row ${active?.id===ticket.id?'active':''}`} onClick={()=>void openTicket(ticket.id)}><span className={`ticket-status ticket-${ticket.status}`}/><span className="ticket-row-copy"><strong>{ticket.subject}</strong><small>#{ticket.id} · {ticket.category}</small></span><span className="ticket-priority">{ticket.priority}</span></button>)}{!tickets.length&&<div className="support-list-empty">No tickets to show.</div>}</div>
      {active?<div className="support-thread"><div className="support-thread-head"><div><span className={`booking-status status-${active.status}`}>{active.status.replace('_',' ')}</span><h3>{active.subject}</h3><small>Ticket #{active.id} · {active.category} · {active.priority}</small></div>{supportStaff&&<div className="ticket-controls">{user.role==='admin'&&!active.assigned_agent_id&&<><select aria-label="Choose support agent" value={agentId} onChange={e=>setAgentId(e.target.value)}><option value="">Assign to agent</option>{agents.map(agent=><option key={agent.id} value={agent.id}>{agent.username}</option>)}</select><button className="dashboard-primary" disabled={!agentId} onClick={()=>void assignTicket()}>Assign ticket</button></>}<select aria-label="Update ticket status" value={`${active.status}|${active.priority}`} onChange={updateTicket}>{['open','in_progress','waiting','resolved','closed'].map(status=><option key={status} value={`${status}|${active.priority}`}>{status.replace('_',' ')}</option>)}</select>{user.role==='support_agent'&&!active.assigned_agent_id&&<button className="dashboard-primary" onClick={assignTicket}>Claim ticket</button>}</div>}</div><div className="support-messages">{messages.map((message)=><article className={`support-message ${message.sender_id===user.id?'own':''} ${message.is_internal?'internal':''}`} key={message.id}><div><strong>{message.sender_name}{message.is_internal?' · Internal note':''}</strong><time>{new Date(message.created_at).toLocaleString()}</time></div><p>{message.message}</p></article>)}</div><form className="support-reply" onSubmit={sendReply}>{supportStaff&&<label className="internal-note-toggle"><input type="checkbox" checked={internal} onChange={(e)=>setInternal(e.target.checked)}/> Internal note</label>}<textarea required maxLength="4000" rows="3" placeholder={internal?'Add an internal note (not visible to the customer)':'Write a reply…'} value={reply} onChange={(e)=>setReply(e.target.value)}/><button className="dashboard-primary" disabled={busy}>{busy?'Sending…':'Send reply'}</button></form></div>:<form className="support-thread support-new-ticket" onSubmit={createTicket}><h3>Create a support ticket</h3><label>Category<select value={draft.category} onChange={(e)=>setDraft({...draft,category:e.target.value})}>{['General','Booking','Account','Provider','Payment','Safety','Other'].map(value=><option key={value}>{value}</option>)}</select></label><label>Subject<input required maxLength="180" value={draft.subject} onChange={(e)=>setDraft({...draft,subject:e.target.value})}/></label><label>How can we help?<textarea required minLength="1" maxLength="4000" rows="5" value={draft.message} onChange={(e)=>setDraft({...draft,message:e.target.value})}/></label><label>Priority<select value={draft.priority} onChange={(e)=>setDraft({...draft,priority:e.target.value})}>{['low','normal','high','urgent'].map(value=><option key={value}>{value}</option>)}</select></label><button className="dashboard-primary" disabled={busy}>{busy?'Creating…':'Create ticket'}</button></form>}</div>
  </section>;
}
