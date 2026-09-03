/**
 * Seeds a realistic FMCG distribution ledger: 6 salesmen, ~45 shops,
 * ~10 days of bills, collections across all four modes, plus a deliberate
 * scattering of shortages, cancellations and unsettled variance — so the
 * reconciliation strip has something truthful to say.
 *
 * Usage: node server/seed.js --force
 */
import { pool } from './db.js';
import { hashPassword } from './auth.js';
import { todayISO, isoDaysAgo } from './dates.js';

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260902);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (a, b) => a + rand() * (b - a);
const money = (n) => Math.round(n * 100) / 100;

const SALESMEN = [
  { code: 'SLM-01', name: 'Ramesh Yadav', phone: '98260 11234', areas: ['Vijay Nagar', 'Khajrana', 'Nipania'] },
  { code: 'SLM-02', name: 'Suresh Patil', phone: '98260 22345', areas: ['Palasia', 'AB Road', 'Bengali Square'] },
  { code: 'SLM-03', name: 'Anil Sharma', phone: '98260 33456', areas: ['Rajwada', 'Sarafa', 'Mahalaxmi Nagar'] },
  { code: 'SLM-04', name: 'Vikram Chouhan', phone: '98260 44567', areas: ['Rau', 'Nipania', 'AB Road'] },
  { code: 'SLM-05', name: 'Imran Qureshi', phone: '98260 55678', areas: ['Khajrana', 'Vijay Nagar', 'Palasia'] },
  { code: 'SLM-06', name: 'Deepak Verma', phone: '98260 66789', areas: ['Bengali Square', 'Mahalaxmi Nagar', 'Rau'] },
];

const SHOP_STEMS = [
  'Sharma General Store', 'Gupta Kirana', 'Mahalaxmi Provision', 'Pooja Traders', 'Annapurna Stores',
  'Sai Baba Mart', 'Kohinoor Departmental', 'Patil Provisions', 'New Krishna Store', 'City Mart',
  'Rajeshwari Kirana', 'Bhagwati Traders', 'Om Sai Superette', 'Verma General Store', 'Jain Provision House',
  'Shiv Shakti Store', 'Ganesh Kirana Mart', 'Awadh Traders', 'Narmada Stores', 'Sudarshan Provision',
  'Balaji Mini Mart', 'Kaveri Traders', 'Sarvodaya Store', 'Ratlamwala Kirana', 'Chouhan Provisions',
  'Laxmi Narayan Mart', 'Malwa Stores', 'Indore Bazaar', 'Sanchi Kirana', 'Vasudev Traders',
];

const PRODUCTS = [
  ['Fortune Sunlite Oil 1L', 148], ['Aashirvaad Atta 10kg', 462], ['Tata Salt 1kg', 26],
  ['Surf Excel Matic 1kg', 268], ['Colgate Total 100g', 96], ['Maggi Masala 420g', 84],
  ['Amul Butter 500g', 268], ['Britannia Good Day 200g', 45], ['Cadbury Dairy Milk 52g', 50],
  ['Red Label Tea 500g', 295], ['Nescafe Classic 100g', 349], ['Patanjali Dant Kanti 100g', 65],
  ['Rajdhani Besan 1kg', 118], ['Saffola Masala Oats 1kg', 219], ['Vim Bar 500g', 42],
  ['Pril Liquid 500ml', 108], ['Haldiram Bhujia 400g', 175], ['Kissan Ketchup 500g', 129],
  ['Dabur Honey 500g', 299], ['Bournvita 500g', 268],
];

const CANCEL_REASONS = [
  'Shop closed — three visits', 'Order duplicated in batch upload', 'Customer refused delivery',
  'Wrong stock dispatched', 'Shop owner disputed the rate', 'Credit limit crossed',
];
const SHORT_REASONS = [
  'Damaged in transit', 'Short dispatched from godown', 'Leakage in packaging',
  'Near-expiry stock rejected', 'Weight mismatch at delivery', 'Item missing from crate',
];
const BANKS = ['HDFC Bank', 'ICICI Bank', 'State Bank of India', 'Axis Bank', 'Bank of India'];
const DENOMS = [500, 200, 100, 50, 20, 10, 5, 2, 1];

function decompose(amount) {
  let left = Math.round(amount);
  const out = [];
  for (const d of DENOMS) {
    if (left <= 0) break;
    let count = Math.floor(left / d);
    if (count > 0 && d <= 100) {
      const jitter = Math.floor(between(0, Math.min(count, Math.max(1, Math.round(count * 0.18)))));
      count -= jitter;
    }
    if (count > 0) { out.push({ denom: d, count }); left -= count * d; }
  }
  if (left > 0) out.push({ denom: 1, count: left });
  return out;
}

export async function seed({ force = false } = {}) {
  const client = await pool.connect();
  try {
    const { rows: [{ n: existing }] } = await client.query('SELECT COUNT(*)::int AS n FROM bills');
    if (existing > 0 && !force) {
      console.log(`Seed skipped — ${existing} bills already present. Use --force to reseed.`);
      return;
    }

    // Wipe all data in a transaction
    await client.query('BEGIN');
    for (const t of ['sessions', 'cash_denominations', 'collections', 'short_items', 'cancellations', 'bills', 'day_sessions', 'shops', 'products', 'users']) {
      await client.query(`DELETE FROM ${t}`);
    }
    // Reset sequences
    const { rows: tables } = await client.query(`
      SELECT sequencename FROM pg_sequences 
      WHERE schemaname = 'public' AND sequencename LIKE '%_id_seq'`);
    for (const { sequencename } of tables) {
      await client.query(`ALTER SEQUENCE ${sequencename} RESTART WITH 1`);
    }
    await client.query('COMMIT');

    // Insert admin users
    await client.query(
      "INSERT INTO users (code, name, role, phone, password_hash) VALUES ($1,$2,$3,$4,$5)",
      ['admin', 'Neha Kulkarni', 'admin', '98260 00001', hashPassword('admin123')],
    );
    await client.query(
      "INSERT INTO users (code, name, role, phone, password_hash) VALUES ($1,$2,$3,$4,$5)",
      ['ops', 'Back Office', 'admin', '98260 00002', hashPassword('ops123')],
    );

    // Insert salesmen
    const salesmen = [];
    for (const s of SALESMEN) {
      const { rows: [row] } = await client.query(
        "INSERT INTO users (code, name, role, phone, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [s.code, s.name, 'salesman', s.phone, hashPassword('field123')],
      );
      salesmen.push({ ...s, id: row.id });
    }

    // Insert products
    for (const [name, rate] of PRODUCTS) {
      await client.query('INSERT INTO products (name, default_rate) VALUES ($1,$2)', [name, rate]);
    }

    // Insert shops
    const shopsBySalesman = new Map();
    const usedNames = new Set();
    for (const sm of salesmen) {
      const list = [];
      for (let i = 0; i < 8; i++) {
        const area = sm.areas[i % sm.areas.length];
        let stem = SHOP_STEMS[(salesmen.indexOf(sm) * 8 + i) % SHOP_STEMS.length];
        let key = `${stem}|${area}`;
        for (let tries = 0; usedNames.has(key) && tries < SHOP_STEMS.length; tries++) {
          stem = SHOP_STEMS[(salesmen.indexOf(sm) * 8 + i + tries + 1) % SHOP_STEMS.length];
          key = `${stem}|${area}`;
        }
        usedNames.add(key);
        const owner = pick(['R. K. Sharma', 'A. Gupta', 'M. Jain', 'S. Patel', 'V. Chouhan', 'P. Verma', 'I. Khan', 'D. Malviya']);
        const phone = `9${Math.floor(between(100000000, 999999999))}`;
        const { rows: [{ id }] } = await client.query(
          'INSERT INTO shops (name, owner_name, area, phone, salesman_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [stem, owner, area, phone, sm.id],
        );
        list.push({ id, name: stem, area });
      }
      shopsBySalesman.set(sm.id, list);
    }

    let invoiceSeq = 1;
    const today = todayISO();

    await client.query('BEGIN');
    for (let dayOffset = 9; dayOffset >= 0; dayOffset--) {
      const date = isoDaysAgo(dayOffset);
      const isToday = date === today;

      for (const sm of salesmen) {
        if (!isToday && rand() < 0.05) continue;
        const billCount = Math.floor(isToday ? between(6, 9) : between(4, 9));

        for (let b = 0; b < billCount; b++) {
          const shop = pick(shopsBySalesman.get(sm.id));
          const invoiceNo = `INV/${date.slice(0, 4)}/${String(invoiceSeq++).padStart(5, '0')}`;
          const amount = Math.round(between(1200, 48000) / 10) * 10;
          const source = pick(['excel', 'excel', 'manual', 'photo']);

          const { rows: [{ id: billId }] } = await client.query(
            'INSERT INTO bills (invoice_no, shop_id, salesman_id, amount, bill_date, source) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
            [invoiceNo, shop.id, sm.id, amount, date, source],
          );

          // Cancellations
          if (rand() < 0.06) {
            await client.query(
              'INSERT INTO cancellations (bill_id, invoice_no, amount, reason, salesman_id, cancel_date) VALUES ($1,$2,$3,$4,$5,$6)',
              [billId, invoiceNo, amount, pick(CANCEL_REASONS), sm.id, date],
            );
            await client.query("UPDATE bills SET cancelled_at = $1 WHERE id = $2", [`${date} 17:40:00`, billId]);
            continue;
          }

          // Shortages
          let shortTotal = 0;
          if (rand() < 0.16) {
            const lines = rand() < 0.25 ? 2 : 1;
            for (let l = 0; l < lines; l++) {
              const [product, rate] = pick(PRODUCTS);
              const qty = Math.ceil(between(1, 6));
              const amt = money(qty * rate);
              shortTotal = money(shortTotal + amt);
              await client.query(
                'INSERT INTO short_items (bill_id, salesman_id, product, qty, rate, amount, reason, short_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
                [billId, sm.id, product, qty, rate, amt, pick(SHORT_REASONS), date],
              );
            }
          }

          let expected = money(amount - shortTotal);
          const settleChance = isToday ? 0.35 : 0.96;
          if (rand() > settleChance) continue;

          let remaining = expected;
          const modesWanted = [];
          const roll = rand();
          if (roll < 0.60) modesWanted.push('cash');
          else if (roll < 0.75) { modesWanted.push('cash'); modesWanted.push('online'); }
          else if (roll < 0.85) { modesWanted.push('cheque'); modesWanted.push('cash'); }
          else if (roll < 0.93) { modesWanted.push('credit_note'); modesWanted.push('cash'); }
          else modesWanted.push('cheque');

          const shortCollect = rand() < (isToday ? 0.2 : 0.1);
          const shortfall = shortCollect ? Math.round(between(120, Math.max(200, expected * 0.06))) : 0;
          remaining = money(Math.max(0, expected - shortfall));

          for (let mi = 0; mi < modesWanted.length; mi++) {
            const mode = modesWanted[mi];
            const isLast = mi === modesWanted.length - 1;
            let amt;
            if (isLast) amt = Math.round(remaining);
            else if (mode === 'credit_note') amt = money(Math.min(remaining, Math.round(between(150, Math.max(300, expected * 0.18)))));
            else amt = money(Math.round((remaining * between(0.45, 0.7)) / 10) * 10);
            if (mode === 'cash') amt = Math.round(amt);
            amt = money(Math.max(0, Math.min(amt, remaining)));
            if (amt <= 0) continue;
            remaining = money(remaining - amt);

            let refNo = null, bank = null, chequeDate = null, note = null;
            if (mode === 'online') {
              refNo = `UTR${Math.floor(between(1e11, 9e11))}`;
              note = pick(['UPI — GPay', 'UPI — PhonePe', 'NEFT', 'IMPS']);
            } else if (mode === 'cheque') {
              refNo = String(Math.floor(between(100000, 999999)));
              bank = pick(BANKS);
              chequeDate = date;
              note = 'Post-dated by 7 days';
            } else if (mode === 'credit_note') {
              refNo = `CN/${date.slice(0, 4)}/${Math.floor(between(1000, 9999))}`;
              note = pick(['Rate difference', 'Returned empty crates', 'Scheme credit', 'Damaged goods adjustment']);
            }

            const { rows: [{ id: colId }] } = await client.query(
              `INSERT INTO collections (bill_id, salesman_id, mode, amount, ref_no, bank, cheque_date, note, collection_date)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
              [billId, sm.id, mode, amt, refNo, bank, chequeDate, note, date],
            );
            if (mode === 'cash') {
              for (const d of decompose(amt)) {
                await client.query('INSERT INTO cash_denominations (collection_id, denom, count) VALUES ($1,$2,$3)', [colId, d.denom, d.count]);
              }
            }
          }
        }

        // Day sessions
        if (!isToday) {
          await client.query(
            'INSERT INTO day_sessions (salesman_id, work_date, started_at, ended_at) VALUES ($1,$2,$3,$4)',
            [sm.id, date, `${date} 09:05:00`, `${date} 19:20:00`],
          );
        } else if (rand() < 0.8) {
          await client.query(
            "INSERT INTO day_sessions (salesman_id, work_date, started_at) VALUES ($1,$2,$3)",
            [sm.id, date, `${date} 09:10:00`],
          );
        }
      }
    }
    await client.query('COMMIT');

    const { rows: [{ n: bills }] } = await client.query('SELECT COUNT(*)::int AS n FROM bills');
    const { rows: [{ n: cols }] } = await client.query('SELECT COUNT(*)::int AS n FROM collections');
    const { rows: [{ n: shorts }] } = await client.query('SELECT COUNT(*)::int AS n FROM short_items');
    const { rows: [{ n: cancels }] } = await client.query('SELECT COUNT(*)::int AS n FROM cancellations');
    const { rows: [{ n: shops }] } = await client.query('SELECT COUNT(*)::int AS n FROM shops');
    console.log(`Seeded: ${bills} bills · ${cols} collection entries · ${shorts} shortage lines · ${cancels} cancellations · ${shops} shops`);
    console.log('Logins → admin / admin123 · ops / ops123 · SLM-01 … SLM-06 / field123');
  } finally {
    client.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed({ force: process.argv.includes('--force') }).catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}
