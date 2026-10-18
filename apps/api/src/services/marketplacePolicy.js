const customerRoles = new Set(['customer', 'user']);
const transitions = {
  provider: { PENDING: ['CONFIRMED', 'REJECTED'], CONFIRMED: ['IN_PROGRESS'], IN_PROGRESS: ['COMPLETED'] },
  customer: { PENDING: ['CANCELLED'], CONFIRMED: ['CANCELLED'] },
  admin: { PENDING: ['CANCELLED'], CONFIRMED: ['CANCELLED'], IN_PROGRESS: ['CANCELLED'] },
};

function bookingActorRole(role, userId, booking) {
  if (role === 'admin') return 'admin';
  if (role === 'provider' && Number(booking.provider_id) === Number(userId)) return 'provider';
  if (customerRoles.has(role) && Number(booking.customer_id) === Number(userId)) return 'customer';
  return null;
}

function canTransitionBooking(role, currentStatus, nextStatus) {
  return Boolean((transitions[role]?.[currentStatus] || []).includes(nextStatus));
}

function canAccessTicket(role, userId, ticket) {
  if (role === 'admin') return true;
  if (Number(ticket.requester_id) === Number(userId)) return true;
  return role === 'support_agent' && Number(ticket.assigned_agent_id) === Number(userId);
}

function canAddInternalNote(role, userId, ticket) {
  return role === 'admin' || (role === 'support_agent' && Number(ticket.assigned_agent_id) === Number(userId));
}

module.exports = { bookingActorRole, canTransitionBooking, canAccessTicket, canAddInternalNote };
