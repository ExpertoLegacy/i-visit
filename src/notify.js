import process from 'node:process';
import { db, now, addEvent } from './db.js';

const TIMEOUT_MS = 10000;

export const smsConfigured = () => Boolean(process.env.SMS_URL);

/** Posts one message to the SMS gateway described by the SMS_* settings. Throws when it is refused. */
async function postToGateway(phone, message) {
  const fields = {
    ...Object.fromEntries(new URLSearchParams(process.env.SMS_EXTRA || '')),
    [process.env.SMS_TO_FIELD || 'to']: phone,
    [process.env.SMS_MESSAGE_FIELD || 'message']: message,
  };
  const isForm = process.env.SMS_FORMAT === 'form';
  const headers = { 'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json' };
  if (process.env.SMS_AUTH_HEADER) headers.Authorization = process.env.SMS_AUTH_HEADER;
  const response = await fetch(process.env.SMS_URL, {
    method: 'POST',
    headers,
    body: isForm ? new URLSearchParams(fields) : JSON.stringify(fields),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Gateway answered with status ${response.status}`);
}

/** Sends a message and records the outcome. Never throws; failures are returned and logged. */
export async function sendSms({ visitId = null, recipient = null, phone, message }) {
  const id = Number(
    db
      .prepare("INSERT INTO notifications (visit_id, recipient, phone, message, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
      .run(visitId, recipient, phone, message, now()).lastInsertRowid,
  );
  try {
    await postToGateway(phone, message);
    db.prepare("UPDATE notifications SET status = 'sent', sent_at = ? WHERE id = ?").run(now(), id);
    return { ok: true };
  } catch (err) {
    const error = String(err.cause?.message || err.message).slice(0, 200);
    db.prepare("UPDATE notifications SET status = 'failed', error = ? WHERE id = ?").run(error, id);
    console.error('[sms] send failed:', error);
    return { ok: false, error };
  }
}

/** Tells the contact person a visitor is on the way. Does nothing without a gateway or a phone number. */
export async function notifyContact(visit, siteName) {
  if (!smsConfigured() || !visit?.contact_phone) return;
  const purpose = visit.purpose ? ` Purpose: ${visit.purpose}.` : '';
  const message = `${siteName}: ${visit.visitor_name} is on the way to ${visit.office_name}.${purpose} Pass ${visit.pass_code}.`;
  const result = await sendSms({ visitId: visit.id, recipient: visit.contact_name, phone: visit.contact_phone, message });
  try {
    addEvent({
      passId: visit.pass_id,
      visitId: visit.id,
      type: result.ok ? 'notified' : 'notify_failed',
      note: result.ok ? `SMS sent to ${visit.contact_name}` : `SMS to ${visit.contact_name} failed`,
    });
  } catch (err) {
    console.error('[sms] could not record the result:', err.message);
  }
}

export function recentNotifications(limit = 50) {
  return db.prepare('SELECT id, visit_id, recipient, phone, message, status, error, created_at, sent_at FROM notifications ORDER BY id DESC LIMIT ?').all(limit);
}
