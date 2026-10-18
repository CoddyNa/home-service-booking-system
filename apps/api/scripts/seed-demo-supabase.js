require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/config/db');
const { hashPassword } = require('../src/utils/password');

const expectedProjectRef = 'pxokvvlkawmoetdlmdxi';
const accounts = [
  { username: 'Demo Administrator', email: 'demo.admin@example.test', role: 'admin' },
  { username: 'Demo Customer', email: 'demo.customer@example.test', role: 'customer' },
  { username: 'Demo Provider', email: 'demo.provider@example.test', role: 'provider' },
  { username: 'Demo Support Agent', email: 'demo.support@example.test', role: 'support_agent' },
  { username: 'Demo Staff', email: 'demo.staff@example.test', role: 'staff' },
  { username: 'Demo Auditor', email: 'demo.auditor@example.test', role: 'auditor' },
];

async function main() {
  if (!String(process.env.DATABASE_HOST || '').endsWith('.pooler.supabase.com') ||
      process.env.DATABASE_USER !== `postgres.${expectedProjectRef}` ||
      process.env.DATABASE_NAME !== 'postgres' ||
      process.env.DATABASE_SSL !== 'true') {
    throw new Error('Refusing to seed: configured database is not the verified Supabase project.');
  }
  const caPath = process.env.PGSSLROOTCERT;
  const resolvedCa = caPath && (path.isAbsolute(caPath) ? caPath : path.resolve(__dirname, '..', caPath));
  if (!resolvedCa || !fs.existsSync(resolvedCa)) throw new Error('Supabase CA certificate is missing.');

  const client = await pool.connect();
  const issued = [];
  let seededCounts;
  try {
    await client.query('BEGIN');
    for (const account of accounts) {
      const existing = await client.query('SELECT id FROM users WHERE email = $1', [account.email]);
      const role = await client.query('SELECT id FROM roles WHERE name = $1', [account.role]);
      if (!role.rows[0]) throw new Error(`Required role is missing: ${account.role}`);
      if (existing.rows[0]) {
        await client.query('UPDATE users SET role_id = $1, is_active = TRUE, updated_at = NOW() WHERE id = $2', [role.rows[0].id, existing.rows[0].id]);
        continue;
      }
      const password = `D3mo-${crypto.randomBytes(18).toString('base64url')}!`;
      const credential = await hashPassword(password);
      await client.query(
        'INSERT INTO users (username, email, password_hash, password_salt, role_id, is_active) VALUES ($1, $2, $3, $4, $5, TRUE)',
        [account.username, account.email, credential.hash, credential.salt, role.rows[0].id],
      );
      issued.push({ ...account, password });
    }

    const demoCustomer = await client.query("SELECT id FROM users WHERE email='demo.customer@example.test'");
    const demoProvider = await client.query("SELECT id FROM users WHERE email='demo.provider@example.test'");
    if (!demoCustomer.rows[0] || !demoProvider.rows[0]) throw new Error('Marketplace migrations and demo accounts are required before demo data seeding.');

    await client.query(`INSERT INTO provider_profiles (user_id,business_name,bio,service_area,years_experience,approval_status)
      VALUES ($1,'Neighbourhood Home Care','Friendly, experienced home maintenance and repair professionals.','{Downtown,Northside}',6,'approved')
      ON CONFLICT (user_id) DO UPDATE SET business_name=EXCLUDED.business_name,bio=EXCLUDED.bio,service_area=EXCLUDED.service_area,years_experience=EXCLUDED.years_experience,approval_status='approved',updated_at=NOW()`, [demoProvider.rows[0].id]);

    const demoServices = [
      ['plumbing','Tap and pipe repair','Diagnosis and repair for common household leaks, taps, and pipe fittings.',160],
      ['plumbing','Bathroom fixture installation','Professional installation of sinks, faucets, showers, and bathroom fixtures.',220],
      ['electrical','Light fixture installation','Safe installation and replacement of indoor light fixtures and ceiling fans.',180],
      ['electrical','Outlet and switch repair','Troubleshooting and repair for faulty outlets, switches, and wiring connections.',140],
      ['cleaning','Full home cleaning','A detailed clean for kitchens, bathrooms, living areas, and bedrooms.',190],
      ['cleaning','Move-in deep cleaning','A top-to-bottom clean to prepare a home before moving in.',280],
      ['painting','Interior room painting','Careful preparation and painting for walls, trim, and interior rooms.',320],
      ['painting','Wall touch-up service','Small paint repairs and color-matched touch-ups for scuffs and marks.',95],
      ['carpentry','Furniture assembly','Assembly and placement of flat-pack furniture and household fixtures.',110],
      ['carpentry','Door and cabinet repair','Adjustment and repair for sticking doors, hinges, drawers, and cabinets.',135],
      ['appliance-repair','Washer diagnosis and repair','Troubleshooting and repair for common washing machine issues.',175],
      ['appliance-repair','Refrigerator maintenance','Inspection and maintenance to keep household refrigerators running well.',145],
      ['gardening','Garden tidy-up','Seasonal garden cleanup, pruning, weeding, and green waste gathering.',130],
      ['gardening','Lawn mowing and edging','Lawn mowing and neat edging for small and medium residential gardens.',100],
      ['air-conditioning','Air conditioner servicing','Filter cleaning and system checks for residential air conditioning units.',155],
    ];
    const serviceRecords = [];
    for (const [slug,title,description,price] of demoServices) {
      const category = await client.query('SELECT id FROM service_categories WHERE slug=$1 AND is_active=TRUE', [slug]);
      if (!category.rows[0]) throw new Error(`Required active service category is missing: ${slug}`);
      let result = await client.query('SELECT id,base_price FROM service_listings WHERE provider_id=$1 AND title=$2 LIMIT 1', [demoProvider.rows[0].id,title]);
      if (!result.rows[0]) result = await client.query(`INSERT INTO service_listings (provider_id,category_id,title,description,base_price,price_unit,service_area,approval_status)
        VALUES ($1,$2,$3,$4,$5,'per job','{Downtown,Northside}','approved') RETURNING id,base_price`, [demoProvider.rows[0].id,category.rows[0].id,title,description,price]);
      else await client.query("UPDATE service_listings SET approval_status='approved',is_active=TRUE,updated_at=NOW() WHERE id=$1", [result.rows[0].id]);
      serviceRecords.push({ id: result.rows[0].id, title, price: Number(result.rows[0].base_price) || price });
    }

    const sampleBookings = [
      { index: 0, status: 'COMPLETED', when: "NOW()-INTERVAL '5 days'", note: 'Completed demo service; repair finished successfully.' },
      { index: 2, status: 'PENDING', when: "NOW()+INTERVAL '2 days'", note: 'Please install the new light fixture in the living room.' },
      { index: 4, status: 'CONFIRMED', when: "NOW()+INTERVAL '3 days'", note: 'Please clean the kitchen and bathrooms before the weekend.' },
      { index: 6, status: 'PENDING', when: "NOW()+INTERVAL '5 days'", note: 'Looking for an estimate to paint the guest bedroom.' },
      { index: 8, status: 'IN_PROGRESS', when: "NOW()-INTERVAL '1 hour'", note: 'Please assemble a desk and two bookshelves.' },
      { index: 10, status: 'PENDING', when: "NOW()+INTERVAL '7 days'", note: 'The washer is making a loud noise during its spin cycle.' },
      { index: 12, status: 'CONFIRMED', when: "NOW()+INTERVAL '4 days'", note: 'Please tidy the front garden and trim the hedges.' },
      { index: 14, status: 'PENDING', when: "NOW()+INTERVAL '8 days'", note: 'Please check the air conditioner before the warm season.' },
    ];
    const bookingRecords = [];
    for (const sample of sampleBookings) {
      const service = serviceRecords[sample.index];
      const description = `Demo booking: ${sample.note}`;
      let booking = await client.query('SELECT id FROM bookings WHERE customer_id=$1 AND service_id=$2 AND description=$3 LIMIT 1', [demoCustomer.rows[0].id,service.id,description]);
      if (!booking.rows[0]) booking = await client.query(`INSERT INTO bookings (customer_id,provider_id,service_id,status,requested_at,agreed_price,description)
        VALUES ($1,$2,$3,$4,${sample.when},$5,$6) RETURNING id`, [demoCustomer.rows[0].id,demoProvider.rows[0].id,service.id,sample.status,service.price,description]);
      bookingRecords.push({ ...sample, id: booking.rows[0].id, service });
    }
    const completedBooking = bookingRecords.find((booking) => booking.status === 'COMPLETED');
    if (completedBooking) await client.query(`INSERT INTO service_reviews (booking_id,customer_id,provider_id,rating,comment)
      VALUES ($1,$2,$3,5,'Clear communication and a tidy repair.') ON CONFLICT (booking_id) DO NOTHING`, [completedBooking.id,demoCustomer.rows[0].id,demoProvider.rows[0].id]);

    for (const booking of bookingRecords) {
      const customerTitle = `Booking ${booking.status.toLowerCase().replace('_',' ')}`;
      const providerTitle = 'New demo booking request';
      const customerBody = `${booking.service.title}: your demo booking is ${booking.status.toLowerCase().replace('_',' ')}.`;
      const providerBody = `A demo customer requested ${booking.service.title}.`;
      await client.query(`INSERT INTO notifications (user_id,notification_type,title,body,data)
        SELECT $1,'booking.status',$2,$3,jsonb_build_object('bookingId',$4::integer) WHERE NOT EXISTS
        (SELECT 1 FROM notifications WHERE user_id=$1 AND title=$2 AND body=$3)`, [demoCustomer.rows[0].id,customerTitle,customerBody,booking.id]);
      await client.query(`INSERT INTO notifications (user_id,notification_type,title,body,data)
        SELECT $1,'booking.request',$2,$3,jsonb_build_object('bookingId',$4::integer) WHERE NOT EXISTS
        (SELECT 1 FROM notifications WHERE user_id=$1 AND title=$2 AND body=$3)`, [demoProvider.rows[0].id,providerTitle,providerBody,booking.id]);
    }

    const ticket = await client.query("SELECT id FROM support_tickets WHERE requester_id=$1 AND subject='Demo booking question' LIMIT 1", [demoCustomer.rows[0].id]);
    if (!ticket.rows[0]) {
      const created = await client.query(`INSERT INTO support_tickets (requester_id,assigned_agent_id,category,priority,status,subject)
        VALUES ($1,(SELECT id FROM users WHERE email='demo.support@example.test'),'Booking','normal','in_progress','Demo booking question') RETURNING id`, [demoCustomer.rows[0].id]);
      await client.query("INSERT INTO support_ticket_messages (ticket_id,sender_id,message) VALUES ($1,$2,'Could you confirm the arrival time for my booking?')", [created.rows[0].id, demoCustomer.rows[0].id]);
    }
    const counts = await client.query(`SELECT
      (SELECT count(*)::integer FROM service_listings WHERE provider_id=$1 AND approval_status='approved' AND is_active) AS services,
      (SELECT count(*)::integer FROM bookings WHERE customer_id=$2) AS bookings,
      (SELECT count(*)::integer FROM notifications WHERE user_id IN ($1,$2)) AS notifications`, [demoProvider.rows[0].id,demoCustomer.rows[0].id]);
    seededCounts = counts.rows[0];
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  if (issued.length) {
    console.log('New Supabase demo account credentials (shown once; store securely):');
    issued.forEach((account) => console.log(`${account.role}: ${account.email} / ${account.password}`));
  } else {
    console.log('Demo accounts already exist; roles were refreshed and passwords were not changed.');
  }
  console.log(`Demo marketplace records: ${seededCounts.services} services, ${seededCounts.bookings} customer bookings, ${seededCounts.notifications} customer/provider notifications.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
