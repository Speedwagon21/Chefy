// Demo data: three verified cooks with menus, one customer and one admin account.
// Run with:  npm run seed      (only on a fresh database; it refuses to run twice)
const { one, run, tx } = require('../src/db');
const { hashPassword } = require('../src/auth');
const pay = require('../src/payments');

if (one('SELECT 1 FROM users LIMIT 1')) {
  console.log('Database already has users; not seeding. Delete the data folder to start fresh.');
  process.exit(0);
}

const PASSWORD = 'chefy-demo-2026';
const now = Date.now();
const img = id => `https://images.unsplash.com/${id}?w=800&auto=format&fit=crop&q=75`;

const cooks = [
  {
    email: 'maria@chefy.test', name: 'Maria Garcia', kitchen: "Abuela's Kitchen", cuisine: 'Michoacán tamales',
    bio: 'Recipes passed down through four generations. Every tamal is wrapped by hand in corn husks the morning you order.',
    avatar: img('photo-1577219491135-ce391730fb2c'), cover: img('photo-1565299585323-38d6b0865b47'),
    address: '24th St & Folsom St, San Francisco', notes: 'Pickup 4–7pm. Ring #2 and I will come down.', delivery: 0,
    permit: ['CA', 'CFO-39182', '2027-12-31'],
    dishes: [
      ['Pork red chile tamales (3 pack)', 'Tamales', 1450, '20–25 min', 'Authentic Recipe', 'Tender shredded pork in guajillo chile sauce, wrapped in soft masa and steamed in corn husks.', img('photo-1628102491629-778571d893a3')],
      ['Sweet corn & green chile tamales (3 pack)', 'Tamales', 1350, '20 min', 'Vegetarian', 'Fresh sweet corn with roasted poblano and melted Oaxaca cheese.', img('photo-1541832676-9b763b0239ab')]
    ]
  },
  {
    email: 'marco@chefy.test', name: 'Marco Rivera', kitchen: "Marco's Birria", cuisine: 'Jalisco-style birria',
    bio: 'Beef marinated for 24 hours and slow-cooked overnight. Tortillas pressed fresh for every order.',
    avatar: img('photo-1583394838336-acd977736f90'), cover: img('photo-1551504734-5ee1c4a1479b'),
    address: 'Valencia St & 20th St, San Francisco', notes: 'Pickup 5–8pm at the side gate.', delivery: 1,
    permit: ['CA', 'FHC-88129', '2027-06-30'],
    dishes: [
      ['Birria quesatacos trio with consommé', 'Tacos', 1600, '15–20 min', '', 'Three crispy cheese tacos stuffed with birria, served with rich consommé for dipping.', img('photo-1565299585323-38d6b0865b47')]
    ]
  },
  {
    email: 'sarah@chefy.test', name: 'Sarah Jenkins', kitchen: "Sarah's Sweet Oven", cuisine: 'Small-batch baking',
    bio: 'Organic butter and farm eggs. Cookies go in the oven when your order comes in.',
    avatar: img('photo-1581299894007-aaa50297cf16'), cover: img('photo-1499636136210-6f4ee915583e'),
    address: 'Dolores St & 18th St, San Francisco', notes: 'Pickup from the porch box; I will text you the code.', delivery: 0,
    permit: ['CA', 'CFO-77310', '2028-03-31'],
    dishes: [
      ['Brown butter chocolate chip cookies (6 pack)', 'Bakery', 1200, '15 min', 'Organic', 'Crispy edges, gooey centers and a pinch of sea salt. Baked fresh for your order.', img('photo-1499636136210-6f4ee915583e')]
    ]
  }
];

tx(() => {
  for (const c of cooks) {
    const u = run('INSERT INTO users (email, name, password_hash, neighborhood, created_at) VALUES (?, ?, ?, ?, ?)',
      c.email, c.name, hashPassword(PASSWORD), 'Mission District', now);
    const id = Number(u.lastInsertRowid);
    run(`INSERT INTO chefs (user_id, kitchen_name, bio, cuisine, neighborhood, pickup_address, pickup_notes, avatar_url, cover_url,
         offers_delivery, permit_state, permit_number, permit_expiry, permit_status, payout_bank_label, created_at)
         VALUES (?, ?, ?, ?, 'Mission District', ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, ?)`,
      id, c.kitchen, c.bio, c.cuisine, c.address, c.notes, c.avatar, c.cover, c.delivery, ...c.permit,
      pay.MODE === 'demo' ? 'Demo checking •••• 6789' : null, now);
    for (const d of c.dishes) {
      run(`INSERT INTO dishes (chef_id, title, category, price_cents, prep_time, dietary, description, image_url, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, ...d, now);
    }
  }
  run('INSERT INTO users (email, name, password_hash, neighborhood, created_at) VALUES (?, ?, ?, ?, ?)',
    'alex@chefy.test', 'Alex Rivera', hashPassword(PASSWORD), 'Mission District', now);
  run('INSERT INTO users (email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, 1, ?)',
    'admin@chefy.test', 'Chefy Admin', hashPassword(PASSWORD), now);
});

console.log(`Seeded demo data. Every demo account uses the password: ${PASSWORD}
  Customer: alex@chefy.test
  Cooks:    maria@chefy.test, marco@chefy.test, sarah@chefy.test
  Admin:    admin@chefy.test`);
if (pay.MODE === 'stripe') {
  console.log('\nNote: Stripe is configured, so these demo cooks can\'t take orders until each finishes Stripe payout setup.');
}
