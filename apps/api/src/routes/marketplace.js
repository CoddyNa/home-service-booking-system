const express = require('express');
const { ensureAuthenticated } = require('../middleware/auth');
const { requireRoles } = require('../middleware/role');
const c = require('../controllers/marketplaceController');

const router = express.Router();
const auth = ensureAuthenticated;
const admin = requireRoles('admin');
const customer = requireRoles('customer', 'user');
const provider = requireRoles('provider');
const support = requireRoles('support_agent', 'admin');

router.get('/categories', c.categories);
router.get('/profile', auth, c.ownProfile);
router.patch('/profile', auth, c.updateOwnProfile);
router.get('/services', c.services);
router.get('/services/:id', c.serviceById);
router.get('/providers/:id', c.providerProfile);
router.get('/providers/:providerId/availability', c.getAvailability);

router.post('/provider/applications', auth, customer, c.providerApplication);
router.get('/provider/applications/me', auth, c.ownProviderApplication);
router.get('/provider/services', auth, provider, c.listOwnServices);
router.post('/provider/services', auth, provider, c.createService);
router.patch('/provider/services/:id', auth, provider, c.updateOwnService);
router.post('/provider/availability', auth, provider, c.addAvailability);
router.delete('/provider/availability/:id', auth, provider, c.deleteAvailability);

router.get('/bookings', auth, requireRoles('customer', 'user', 'provider', 'admin'), c.myBookings);
router.post('/bookings', auth, customer, c.createBooking);
router.patch('/bookings/:id/status', auth, requireRoles('customer', 'user', 'provider', 'admin'), c.updateBookingStatus);
router.post('/bookings/:id/reviews', auth, customer, c.createReview);

router.get('/notifications', auth, (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}, c.notifications);
router.patch('/notifications/:id/read', auth, c.markNotificationRead);

router.post('/support/tickets', auth, requireRoles('customer', 'user', 'provider', 'support_agent', 'admin'), c.createTicket);
router.get('/support/tickets', auth, requireRoles('customer', 'user', 'provider', 'support_agent', 'admin'), c.listTickets);
router.get('/support/tickets/:id', auth, requireRoles('customer', 'user', 'provider', 'support_agent', 'admin'), c.ticketDetail);
router.post('/support/tickets/:id/replies', auth, requireRoles('customer', 'user', 'provider', 'support_agent', 'admin'), c.replyToTicket);
router.post('/support/tickets/:id/assign', auth, support, c.assignTicket);
router.patch('/support/tickets/:id', auth, support, c.updateTicket);

router.get('/admin/provider-applications', auth, admin, c.listProviderApplications);
router.patch('/admin/provider-applications/:id', auth, admin, c.reviewProviderApplication);
router.get('/admin/providers', auth, admin, c.adminProviders);
router.patch('/admin/providers/:id/status', auth, admin, c.updateProviderStatus);
router.get('/admin/services', auth, admin, c.adminServices);
router.patch('/admin/services/:id/review', auth, admin, c.reviewServiceListing);
router.get('/admin/reviews', auth, admin, c.adminReviews);
router.patch('/admin/reviews/:id', auth, admin, c.moderateReview);
router.get('/admin/support-agents', auth, admin, c.supportAgents);
router.post('/admin/categories', auth, admin, c.createCategory);
router.get('/admin/categories', auth, admin, c.adminCategories);
router.patch('/admin/categories/:id', auth, admin, c.updateCategory);

module.exports = router;
