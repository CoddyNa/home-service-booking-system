const { pool } = require('../config/db');
const auditService = require('../services/auditService');
const { bookingActorRole, canTransitionBooking, canAccessTicket, canAddInternalNote } = require('../services/marketplacePolicy');

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const audit = (event) => auditService.logEvent(event).catch((error) => console.error('Marketplace audit failed:', error.message));
const text = (value, max, min = 1) => typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
const id = (value) => /^\d+$/.test(String(value)) && Number(value) > 0;
const customerRoles = ['customer', 'user'];

const categories = asyncRoute(async (_req, res) => {
  const result = await pool.query('SELECT id, slug, name, description FROM service_categories WHERE is_active = TRUE ORDER BY name');
  res.json({ categories: result.rows });
});

const ownProfile = asyncRoute(async (req, res) => {
  const result = await pool.query(`SELECT u.id,u.username,u.email,r.name AS role,COALESCE(t.enabled,FALSE) AS totp_enabled,
      cp.phone,cp.address,cp.city,pp.business_name,pp.bio,pp.service_area,pp.years_experience,pp.approval_status AS provider_status
    FROM users u JOIN roles r ON r.id=u.role_id LEFT JOIN totp_credentials t ON t.user_id=u.id
    LEFT JOIN customer_profiles cp ON cp.user_id=u.id LEFT JOIN provider_profiles pp ON pp.user_id=u.id
    WHERE u.id=$1 AND u.is_active=TRUE`, [req.session.userId]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Profile not found.' });
  res.json({ profile: result.rows[0] });
});

const updateOwnProfile = asyncRoute(async (req, res) => {
  const { username, phone = '', address = '', city = '', businessName, bio, serviceArea = [], yearsExperience } = req.body;
  if (!text(username, 80) || !text(String(phone), 40, 0) || !text(String(address), 240, 0) || !text(String(city), 100, 0)) return res.status(400).json({ error: 'Enter a valid display name and contact details.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query('UPDATE users SET username=$1,updated_at=NOW() WHERE id=$2 AND is_active=TRUE RETURNING id,username,email', [username.trim(), req.session.userId]);
    if (!updated.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Profile not found.' }); }
    if (customerRoles.includes(req.session.role)) {
      await client.query(`INSERT INTO customer_profiles (user_id,phone,address,city) VALUES ($1,$2,$3,$4)
        ON CONFLICT (user_id) DO UPDATE SET phone=EXCLUDED.phone,address=EXCLUDED.address,city=EXCLUDED.city,updated_at=NOW()`, [req.session.userId, String(phone).trim(), String(address).trim(), String(city).trim()]);
    } else if (req.session.role === 'provider') {
      if (!text(businessName, 120) || !text(bio, 2000, 10) || !Array.isArray(serviceArea) || serviceArea.length > 20 || !Number.isInteger(Number(yearsExperience)) || Number(yearsExperience) < 0 || Number(yearsExperience) > 80) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Enter a business name, provider description, service areas, and valid experience.' }); }
      await client.query(`UPDATE provider_profiles SET business_name=$1,bio=$2,phone=$3,service_area=$4,years_experience=$5,approval_status='pending',updated_at=NOW()
        WHERE user_id=$6`, [businessName.trim(), bio.trim(), String(phone).trim(), serviceArea.map((area) => String(area).trim().slice(0, 80)).filter(Boolean), Number(yearsExperience), req.session.userId]);
    }
    await client.query('COMMIT');
    await audit({ actorUserId: req.session.userId, targetUserId: req.session.userId, eventType: 'account.profile_updated', outcome: 'success' });
    res.json({ profile: updated.rows[0], message: 'Profile updated.' });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
const adminCategories = asyncRoute(async (_req, res) => {
  const result = await pool.query('SELECT id,slug,name,description,is_active FROM service_categories ORDER BY name');
  res.json({ categories: result.rows });
});

const createCategory = asyncRoute(async (req, res) => {
  const { name, slug, description = '' } = req.body;
  const normalizedSlug = String(slug || '').trim().toLowerCase();
  if (!text(name, 80) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug) || normalizedSlug.length > 80 || !text(String(description), 500, 0)) return res.status(400).json({ error: 'Provide a category name, URL-safe slug, and short description.' });
  try {
    const result = await pool.query('INSERT INTO service_categories (name,slug,description) VALUES ($1,$2,$3) RETURNING id,name,slug,description,is_active', [name.trim(), normalizedSlug, String(description).trim()]);
    await audit({ actorUserId: req.session.userId, eventType: 'admin.category_created', metadata: { categoryId: result.rows[0].id }, outcome: 'success' });
    res.status(201).json({ category: result.rows[0] });
  } catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'A category with that name or slug already exists.' }); throw error; }
});

const updateCategory = asyncRoute(async (req, res) => {
  const { name, description, isActive } = req.body;
  if (!id(req.params.id) || !text(name, 80) || !text(String(description), 500, 0) || typeof isActive !== 'boolean') return res.status(400).json({ error: 'Provide a valid category name, description, and active state.' });
  try {
    const result = await pool.query('UPDATE service_categories SET name=$1,description=$2,is_active=$3 WHERE id=$4 RETURNING id,name,slug,description,is_active', [name.trim(), String(description).trim(), isActive, req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Category not found.' });
    await audit({ actorUserId: req.session.userId, eventType: 'admin.category_updated', metadata: { categoryId: result.rows[0].id, isActive }, outcome: 'success' });
    res.json({ category: result.rows[0] });
  } catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'A category with that name already exists.' }); throw error; }
});

const services = asyncRoute(async (req, res) => {
  const { q = '', category = '', location = '', minPrice = '', maxPrice = '' } = req.query;
  const search = String(q).trim().slice(0, 100);
  const area = String(location).trim().slice(0, 100);
  const min = minPrice === '' ? null : Number(minPrice);
  const max = maxPrice === '' ? null : Number(maxPrice);
  if ((min !== null && (!Number.isFinite(min) || min < 0)) || (max !== null && (!Number.isFinite(max) || max < 0)) || (min !== null && max !== null && min > max)) return res.status(400).json({ error: 'Enter a valid price range.' });
  const result = await pool.query(`
    SELECT s.id, s.title, s.description, s.base_price, s.price_unit, s.service_area,
           c.id AS category_id, c.slug AS category_slug, c.name AS category,
           p.id AS provider_id, pp.business_name AS provider_name, pp.bio AS provider_bio,
           COALESCE(ROUND(AVG(r.rating)::numeric, 1), 0) AS rating, COUNT(r.id)::int AS review_count
    FROM service_listings s
    JOIN service_categories c ON c.id = s.category_id
    JOIN users p ON p.id = s.provider_id AND p.is_active = TRUE
    JOIN provider_profiles pp ON pp.user_id = p.id AND pp.approval_status = 'approved'
    LEFT JOIN service_reviews r ON r.provider_id = p.id AND r.moderation_status = 'visible'
    WHERE s.approval_status = 'approved' AND s.is_active = TRUE AND c.is_active = TRUE
      AND ($1 = '' OR s.title ILIKE '%' || $1 || '%' OR s.description ILIKE '%' || $1 || '%' OR c.name ILIKE '%' || $1 || '%' OR pp.business_name ILIKE '%' || $1 || '%')
      AND ($2 = '' OR c.slug = $2)
      AND ($3 = '' OR cardinality(s.service_area) = 0 OR EXISTS (SELECT 1 FROM unnest(s.service_area) a WHERE a ILIKE '%' || $3 || '%'))
      AND ($4::numeric IS NULL OR s.base_price >= $4::numeric)
      AND ($5::numeric IS NULL OR s.base_price <= $5::numeric)
    GROUP BY s.id, c.id, p.id, pp.user_id
    ORDER BY rating DESC, s.created_at DESC LIMIT 100`,
  [search, String(category), area, min, max]);
  res.json({ services: result.rows });
});

const serviceById = asyncRoute(async (req, res) => {
  if (!id(req.params.id)) return res.status(400).json({ error: 'Invalid service id' });
  const result = await pool.query(`SELECT s.id, s.title, s.description, s.base_price, s.price_unit, s.service_area,
      c.id AS category_id, c.name AS category, c.slug AS category_slug, p.id AS provider_id,
      pp.business_name AS provider_name, pp.bio AS provider_bio, pp.years_experience
    FROM service_listings s JOIN service_categories c ON c.id=s.category_id
    JOIN provider_profiles pp ON pp.user_id=s.provider_id AND pp.approval_status='approved'
    JOIN users p ON p.id=s.provider_id AND p.is_active=TRUE
    WHERE s.id=$1 AND s.approval_status='approved' AND s.is_active=TRUE AND c.is_active=TRUE`, [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Service not found' });
  const reviews = await pool.query(`SELECT r.rating, r.comment, r.created_at, u.username AS customer_name
    FROM service_reviews r JOIN users u ON u.id=r.customer_id
    WHERE r.provider_id=$1 AND r.moderation_status='visible' ORDER BY r.created_at DESC LIMIT 30`, [result.rows[0].provider_id]);
  res.json({ service: result.rows[0], reviews: reviews.rows });
});

const providerApplication = asyncRoute(async (req, res) => {
  const { businessName, bio, serviceArea = [], yearsExperience = 0 } = req.body;
  if (!text(businessName, 120) || !text(bio, 2000, 10) || !Array.isArray(serviceArea) || serviceArea.length > 20 || !Number.isInteger(Number(yearsExperience)) || Number(yearsExperience) < 0 || Number(yearsExperience) > 80) return res.status(400).json({ error: 'Provide a business name, a short bio, service areas, and valid experience.' });
  const existing = await pool.query("SELECT id FROM provider_applications WHERE user_id=$1 AND status='pending' LIMIT 1", [req.session.userId]);
  if (existing.rows[0]) return res.status(409).json({ error: 'You already have a provider application under review.' });
  let result;
  try { result = await pool.query(`INSERT INTO provider_applications (user_id,business_name,bio,service_area,years_experience)
    VALUES ($1,$2,$3,$4,$5) RETURNING id,status,created_at`, [req.session.userId, businessName.trim(), bio.trim(), serviceArea.map((a) => String(a).trim().slice(0, 80)).filter(Boolean), Number(yearsExperience)]); }
  catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'You already have a provider application under review.' }); throw error; }
  await audit({ actorUserId: req.session.userId, targetUserId: req.session.userId, eventType: 'provider.application_submitted', outcome: 'success' });
  res.status(201).json({ application: result.rows[0] });
});

const ownProviderApplication = asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT id,business_name,bio,service_area,years_experience,status,created_at,reviewed_at FROM provider_applications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [req.session.userId]);
  res.json({ application: result.rows[0] || null });
});

const listProviderApplications = asyncRoute(async (_req, res) => {
  const result = await pool.query(`SELECT a.id,a.user_id,a.business_name,a.bio,a.service_area,a.years_experience,a.status,a.created_at,u.username,u.email
    FROM provider_applications a JOIN users u ON u.id=a.user_id ORDER BY CASE WHEN a.status='pending' THEN 0 ELSE 1 END,a.created_at DESC LIMIT 500`);
  res.json({ applications: result.rows });
});

const adminProviders = asyncRoute(async (_req, res) => {
  const result = await pool.query(`SELECT pp.user_id,pp.business_name,pp.bio,pp.service_area,pp.years_experience,pp.approval_status,pp.created_at,u.username,u.email
    FROM provider_profiles pp JOIN users u ON u.id=pp.user_id ORDER BY CASE WHEN pp.approval_status='pending' THEN 0 ELSE 1 END,pp.created_at DESC LIMIT 500`);
  res.json({ providers: result.rows });
});

const updateProviderStatus = asyncRoute(async (req, res) => {
  const { status } = req.body;
  if (!id(req.params.id) || !['approved', 'suspended', 'rejected'].includes(status)) return res.status(400).json({ error: 'Choose approved, suspended, or rejected.' });
  const result = await pool.query('UPDATE provider_profiles SET approval_status=$1,reviewed_by=$2,reviewed_at=NOW(),updated_at=NOW() WHERE user_id=$3 RETURNING user_id,business_name', [status, req.session.userId, req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Provider profile not found.' });
  if (status !== 'approved') await pool.query('DELETE FROM sessions WHERE user_id=$1', [result.rows[0].user_id]);
  await pool.query('INSERT INTO notifications (user_id,notification_type,title,body) VALUES ($1,$2,$3,$4)', [result.rows[0].user_id, 'provider.profile', `Provider profile ${status}`, `An administrator ${status} your provider profile.`]);
  await audit({ actorUserId: req.session.userId, targetUserId: result.rows[0].user_id, eventType: `admin.provider_${status}`, outcome: 'success' });
  res.json({ message: `Provider profile ${status}.` });
});

const reviewProviderApplication = asyncRoute(async (req, res) => {
  const { status, notes = '' } = req.body;
  if (!id(req.params.id) || !['approved', 'rejected'].includes(status) || !text(String(notes), 1000, 0)) return res.status(400).json({ error: 'Choose approved or rejected and provide valid review notes.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query("SELECT * FROM provider_applications WHERE id=$1 AND status='pending' FOR UPDATE", [req.params.id]);
    if (!found.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Pending application not found.' }); }
    const application = found.rows[0];
    await client.query('UPDATE provider_applications SET status=$1,reviewed_by=$2,admin_notes=$3,reviewed_at=NOW() WHERE id=$4', [status, req.session.userId, String(notes).trim(), application.id]);
    if (status === 'approved') {
      await client.query(`INSERT INTO provider_profiles (user_id,business_name,bio,service_area,years_experience,approval_status,reviewed_by,reviewed_at)
        VALUES ($1,$2,$3,$4,$5,'approved',$6,NOW()) ON CONFLICT (user_id) DO UPDATE SET business_name=EXCLUDED.business_name,bio=EXCLUDED.bio,service_area=EXCLUDED.service_area,years_experience=EXCLUDED.years_experience,approval_status='approved',reviewed_by=EXCLUDED.reviewed_by,reviewed_at=NOW(),updated_at=NOW()`,
      [application.user_id, application.business_name, application.bio, application.service_area, application.years_experience, req.session.userId]);
      await client.query("UPDATE users SET role_id=(SELECT id FROM roles WHERE name='provider'),updated_at=NOW() WHERE id=$1", [application.user_id]);
      await client.query('DELETE FROM sessions WHERE user_id=$1', [application.user_id]);
      await client.query("INSERT INTO notifications (user_id,notification_type,title,body) VALUES ($1,'provider.application','Provider account approved','Your provider application was approved. You can now create service listings.')", [application.user_id]);
    } else {
      await client.query("INSERT INTO notifications (user_id,notification_type,title,body) VALUES ($1,'provider.application','Provider application update','Your provider application was not approved. Contact support if you need more information.')", [application.user_id]);
    }
    await client.query('COMMIT');
    await audit({ actorUserId: req.session.userId, targetUserId: application.user_id, eventType: `admin.provider_application_${status}`, metadata: { applicationId: application.id }, outcome: 'success' });
    res.json({ message: `Provider application ${status}.` });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

const providerProfile = asyncRoute(async (req, res) => {
  const result = await pool.query(`SELECT pp.user_id,pp.business_name,pp.bio,pp.phone,pp.service_area,pp.years_experience,pp.approval_status,u.username
    FROM provider_profiles pp JOIN users u ON u.id=pp.user_id WHERE pp.user_id=$1 AND pp.approval_status='approved'`, [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Approved provider not found.' });
  res.json({ provider: result.rows[0] });
});

const listOwnServices = asyncRoute(async (req, res) => {
  const profile = await pool.query("SELECT approval_status FROM provider_profiles WHERE user_id=$1", [req.session.userId]);
  if (profile.rows[0]?.approval_status !== 'approved') return res.json({ services: [], providerStatus: profile.rows[0]?.approval_status || 'missing' });
  const result = await pool.query(`SELECT s.*,c.name AS category FROM service_listings s JOIN service_categories c ON c.id=s.category_id WHERE s.provider_id=$1 ORDER BY s.created_at DESC`, [req.session.userId]);
  res.json({ services: result.rows });
});

const createService = asyncRoute(async (req, res) => {
  const { categoryId, title, description, basePrice, priceUnit = 'per job', serviceArea = [] } = req.body;
  if (!id(categoryId) || !text(title, 140) || !text(description, 4000, 10) || !Number.isFinite(Number(basePrice)) || Number(basePrice) <= 0 || Number(basePrice) > 10000000 || !text(priceUnit, 40) || !Array.isArray(serviceArea) || serviceArea.length > 20) return res.status(400).json({ error: 'Check the service category, title, description, price, and service areas.' });
  const category = await pool.query('SELECT id FROM service_categories WHERE id=$1 AND is_active=TRUE', [categoryId]);
  if (!category.rows[0]) return res.status(400).json({ error: 'Choose an active service category.' });
  const profile = await pool.query("SELECT approval_status FROM provider_profiles WHERE user_id=$1", [req.session.userId]);
  if (profile.rows[0]?.approval_status !== 'approved') return res.status(403).json({ error: 'Your provider profile must be approved before listing services.' });
  const result = await pool.query(`INSERT INTO service_listings (provider_id,category_id,title,description,base_price,price_unit,service_area)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,title,approval_status,created_at`, [req.session.userId, categoryId, title.trim(), description.trim(), Number(basePrice).toFixed(2), priceUnit.trim(), serviceArea.map((a) => String(a).trim().slice(0, 80)).filter(Boolean)]);
  await audit({ actorUserId: req.session.userId, eventType: 'provider.service_submitted', metadata: { serviceId: result.rows[0].id }, outcome: 'success' });
  res.status(201).json({ service: result.rows[0], message: 'Service submitted for administrator approval.' });
});

const updateOwnService = asyncRoute(async (req, res) => {
  const { categoryId, title, description, basePrice, priceUnit, serviceArea = [], isActive = true } = req.body;
  if (!id(req.params.id) || !id(categoryId) || !text(title, 140) || !text(description, 4000, 10) || !Number.isFinite(Number(basePrice)) || Number(basePrice) <= 0 || Number(basePrice) > 10000000 || !text(priceUnit, 40) || !Array.isArray(serviceArea) || serviceArea.length > 20 || typeof isActive !== 'boolean') return res.status(400).json({ error: 'Invalid service listing details.' });
  const category = await pool.query('SELECT id FROM service_categories WHERE id=$1 AND is_active=TRUE', [categoryId]);
  if (!category.rows[0]) return res.status(400).json({ error: 'Choose an active service category.' });
  const profile = await pool.query("SELECT approval_status FROM provider_profiles WHERE user_id=$1", [req.session.userId]);
  if (profile.rows[0]?.approval_status !== 'approved') return res.status(403).json({ error: 'Your provider profile is not currently approved.' });
  const result = await pool.query(`UPDATE service_listings SET category_id=$1,title=$2,description=$3,base_price=$4,price_unit=$5,service_area=$6,is_active=$7,approval_status='pending',updated_at=NOW()
    WHERE id=$8 AND provider_id=$9 RETURNING id,approval_status`, [categoryId, title.trim(), description.trim(), Number(basePrice).toFixed(2), priceUnit.trim(), serviceArea.map((a) => String(a).trim().slice(0, 80)).filter(Boolean), isActive, req.params.id, req.session.userId]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Service listing not found.' });
  await audit({ actorUserId: req.session.userId, eventType: 'provider.service_updated', metadata: { serviceId: req.params.id }, outcome: 'success' });
  res.json({ service: result.rows[0], message: 'Changes saved and sent for approval.' });
});

const adminServices = asyncRoute(async (req, res) => {
  const status = ['pending', 'approved', 'rejected', 'suspended'].includes(req.query.status) ? req.query.status : null;
  const result = await pool.query(`SELECT s.id,s.title,s.description,s.base_price,s.price_unit,s.service_area,s.approval_status,s.is_active,s.created_at,c.name AS category,u.id AS provider_id,u.username,pp.business_name
    FROM service_listings s JOIN users u ON u.id=s.provider_id JOIN provider_profiles pp ON pp.user_id=u.id JOIN service_categories c ON c.id=s.category_id
    WHERE ($1::text IS NULL OR s.approval_status=$1) ORDER BY s.created_at DESC LIMIT 500`, [status]);
  res.json({ services: result.rows });
});

const reviewServiceListing = asyncRoute(async (req, res) => {
  const { status } = req.body;
  if (!id(req.params.id) || !['approved', 'rejected', 'suspended'].includes(status)) return res.status(400).json({ error: 'Choose approved, rejected, or suspended.' });
  const result = await pool.query('UPDATE service_listings SET approval_status=$1,updated_at=NOW() WHERE id=$2 RETURNING id,provider_id,title', [status, req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Service listing not found.' });
  if (status === 'approved') await pool.query("INSERT INTO notifications (user_id,notification_type,title,body,data) VALUES ($1,'service.approval','Service listing approved','Your service is now visible in the marketplace.',jsonb_build_object('serviceId',$2))", [result.rows[0].provider_id, result.rows[0].id]);
  await audit({ actorUserId: req.session.userId, targetUserId: result.rows[0].provider_id, eventType: `admin.service_${status}`, metadata: { serviceId: result.rows[0].id }, outcome: 'success' });
  res.json({ message: `Service listing ${status}.` });
});

const adminReviews = asyncRoute(async (_req, res) => {
  const result = await pool.query(`SELECT r.id,r.booking_id,r.rating,r.comment,r.moderation_status,r.created_at,
      customer.username AS customer_name,provider.username AS provider_username,pp.business_name
    FROM service_reviews r JOIN users customer ON customer.id=r.customer_id JOIN users provider ON provider.id=r.provider_id
    LEFT JOIN provider_profiles pp ON pp.user_id=r.provider_id ORDER BY r.created_at DESC LIMIT 500`);
  res.json({ reviews: result.rows });
});

const moderateReview = asyncRoute(async (req, res) => {
  const { status } = req.body;
  if (!id(req.params.id) || !['visible', 'hidden'].includes(status)) return res.status(400).json({ error: 'Choose visible or hidden.' });
  const result = await pool.query('UPDATE service_reviews SET moderation_status=$1 WHERE id=$2 RETURNING id,provider_id,booking_id', [status, req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Review not found.' });
  await audit({ actorUserId: req.session.userId, targetUserId: result.rows[0].provider_id, eventType: 'admin.review_moderated', metadata: { reviewId: result.rows[0].id, status }, outcome: 'success' });
  res.json({ message: `Review ${status}.` });
});

const supportAgents = asyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT id,username,email FROM users WHERE role_id=(SELECT id FROM roles WHERE name='support_agent') AND is_active=TRUE ORDER BY username LIMIT 200");
  res.json({ agents: result.rows });
});

const getAvailability = asyncRoute(async (req, res) => {
  const owner = req.params.providerId;
  if (!id(owner)) return res.status(400).json({ error: 'Invalid provider id.' });
  const result = await pool.query('SELECT id,weekday,starts_at,ends_at,is_available FROM provider_availability WHERE provider_id=$1 AND is_available=TRUE ORDER BY weekday,starts_at', [owner]);
  res.json({ availability: result.rows });
});

const addAvailability = asyncRoute(async (req, res) => {
  const { weekday, startsAt, endsAt } = req.body;
  if (!Number.isInteger(Number(weekday)) || Number(weekday) < 0 || Number(weekday) > 6 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(startsAt)) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(endsAt)) || startsAt >= endsAt) return res.status(400).json({ error: 'Provide a weekday and valid start and end times.' });
  const result = await pool.query(`INSERT INTO provider_availability (provider_id,weekday,starts_at,ends_at) VALUES ($1,$2,$3,$4)
    ON CONFLICT (provider_id,weekday,starts_at,ends_at) DO UPDATE SET is_available=TRUE RETURNING id,weekday,starts_at,ends_at`, [req.session.userId, weekday, startsAt, endsAt]);
  res.status(201).json({ availability: result.rows[0] });
});

const deleteAvailability = asyncRoute(async (req, res) => {
  if (!id(req.params.id)) return res.status(400).json({ error: 'Invalid availability id.' });
  const result = await pool.query('DELETE FROM provider_availability WHERE id=$1 AND provider_id=$2 RETURNING id', [req.params.id, req.session.userId]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Availability window not found.' });
  res.json({ message: 'Availability removed.' });
});

const myBookings = asyncRoute(async (req, res) => {
  const userId = req.session.userId;
  let sql = `SELECT b.*,s.title AS service_title,c.name AS category,cu.username AS customer_name,pr.username AS provider_username,pp.business_name AS provider_name
    ,EXISTS (SELECT 1 FROM service_reviews sr WHERE sr.booking_id=b.id) AS has_review
    FROM bookings b JOIN service_listings s ON s.id=b.service_id JOIN service_categories c ON c.id=s.category_id
    JOIN users cu ON cu.id=b.customer_id JOIN users pr ON pr.id=b.provider_id LEFT JOIN provider_profiles pp ON pp.user_id=pr.id`;
  const params = [];
  if (customerRoles.includes(req.session.role)) { sql += ' WHERE b.customer_id=$1'; params.push(userId); }
  else if (req.session.role === 'provider') { sql += ' WHERE b.provider_id=$1'; params.push(userId); }
  else if (req.session.role !== 'admin') return res.status(403).json({ error: 'Forbidden.' });
  sql += ' ORDER BY b.requested_at DESC LIMIT 500';
  const result = await pool.query(sql, params);
  res.json({ bookings: result.rows });
});

const createBooking = asyncRoute(async (req, res) => {
  const { serviceId, requestedAt, description = '' } = req.body;
  const date = new Date(requestedAt);
  if (!id(serviceId) || !Number.isFinite(date.getTime()) || date <= new Date() || !text(String(description), 2000, 0)) return res.status(400).json({ error: 'Choose a valid service and future booking time.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const service = await client.query(`SELECT s.id,s.provider_id,s.base_price FROM service_listings s JOIN provider_profiles pp ON pp.user_id=s.provider_id AND pp.approval_status='approved'
      JOIN users u ON u.id=s.provider_id AND u.is_active=TRUE WHERE s.id=$1 AND s.is_active=TRUE AND s.approval_status='approved' FOR SHARE OF s`, [serviceId]);
    if (!service.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'This service is not currently available.' }); }
    if (Number(service.rows[0].provider_id) === Number(req.session.userId)) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'You cannot book your own service.' }); }
    const booking = await client.query(`INSERT INTO bookings (customer_id,provider_id,service_id,requested_at,agreed_price,description)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,status,requested_at,agreed_price`, [req.session.userId, service.rows[0].provider_id, serviceId, date, service.rows[0].base_price, String(description).trim()]);
    await client.query("INSERT INTO notifications (user_id,notification_type,title,body,data) VALUES ($1,'booking.request','New booking request','A customer requested one of your services.',jsonb_build_object('bookingId',$2))", [service.rows[0].provider_id, booking.rows[0].id]);
    await client.query('COMMIT');
    await audit({ actorUserId: req.session.userId, targetUserId: service.rows[0].provider_id, eventType: 'booking.created', metadata: { bookingId: booking.rows[0].id, serviceId }, outcome: 'success' });
    res.status(201).json({ booking: booking.rows[0], message: 'Booking request sent to the provider.' });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

const updateBookingStatus = asyncRoute(async (req, res) => {
  const { status, reason = '' } = req.body;
  if (!id(req.params.id) || !['PENDING', 'CONFIRMED', 'REJECTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(status) || !text(String(reason), 500, 0)) return res.status(400).json({ error: 'Invalid booking status or cancellation reason.' });
  const result = await pool.query('SELECT id,customer_id,provider_id,status FROM bookings WHERE id=$1', [req.params.id]);
  const booking = result.rows[0];
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  const role = bookingActorRole(req.session.role, req.session.userId, booking);
  if (!role) return res.status(403).json({ error: 'You do not have access to this booking.' });
  if (!canTransitionBooking(role, booking.status, status)) return res.status(409).json({ error: `Booking cannot move from ${booking.status} to ${status}.` });
  const updated = await pool.query('UPDATE bookings SET status=$1,cancellation_reason=$2,updated_at=NOW() WHERE id=$3 AND status=$4 RETURNING id,status,customer_id,provider_id', [status, status === 'CANCELLED' ? String(reason).trim() : null, booking.id, booking.status]);
  if (!updated.rows[0]) return res.status(409).json({ error: 'This booking changed. Refresh and try again.' });
  const notifyId = role === 'provider' ? booking.customer_id : booking.provider_id;
  const title = status === 'CONFIRMED' ? 'Booking confirmed' : status === 'REJECTED' ? 'Booking declined' : status === 'COMPLETED' ? 'Service completed' : status === 'IN_PROGRESS' ? 'Service in progress' : 'Booking cancelled';
  await pool.query('INSERT INTO notifications (user_id,notification_type,title,body,data) VALUES ($1,$2,$3,$4,$5::jsonb)', [notifyId, 'booking.status', title, `Booking #${booking.id} is now ${status.toLowerCase().replace('_', ' ')}.`, JSON.stringify({ bookingId: booking.id })]);
  await audit({ actorUserId: req.session.userId, targetUserId: notifyId, eventType: 'booking.status_changed', metadata: { bookingId: booking.id, from: booking.status, to: status }, outcome: 'success' });
  res.json({ booking: updated.rows[0] });
});

const createReview = asyncRoute(async (req, res) => {
  const { rating, comment = '' } = req.body;
  if (!id(req.params.id) || !Number.isInteger(Number(rating)) || Number(rating) < 1 || Number(rating) > 5 || !text(String(comment), 1500, 0)) return res.status(400).json({ error: 'Choose a rating from 1 to 5 and an optional comment up to 1500 characters.' });
  const booking = await pool.query("SELECT id,provider_id FROM bookings WHERE id=$1 AND customer_id=$2 AND status='COMPLETED'", [req.params.id, req.session.userId]);
  if (!booking.rows[0]) return res.status(403).json({ error: 'Only the customer on a completed booking can leave a review.' });
  try {
    const result = await pool.query('INSERT INTO service_reviews (booking_id,customer_id,provider_id,rating,comment) VALUES ($1,$2,$3,$4,$5) RETURNING id,rating,comment,created_at', [booking.rows[0].id, req.session.userId, booking.rows[0].provider_id, rating, String(comment).trim()]);
    await audit({ actorUserId: req.session.userId, targetUserId: booking.rows[0].provider_id, eventType: 'review.created', metadata: { bookingId: booking.rows[0].id }, outcome: 'success' });
    res.status(201).json({ review: result.rows[0] });
  } catch (error) { if (error.code === '23505') return res.status(409).json({ error: 'This booking already has a review.' }); throw error; }
});

const notifications = asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT id,notification_type,title,body,data,created_at,read_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [req.session.userId]);
  res.json({ notifications: result.rows });
});
const markNotificationRead = asyncRoute(async (req, res) => {
  if (!id(req.params.id)) return res.status(400).json({ error: 'Invalid notification id.' });
  const result = await pool.query('UPDATE notifications SET read_at=COALESCE(read_at,NOW()) WHERE id=$1 AND user_id=$2 RETURNING id,read_at', [req.params.id, req.session.userId]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Notification not found.' });
  res.json({ notification: result.rows[0] });
});

const createTicket = asyncRoute(async (req, res) => {
  const { category, subject, message, priority = 'normal' } = req.body;
  if (!text(category, 60) || !text(subject, 180) || !text(message, 4000) || !['low', 'normal', 'high', 'urgent'].includes(priority)) return res.status(400).json({ error: 'Provide a category, subject, message, and valid priority.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ticket = await client.query('INSERT INTO support_tickets (requester_id,category,subject,priority) VALUES ($1,$2,$3,$4) RETURNING id,status,priority,created_at', [req.session.userId, category.trim(), subject.trim(), priority]);
    await client.query('INSERT INTO support_ticket_messages (ticket_id,sender_id,message) VALUES ($1,$2,$3)', [ticket.rows[0].id, req.session.userId, message.trim()]);
    await client.query('COMMIT');
    await audit({ actorUserId: req.session.userId, eventType: 'support.ticket_created', metadata: { ticketId: ticket.rows[0].id }, outcome: 'success' });
    res.status(201).json({ ticket: ticket.rows[0] });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

const listTickets = asyncRoute(async (req, res) => {
  let sql = `SELECT t.id,t.requester_id,t.assigned_agent_id,t.category,t.priority,t.status,t.subject,t.created_at,t.updated_at, requester.username AS requester_name, agent.username AS assigned_agent_name
    FROM support_tickets t JOIN users requester ON requester.id=t.requester_id LEFT JOIN users agent ON agent.id=t.assigned_agent_id`;
  const params = [];
  if (req.session.role === 'customer' || req.session.role === 'provider' || req.session.role === 'user') { sql += ' WHERE t.requester_id=$1'; params.push(req.session.userId); }
  else if (req.session.role === 'support_agent') { sql += ' WHERE t.assigned_agent_id=$1'; params.push(req.session.userId); }
  else if (req.session.role !== 'admin') return res.status(403).json({ error: 'Forbidden.' });
  sql += ' ORDER BY t.updated_at DESC LIMIT 300';
  const result = await pool.query(sql, params);
  res.json({ tickets: result.rows });
});

const ticketDetail = asyncRoute(async (req, res) => {
  if (!id(req.params.id)) return res.status(400).json({ error: 'Invalid ticket id.' });
  const result = await pool.query('SELECT * FROM support_tickets WHERE id=$1', [req.params.id]);
  const ticket = result.rows[0];
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  const isOwner = Number(ticket.requester_id) === Number(req.session.userId);
  const isAgent = canAddInternalNote(req.session.role, req.session.userId, ticket);
  if (!isOwner && !isAgent) return res.status(403).json({ error: 'You do not have access to this ticket.' });
  const messages = await pool.query(`SELECT m.id,m.sender_id,m.message,m.is_internal,m.created_at,u.username AS sender_name FROM support_ticket_messages m JOIN users u ON u.id=m.sender_id
    WHERE m.ticket_id=$1 AND ($2::boolean=TRUE OR m.is_internal=FALSE) ORDER BY m.created_at`, [ticket.id, isAgent]);
  res.json({ ticket, messages: messages.rows });
});

const replyToTicket = asyncRoute(async (req, res) => {
  const { message, internal = false } = req.body;
  if (!id(req.params.id) || !text(message, 4000) || typeof internal !== 'boolean') return res.status(400).json({ error: 'Enter a valid reply.' });
  const result = await pool.query('SELECT * FROM support_tickets WHERE id=$1', [req.params.id]);
  const ticket = result.rows[0];
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  const isAssignedAgent = canAddInternalNote(req.session.role, req.session.userId, ticket);
  if (!canAccessTicket(req.session.role, req.session.userId, ticket) || (internal && !isAssignedAgent)) return res.status(403).json({ error: 'You do not have permission to reply to this ticket.' });
  const added = await pool.query('INSERT INTO support_ticket_messages (ticket_id,sender_id,message,is_internal) VALUES ($1,$2,$3,$4) RETURNING id,created_at', [ticket.id, req.session.userId, message.trim(), internal]);
  await pool.query("UPDATE support_tickets SET status=CASE WHEN status IN ('resolved','closed') AND $2::boolean=FALSE THEN 'open' ELSE status END,updated_at=NOW() WHERE id=$1", [ticket.id, isAssignedAgent]);
  if (isAssignedAgent && !internal) await pool.query("INSERT INTO notifications (user_id,notification_type,title,body,data) VALUES ($1,'support.reply','Support replied','There is a new reply to your support ticket.',jsonb_build_object('ticketId',$2))", [ticket.requester_id, ticket.id]);
  await audit({ actorUserId: req.session.userId, targetUserId: ticket.requester_id, eventType: internal ? 'support.internal_note_added' : 'support.reply_added', metadata: { ticketId: ticket.id }, outcome: 'success' });
  res.status(201).json({ message: 'Reply added.', reply: added.rows[0] });
});

const assignTicket = asyncRoute(async (req, res) => {
  const requestedAgentId = req.session.role === 'support_agent' ? req.session.userId : req.body.agentId;
  if (!id(req.params.id) || !id(requestedAgentId)) return res.status(400).json({ error: 'Choose a valid support agent.' });
  const agent = await pool.query("SELECT id FROM users WHERE id=$1 AND role_id=(SELECT id FROM roles WHERE name='support_agent') AND is_active=TRUE", [requestedAgentId]);
  if (!agent.rows[0]) return res.status(400).json({ error: 'That account is not an active support agent.' });
  const result = await pool.query("UPDATE support_tickets SET assigned_agent_id=$1,status='in_progress',updated_at=NOW() WHERE id=$2 RETURNING id,requester_id", [requestedAgentId, req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Ticket not found.' });
  await audit({ actorUserId: req.session.userId, targetUserId: requestedAgentId, eventType: 'support.ticket_assigned', metadata: { ticketId: req.params.id }, outcome: 'success' });
  res.json({ message: 'Ticket assigned.' });
});

const updateTicket = asyncRoute(async (req, res) => {
  const { status, priority } = req.body;
  if (!id(req.params.id) || !['open', 'in_progress', 'waiting', 'resolved', 'closed'].includes(status) || !['low', 'normal', 'high', 'urgent'].includes(priority)) return res.status(400).json({ error: 'Choose a valid ticket status and priority.' });
  const result = await pool.query('UPDATE support_tickets SET status=$1,priority=$2,updated_at=NOW() WHERE id=$3 AND ($4::integer IS NULL OR assigned_agent_id=$4::integer) RETURNING id,requester_id,status,priority', [status, priority, req.params.id, req.session.role === 'support_agent' ? req.session.userId : null]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Assigned ticket not found.' });
  await audit({ actorUserId: req.session.userId, targetUserId: result.rows[0].requester_id, eventType: 'support.ticket_updated', metadata: { ticketId: result.rows[0].id, status, priority }, outcome: 'success' });
  res.json({ ticket: result.rows[0] });
});

module.exports = {
  asyncRoute, categories, ownProfile, updateOwnProfile, adminCategories, createCategory, updateCategory, services, serviceById, providerApplication, ownProviderApplication,
  listProviderApplications, reviewProviderApplication, adminProviders, updateProviderStatus, providerProfile, listOwnServices,
  createService, updateOwnService, adminServices, reviewServiceListing, adminReviews, moderateReview, supportAgents, getAvailability,
  addAvailability, deleteAvailability, myBookings, createBooking, updateBookingStatus,
  createReview, notifications, markNotificationRead, createTicket, listTickets,
  ticketDetail, replyToTicket, assignTicket, updateTicket,
};
