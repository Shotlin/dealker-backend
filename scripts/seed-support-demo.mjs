/**
 * Demo support conversations + team agents. Idempotent (skips if tickets exist).
 * Run: docker compose exec api node scripts/seed-support-demo.mjs
 */
import 'dotenv/config'
import pg from 'pg'
import bcrypt from 'bcrypt'

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
})
let seed = 77
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
const pick = (a) => a[Math.floor(rnd() * a.length)]
const ago = (mins) => new Date(Date.now() - mins * 60000)

const SCRIPTS = {
  RETURN_REFUND: [
    ['The {product} I received is damaged — the box was torn and the item has a crack. I want to return it.', 'Hi {name}, I\'m sorry about that. Could you share a photo of the product and the packaging?', 'Sure, sending now. Please check the attached photos.', 'Thanks, I can see the damage. I\'ve approved the return — pickup will be scheduled within 2 working days.'],
    ['I raised a return request 3 days ago but nothing has happened. When will I get my refund?', 'Hello {name}, I\'m checking the status of your return right now.', 'Your pickup was completed yesterday. Refunds are processed within 5–7 working days after quality check.'],
    ['Wrong item delivered. I ordered {product} but got something else.', 'So sorry for the mix-up {name}! I\'ve informed the seller and will arrange a replacement or refund — which would you prefer?', 'Refund to my wallet please.'],
  ],
  DELIVERY: [
    ['My order has not arrived yet and the tracking has not updated for 2 days.', 'Hi {name}, thanks for flagging this. I\'m checking with the courier partner.', 'Courier confirms the parcel is at the destination hub and will be delivered tomorrow.'],
    ['Can I change the delivery address for my order?', 'Hi {name}, the order is already dispatched so the address cannot be changed, but I can ask the courier to hold it for pickup if you like.'],
  ],
  PAYMENT: [
    ['Money got deducted from my account but the order shows payment pending.', 'Hi {name}, I\'ve found the transaction. It will be reconciled automatically — if the order isn\'t confirmed in 24h it is refunded to your account.'],
    ['I want to use a coupon FESTIVE200 but it says not applicable.', 'Hello {name}, FESTIVE200 needs a cart value above ₹1,999. Adding one more item should unlock it.'],
  ],
  PRODUCT: [
    ['Does the {product} come with a manufacturer warranty? I could not find it on the page.', 'Hi {name}, yes — it carries a 1-year brand warranty. The seller will include the warranty card in the box.'],
    ['Is the {product} original? Please confirm authenticity.', 'Hello {name}! All products on Dealker are sold by verified sellers and carry a brand invoice with GST.'],
  ],
  ACCOUNT: [
    ['I am unable to log in with my phone number, OTP is not coming.', 'Hi {name}, I\'ve refreshed your OTP session. Please try again in a minute.', 'It worked, thank you!'],
  ],
  ORDER: [
    ['I want to cancel my order, I ordered by mistake.', 'Hi {name}, I\'ve cancelled order {order} for you. The refund will reach your account in 5–7 days.'],
    ['Please share the GST invoice for my order.', 'Hello {name}, the invoice is attached to your order page under "Download invoice". I\'ve also emailed it to you.'],
  ],
  SELLER: [
    ['The seller is not responding to my queries about the product specifications.', 'Hi {name}, I\'ve escalated this to the seller. You should hear back within 24 hours.'],
  ],
}
const INTERNAL = ['Checked with logistics — parcel stuck at hub.', 'Customer has had 2 returns this month, approve but monitor.', 'Seller confirmed stock mismatch. Escalated to vendor manager.', 'Refund approved by finance; waiting for payout cycle.']

async function main() {
  const c = await pool.connect()
  try {
    const ex = await c.query(`SELECT COUNT(*)::int n FROM support_tickets`)
    if (ex.rows[0].n > 0) { console.log('Support demo data already present.'); return }
    await c.query('BEGIN')

    const role = (await c.query(`SELECT id FROM roles WHERE name='Support Agent' LIMIT 1`)).rows[0]?.id ?? null
    const hash = await bcrypt.hash('Agent@12345', 12)
    const agents = []
    for (const [i, [name, email]] of [['Riya Support', 'riya@dealker.local'], ['Karan Menon', 'karan@dealker.local'], ['Neha Kapoor', 'neha@dealker.local']].entries()) {
      const { rows } = await c.query(
        `INSERT INTO users (phone,email,name,role,role_id,platform_role,password_hash,is_active,is_blocked)
         VALUES ($1,$2,$3,'ADMIN',$4,'HQ_SUPPORT',$5,true,false)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [`90000001${String(i + 1).padStart(2, '0')}`, email, name, role, hash])
      agents.push(rows[0].id)
    }
    const admins = [...agents, ...(await c.query(`SELECT id FROM users WHERE email IN ('superadmin@dealker.local','demo@dealker.local')`)).rows.map((r) => r.id)]

    const orders = (await c.query(
      `SELECT o.id, o.order_number, o.customer_id, u.name AS cname, (o.items->0->>'name') AS product
         FROM orders o JOIN users u ON u.id = o.customer_id ORDER BY o.created_at DESC LIMIT 120`)).rows
    const refunds = (await c.query(`SELECT id, order_id, customer_id FROM refund_requests ORDER BY created_at DESC`)).rows
    let n = 1000
    const fill = (s, ctx) => s.replace(/\{name\}/g, ctx.name.split(' ')[0]).replace(/\{product\}/g, ctx.product || 'product').replace(/\{order\}/g, ctx.order)
    const cats = Object.keys(SCRIPTS)

    const total = 34
    for (let i = 0; i < total; i++) {
      const linkedRefund = i < 12 ? refunds[i] : null
      const order = linkedRefund ? orders.find((o) => o.id === linkedRefund.order_id) || pick(orders) : pick(orders)
      const category = linkedRefund ? 'RETURN_REFUND' : pick(cats)
      const script = pick(SCRIPTS[category])
      const ctx = { name: order.cname, product: order.product, order: order.order_number }
      const startMins = Math.floor(rnd() * 60 * 24 * 12) + 20 // up to ~12 days ago
      const fresh = i >= total - 8 // newest, unanswered/unassigned
      const resolved = !fresh && rnd() < 0.35
      const assigned = fresh ? (rnd() < 0.4 ? pick(admins) : null) : pick(admins)
      const msgsToUse = fresh ? 1 : Math.min(script.length, 1 + Math.floor(rnd() * script.length) + 1)
      const priority = category === 'PAYMENT' || (linkedRefund && rnd() < 0.3) ? pick(['HIGH', 'URGENT']) : pick(['NORMAL', 'NORMAL', 'LOW', 'HIGH'])
      const status = fresh ? (assigned ? 'ASSIGNED' : 'OPEN') : resolved ? pick(['RESOLVED', 'CLOSED']) : msgsToUse > 1 ? 'IN_PROGRESS' : 'ASSIGNED'
      const startAt = ago(fresh ? Math.floor(rnd() * 600) + 5 : startMins)
      const subject = fill({
        RETURN_REFUND: 'Return / refund for order {order}', DELIVERY: 'Where is my order {order}?', PAYMENT: 'Payment issue — order {order}',
        PRODUCT: 'Question about {product}', ACCOUNT: 'Unable to log in', ORDER: 'Help with order {order}', SELLER: 'Seller not responding',
      }[category], ctx)

      const t = await c.query(
        `INSERT INTO support_tickets (ticket_number,user_id,subject,description,status,category,priority,order_id,refund_request_id,channel,assigned_to,assigned_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'APP',$10,$11,$12,$12) RETURNING id`,
        [`TKT-${++n}`, order.customer_id, subject, fill(script[0], ctx), status, category, priority, category === 'ACCOUNT' ? null : order.id,
          linkedRefund?.id ?? null, assigned, assigned ? new Date(startAt.getTime() + 120000) : null, startAt])
      const id = t.rows[0].id
      await c.query(`INSERT INTO support_ticket_events (ticket_id,type,actor_id,created_at) VALUES ($1,'CREATED',$2,$3)`, [id, order.customer_id, startAt])
      if (assigned) await c.query(`INSERT INTO support_ticket_events (ticket_id,type,actor_id,to_value,created_at) VALUES ($1,'ASSIGNED',$2,$3,$4)`, [id, pick(admins), assigned, new Date(startAt.getTime() + 120000)])

      let at = startAt; let lastBody = ''; let lastType = 'CUSTOMER'; let firstResponse = null; let unreadAgent = 0
      for (let m = 0; m < msgsToUse; m++) {
        const fromCustomer = m % 2 === 0
        const body = fill(script[m], ctx)
        await c.query(`INSERT INTO support_messages (ticket_id,sender_type,sender_id,body,created_at) VALUES ($1,$2,$3,$4,$5)`,
          [id, fromCustomer ? 'CUSTOMER' : 'AGENT', fromCustomer ? order.customer_id : (assigned || pick(agents)), body, at])
        if (!fromCustomer && !firstResponse) firstResponse = at
        lastBody = body; lastType = fromCustomer ? 'CUSTOMER' : 'AGENT'
        if (m === 1 && rnd() < 0.5) {
          await c.query(`INSERT INTO support_messages (ticket_id,sender_type,sender_id,body,is_internal,created_at) VALUES ($1,'AGENT',$2,$3,true,$4)`,
            [id, assigned || pick(agents), pick(INTERNAL), new Date(at.getTime() + 60000)])
        }
        at = new Date(at.getTime() + (5 + Math.floor(rnd() * 90)) * 60000)
        if (at > new Date()) at = new Date()
      }
      if (lastType === 'CUSTOMER' && !['RESOLVED', 'CLOSED'].includes(status)) unreadAgent = 1 + Math.floor(rnd() * 2)
      const lastAt = new Date(Math.min(at.getTime(), Date.now()))
      await c.query(
        `UPDATE support_tickets SET last_message_at=$2,last_message_preview=$3,last_sender_type=$4,agent_unread=$5,first_response_at=$6,resolved_at=$7 WHERE id=$1`,
        [id, lastAt, lastBody.slice(0, 140), lastType, unreadAgent, firstResponse, ['RESOLVED', 'CLOSED'].includes(status) ? lastAt : null])
      if (status === 'IN_PROGRESS') await c.query(`INSERT INTO support_ticket_events (ticket_id,type,actor_id,from_value,to_value,created_at) VALUES ($1,'STATUS',$2,'ASSIGNED','IN_PROGRESS',$3)`, [id, assigned, lastAt])
    }
    await c.query('COMMIT')
    console.log(`✅ Support demo ready: ${total} conversations, 3 agents (password Agent@12345)`)
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    console.error('Seed failed:', e.message); process.exitCode = 1
  } finally { c.release(); await pool.end() }
}
main()
