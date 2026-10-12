import PDFDocument from 'pdfkit';
import { readFileSync } from 'node:fs';
const LOGO = readFileSync(new URL('../assets/fc-logo-black.png', import.meta.url));
import { requireRole, audit } from './auth.mjs';
import { httpError, tx, todayIso, str } from './biz.mjs';

const pence = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1000000000) throw httpError(400, 'Enter a valid non-negative price.');
  return Math.round(n * 100);
};
const gbp = (p) => `£${(Number(p || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ukDate = (v) => new Date(`${String(v).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const iso = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
function cleanLines(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 50) throw httpError(400, 'Add between 1 and 50 invoice lines.');
  return raw.map((r, i) => {
    const description = str(r.description, 300);
    const quantity = Number(r.quantity ?? 1), unit = pence(r.unit_price);
    if (!description || !Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) throw httpError(400, 'Each line needs a description and valid quantity.');
    const qtyMilli = Math.round(quantity * 1000);
    const total = Math.round(unit * qtyMilli / 1000);
    return { position: i + 1, description, quantity: qtyMilli / 1000, unit_price_pence: unit, line_total_pence: total };
  });
}
function totals(lines, rate) {
  const subtotal = lines.reduce((s, l) => s + l.line_total_pence, 0);
  const vat = Math.round(subtotal * rate / 10000);
  return { subtotal, vat, total: subtotal + vat };
}
async function nextInvoiceNumber(db, contactId) {
  await db.query("select pg_advisory_xact_lock(hashtext('fc-crm-invoice-number'))");
  const { rows: [c] } = await db.query('select business from contacts where id=$1', [contactId]);
  if (!c) throw httpError(404, 'Customer not found.');
  const initials = String(c.business || 'CUS').replace(/\b(ltd|limited|the|and|of|llp|plc)\b/gi, ' ').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0,3).map(w=>w[0].toUpperCase()).join('') || 'CUS';
  const { rows } = await db.query('select number from invoices where number like $1', [`INV-%-${initials}`]);
  const max = rows.reduce((m, r) => Math.max(m, Number((r.number.match(/^INV-(\d+)/)||[])[1]) || 0), 0);
  return `INV-${String(max + 1).padStart(3,'0')}-${initials}`;
}
function pdfBuffer(inv, lines, payments) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Invoice ${inv.number}`, Author: inv.snapshot?.company?.name || 'FC Cleaning Company Ltd' } });
    const chunks=[]; doc.on('data', c=>chunks.push(c)); doc.on('end',()=>resolve(Buffer.concat(chunks))); doc.on('error',reject);
    const company = inv.snapshot?.company || {}, customer = inv.snapshot?.customer || {};
    const left=48, right=547;
    doc.image(LOGO, right - 64, 14, { height: 64 });
    doc.fillColor('#111827').font('Helvetica-Bold').fontSize(23).text('INVOICE', left, 42);
    doc.font('Helvetica-Bold').fontSize(11).text(company.name || 'FC Cleaning Company Ltd', left, 83);
    doc.font('Helvetica').fontSize(9).fillColor('#374151');
    doc.text(company.address || '', left, 100, { width: 290 });
    doc.text(company.email || '', left, doc.y + 3); doc.text(company.phone || '', left, doc.y + 2); doc.text(company.vat_number ? `VAT number: ${company.vat_number}` : '', left, doc.y + 2);
    doc.fillColor('#111827').font('Helvetica-Bold').fontSize(9).text(`Invoice no.: ${inv.number}`, 365, 84, { width: 182, align: 'right' });
    doc.font('Helvetica').text(`Date: ${ukDate(inv.issue_date)}`, 365, 102, { width:182, align:'right' });
    doc.text(`Due date: ${ukDate(inv.due_date)}`, 365, 117, { width:182, align:'right' });
    doc.moveTo(left, 151).lineTo(right,151).strokeColor('#d1d5db').stroke();
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text('Bill to:', left, 166);
    doc.font('Helvetica-Bold').fontSize(10).text(customer.business || '', left, 183);
    doc.font('Helvetica').fontSize(9).fillColor('#374151').text(customer.address || '', left, 198, { width: 330 });
    if (customer.attention) doc.text(`Attn: ${customer.attention}`, left, doc.y + 2);
    let y = Math.max(doc.y + 24, 244);
    doc.rect(left,y,right-left,23).fill('#f3f4f6'); doc.fillColor('#111827').font('Helvetica-Bold').fontSize(9);
    doc.text('#',left+8,y+7,{width:20}); doc.text('Item',left+34,y+7,{width:270}); doc.text('Qty',310,y+7,{width:45,align:'right'}); doc.text('Unit cost',365,y+7,{width:75,align:'right'}); doc.text('Total',455,y+7,{width:82,align:'right'}); y+=30;
    doc.font('Helvetica').fontSize(9).fillColor('#1f2937');
    for (const [i,l] of lines.entries()) {
      if (y > 675) { doc.addPage(); y=55; }
      doc.text(String(i+1),left+8,y,{width:20}); doc.text(l.description,left+34,y,{width:260}); doc.text(String(Number(l.quantity)),310,y,{width:45,align:'right'}); doc.text(gbp(l.unit_price_pence),365,y,{width:75,align:'right'}); doc.text(gbp(l.line_total_pence),455,y,{width:82,align:'right'});
      y=Math.max(y+23,doc.y+8); doc.moveTo(left,y-5).lineTo(right,y-5).strokeColor('#e5e7eb').stroke();
    }
    y += 10; const summary = [['Subtotal',gbp(inv.subtotal_pence)], [`VAT (${(inv.vat_rate_bp/100).toFixed(inv.vat_rate_bp%100 ? 2 : 0)}%)`,gbp(inv.vat_pence)], ['Total due',gbp(inv.total_pence)]];
    for (const [label,value] of summary) { doc.font(label==='Total due'?'Helvetica-Bold':'Helvetica').fontSize(label==='Total due'?11:9).fillColor('#111827').text(label,350,y,{width:95,align:'right'}).text(value,455,y,{width:82,align:'right'}); y+=19; }
    if (inv.contract_total_pence != null) { y+=5; doc.font('Helvetica-Bold').fontSize(9).text('Total contract value (incl. VAT)',320,y,{width:125,align:'right'}).font('Helvetica').text(gbp(inv.contract_total_pence),455,y,{width:82,align:'right'}); y+=17; }
    if (inv.deposit_pence != null) { doc.font('Helvetica').fontSize(9).text('Deposit / upfront payment (incl. VAT)',300,y,{width:145,align:'right'}).text(gbp(inv.deposit_pence),455,y,{width:82,align:'right'}); y+=17; }
    const paid = payments.reduce((s,p)=>s+Number(p.amount_pence),0);
    // only once money has come in: a fresh invoice just shows Total due
    if (paid > 0) {
      doc.font('Helvetica').fontSize(9).text('Payments received',350,y,{width:95,align:'right'}).text(gbp(paid),455,y,{width:82,align:'right'}); y+=17;
      doc.font('Helvetica-Bold').text('Balance outstanding',330,y,{width:115,align:'right'}).text(gbp(Math.max(0,Number(inv.total_pence)-paid)),455,y,{width:82,align:'right'}); y+=17;
    }
    y+=17;
    if (y > 690) { doc.addPage(); y=55; }
    doc.moveTo(left,y).lineTo(right,y).strokeColor('#d1d5db').stroke(); y+=12;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#111827').text('Payment information',left,y); y+=15;
    doc.font('Helvetica').fontSize(9).fillColor('#374151');
    doc.text(`Account Name: ${company.account_name || company.name || 'FC Cleaning Company Ltd'}`,left,y); y+=13;
    if(company.account_number) { doc.text(`Account Number: ${company.account_number}`,left,y); y+=13; }
    if(company.sort_code) { doc.text(`Sort Code: ${company.sort_code}`,left,y); y+=13; }
    if(inv.customer_note) { y+=8; doc.font('Helvetica-Bold').fillColor('#111827').text('Customer note',left,y); y+=14; doc.font('Helvetica').fillColor('#374151').text(inv.customer_note,left,y,{width:right-left}); y=doc.y+10; }
    if(inv.terms) { y+=8; doc.font('Helvetica-Bold').fillColor('#111827').text('Terms & conditions',left,y); y+=14; doc.font('Helvetica').fillColor('#374151').text(inv.terms,left,y,{width:right-left,lineGap:2}); }
    doc.end();
  });
}
export function invoiceRoutes(app, pool) {
  app.get('/api/invoices', requireRole('manager'), async (req,res) => {
    const {rows}=await pool.query(`select i.id,i.number,i.status,i.issue_date,i.due_date,i.total_pence,i.vat_pence,i.subtotal_pence,coalesce(sum(p.amount_pence),0)::bigint paid_pence,c.business from invoices i join contacts c on c.id=i.contact_id left join invoice_payments p on p.invoice_id=i.id group by i.id,c.business order by i.created_at desc limit 500`);
    res.json(rows.map(r=>({...r, balance_pence:Math.max(0,Number(r.total_pence)-Number(r.paid_pence))})));
  });
  app.get('/api/invoices/:id', requireRole('manager'), async(req,res)=>{
    const {rows:[invoice]}=await pool.query('select * from invoices where id=$1',[req.params.id]); if(!invoice) throw httpError(404,'Invoice not found.');
    const [{rows:lines},{rows:payments}]=await Promise.all([pool.query('select * from invoice_lines where invoice_id=$1 order by position',[invoice.id]),pool.query('select * from invoice_payments where invoice_id=$1 order by paid_on,created_at',[invoice.id])]);
    res.json({...invoice,lines,payments,paid_pence:payments.reduce((s,p)=>s+Number(p.amount_pence),0)});
  });
  const validate=(b)=>{ if(!b.contact_id) throw httpError(400,'Choose a customer.');
    if(!iso(b.issue_date)||!iso(b.due_date)||b.due_date < b.issue_date) throw httpError(400,'Enter valid issue and due dates; the due date cannot precede the issue date.');
    const rate=Number(b.vat_rate_bp ?? 2000); if(!Number.isInteger(rate)||rate<0||rate>10000) throw httpError(400,'Choose a valid VAT rate.');
    const lines=cleanLines(b.lines), sum=totals(lines,rate), contract=b.contract_total===''||b.contract_total==null?null:pence(b.contract_total), deposit=b.deposit===''||b.deposit==null?null:pence(b.deposit);
    if(contract!=null&&contract<sum.total) throw httpError(400,'Total contract value cannot be less than this invoice total.');
    return {rate,lines,sum,contract,deposit};
  };
  app.post('/api/invoices', requireRole('manager'), async(req,res)=>{
    const b=req.body||{}, {rate,lines,sum,contract,deposit}=validate(b);
    const invoice=await tx(pool,async db=>{
      const {rows:[c]}=await db.query('select * from contacts where id=$1 and archived_at is null',[b.contact_id]); if(!c) throw httpError(404,'Active customer not found.');
      const number=await nextInvoiceNumber(db,b.contact_id);
      const {rows:[companyRow]}=await db.query("select v from meta where k='company'");
      const company=companyRow?.v||{};
      const snapshot={company:{name:company.name||'FC Cleaning Company Ltd',address:company.address||'57 St. Davids Crescent, Aspull, Wigan WN2 1SZ, United Kingdom',email:company.email||'fernando.c@fccleaningcompany.com',phone:company.phone||'+44 161 399 0482',vat_number:company.vat_number||'517 4596 68',account_name:company.account_name||'FC Cleaning Company Ltd',account_number:company.account_number||'30797784',sort_code:company.sort_code||'04-06-05'},customer:{business:c.business||c.contact_name||'Customer',address:c.billing_address||c.address||'',attention:c.contact_name||''}};
      const {rows:[inv]}=await db.query(`insert into invoices(contact_id,number,status,issue_date,due_date,vat_rate_bp,subtotal_pence,vat_pence,total_pence,contract_total_pence,deposit_pence,customer_note,terms,snapshot,created_by) values($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,[c.id,number,b.issue_date,b.due_date,rate,sum.subtotal,sum.vat,sum.total,contract,deposit,str(b.customer_note,2000),str(b.terms,5000),snapshot,req.user.id]);
      for(const l of lines) await db.query('insert into invoice_lines(invoice_id,position,description,quantity,unit_price_pence,line_total_pence) values($1,$2,$3,$4,$5,$6)',[inv.id,l.position,l.description,l.quantity,l.unit_price_pence,l.line_total_pence]);
      await audit(db,req,'invoice_created','invoice',inv.id,{number:inv.number,total_pence:sum.total}); return inv;
    }); res.status(201).json(invoice);
  });
  // drafts only: issued invoices are what the customer received and never change
  app.put('/api/invoices/:id', requireRole('manager'), async(req,res)=>{
    const b=req.body||{}, {rate,lines,sum,contract,deposit}=validate(b);
    const invoice=await tx(pool,async db=>{
      const {rows:[i]}=await db.query('select * from invoices where id=$1 for update',[req.params.id]); if(!i) throw httpError(404,'Invoice not found.');
      if(i.status!=='draft') throw httpError(409,'Only draft invoices can be edited.');
      const {rows:[c]}=await db.query('select * from contacts where id=$1 and archived_at is null',[b.contact_id]); if(!c) throw httpError(404,'Active customer not found.');
      const snapshot={...i.snapshot,customer:{business:c.business||c.contact_name||'Customer',address:c.billing_address||c.address||'',attention:c.contact_name||''}};
      const {rows:[inv]}=await db.query(`update invoices set contact_id=$2,issue_date=$3,due_date=$4,vat_rate_bp=$5,subtotal_pence=$6,vat_pence=$7,total_pence=$8,contract_total_pence=$9,deposit_pence=$10,customer_note=$11,terms=$12,snapshot=$13,updated_at=now() where id=$1 returning *`,
        [i.id,c.id,b.issue_date,b.due_date,rate,sum.subtotal,sum.vat,sum.total,contract,deposit,str(b.customer_note,2000),str(b.terms,5000),snapshot]);
      await db.query('delete from invoice_lines where invoice_id=$1',[i.id]);
      for(const l of lines) await db.query('insert into invoice_lines(invoice_id,position,description,quantity,unit_price_pence,line_total_pence) values($1,$2,$3,$4,$5,$6)',[i.id,l.position,l.description,l.quantity,l.unit_price_pence,l.line_total_pence]);
      await audit(db,req,'invoice_updated','invoice',i.id,{number:i.number,total_pence:sum.total}); return inv;
    }); res.json(invoice);
  });
  app.post('/api/invoices/:id/issue',requireRole('manager'),async(req,res)=>{
    const result=await tx(pool,async db=>{const {rows:[i]}=await db.query("select * from invoices where id=$1 for update",[req.params.id]);if(!i)throw httpError(404,'Invoice not found.');if(i.status!=='draft')throw httpError(409,'Only draft invoices can be issued.');const {rows:[r]}=await db.query("update invoices set status='issued',issued_at=now(),updated_at=now() where id=$1 returning *",[i.id]);await audit(db,req,'invoice_issued','invoice',i.id,{number:i.number});return r;});res.json(result);
  });
  app.post('/api/invoices/:id/payments',requireRole('manager'),async(req,res)=>{
    const amount=pence(req.body.amount);if(amount<=0)throw httpError(400,'Payment must be greater than zero.');
    const result=await tx(pool,async db=>{const {rows:[i]}=await db.query('select * from invoices where id=$1 for update',[req.params.id]);if(!i)throw httpError(404,'Invoice not found.');if(!['issued','part_paid'].includes(i.status))throw httpError(409,'Payments can only be recorded on issued invoices.');const {rows:[s]}=await db.query('select coalesce(sum(amount_pence),0)::bigint paid from invoice_payments where invoice_id=$1',[i.id]);if(Number(s.paid)+amount>Number(i.total_pence))throw httpError(400,'Payment exceeds the outstanding balance.');const {rows:[p]}=await db.query('insert into invoice_payments(invoice_id,amount_pence,paid_on,reference,created_by) values($1,$2,$3,$4,$5) returning *',[i.id,amount,iso(req.body.paid_on)?req.body.paid_on:todayIso(),str(req.body.reference,200),req.user.id]);const paid=Number(s.paid)+amount;await db.query('update invoices set status=$2,updated_at=now() where id=$1',[i.id,paid===Number(i.total_pence)?'paid':'part_paid']);await audit(db,req,'invoice_payment_recorded','invoice',i.id,{amount_pence:amount});return p;});res.status(201).json(result);
  });
  // only unsent drafts can be deleted; issued invoices stay on record
  app.delete('/api/invoices/:id',requireRole('manager'),async(req,res)=>{
    const {rows:[i]}=await pool.query("delete from invoices where id=$1 and status='draft' returning number",[req.params.id]);
    if(!i) throw httpError(409,'Only draft invoices can be deleted.');
    await audit(pool,req,'invoice_deleted','invoice',req.params.id,{number:i.number}); res.status(204).end();
  });
  app.get('/api/invoices/:id/pdf',requireRole('manager'),async(req,res)=>{
    const {rows:[i]}=await pool.query('select * from invoices where id=$1',[req.params.id]);if(!i)throw httpError(404,'Invoice not found.');
    const [{rows:lines},{rows:payments}]=await Promise.all([pool.query('select * from invoice_lines where invoice_id=$1 order by position',[i.id]),pool.query('select * from invoice_payments where invoice_id=$1 order by paid_on',[i.id])]);
    const pdf=await pdfBuffer(i,lines,payments);res.set({'Content-Type':'application/pdf','Content-Disposition':`${req.query.download?'attachment':'inline'}; filename="${i.number}.pdf"`,'Cache-Control':'private, no-store'}).send(pdf);
  });
}
