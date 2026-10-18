const { bookingActorRole, canTransitionBooking, canAccessTicket, canAddInternalNote } = require('../src/services/marketplacePolicy');

describe('Marketplace role and ownership policies', () => {
  const booking = { customer_id: 10, provider_id: 20 };
  const ticket = { requester_id: 10, assigned_agent_id: 30 };

  test('all marketplace roles receive only their booking actor scope', () => {
    expect(bookingActorRole('customer', 10, booking)).toBe('customer');
    expect(bookingActorRole('provider', 20, booking)).toBe('provider');
    expect(bookingActorRole('admin', 99, booking)).toBe('admin');
    expect(bookingActorRole('support_agent', 30, booking)).toBeNull();
    expect(bookingActorRole('customer', 11, booking)).toBeNull();
    expect(bookingActorRole('provider', 21, booking)).toBeNull();
  });

  test('booking transitions follow role-specific lifecycle rules', () => {
    expect(canTransitionBooking('customer', 'PENDING', 'CANCELLED')).toBe(true);
    expect(canTransitionBooking('customer', 'PENDING', 'COMPLETED')).toBe(false);
    expect(canTransitionBooking('provider', 'PENDING', 'CONFIRMED')).toBe(true);
    expect(canTransitionBooking('provider', 'CONFIRMED', 'IN_PROGRESS')).toBe(true);
    expect(canTransitionBooking('provider', 'IN_PROGRESS', 'COMPLETED')).toBe(true);
    expect(canTransitionBooking('provider', 'PENDING', 'COMPLETED')).toBe(false);
    expect(canTransitionBooking('admin', 'COMPLETED', 'CANCELLED')).toBe(false);
  });

  test('ticket visibility is limited to the requester, assigned agent, and administrator', () => {
    expect(canAccessTicket('customer', 10, ticket)).toBe(true);
    expect(canAccessTicket('support_agent', 30, ticket)).toBe(true);
    expect(canAccessTicket('support_agent', 31, ticket)).toBe(false);
    expect(canAccessTicket('provider', 20, ticket)).toBe(false);
    expect(canAccessTicket('admin', 99, ticket)).toBe(true);
  });

  test('only assigned support agents and administrators can add internal notes', () => {
    expect(canAddInternalNote('support_agent', 30, ticket)).toBe(true);
    expect(canAddInternalNote('support_agent', 31, ticket)).toBe(false);
    expect(canAddInternalNote('customer', 10, ticket)).toBe(false);
    expect(canAddInternalNote('admin', 99, ticket)).toBe(true);
  });
});
