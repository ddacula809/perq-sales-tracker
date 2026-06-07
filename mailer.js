// mailer.js — optional transactional email for notifications.
//
// INACTIVE until configured: it no-ops unless EMAIL_API_KEY and EMAIL_FROM are set, so the
// app runs fine without email. To turn it on, set these env vars in Railway:
//   EMAIL_API_KEY  - your provider API key
//   EMAIL_FROM     - the verified "from" address, e.g. "PERQ Revenue Desk <notifications@perq.com>"
//   EMAIL_PROVIDER - 'resend' (default) or 'sendgrid'
//   APP_URL        - (optional) link included in emails, e.g. https://perq-sales-tracker-production.up.railway.app
// Uses the provider HTTP API via fetch (no npm dependency). Failures are logged, never thrown,
// so a flaky email never breaks an upload.

const PROVIDER = (process.env.EMAIL_PROVIDER || 'resend').toLowerCase();
const API_KEY = process.env.EMAIL_API_KEY || '';
const FROM = process.env.EMAIL_FROM || '';
export const APP_URL = process.env.APP_URL || '';

export function emailEnabled() { return !!(API_KEY && FROM); }

export async function sendEmail({ to, subject, html }) {
  const recipients = [...new Set((Array.isArray(to) ? to : [to])
    .map((e) => String(e || '').trim()).filter((e) => e.includes('@')))];
  if (!emailEnabled() || !recipients.length || !subject) return { skipped: true };
  try {
    let res;
    if (PROVIDER === 'sendgrid') {
      res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: recipients.map((email) => ({ email })) }],
          from: { email: FROM.replace(/.*<(.+)>.*/, '$1') },
          subject,
          content: [{ type: 'text/html', value: html }],
        }),
      });
    } else { // resend (default)
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: recipients, subject, html }),
      });
    }
    if (!res.ok) throw new Error(`${PROVIDER} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { sent: recipients.length };
  } catch (e) {
    console.error('[mailer] send failed:', e.message);
    return { error: e.message };
  }
}

// Wrap a list of change lines into a simple branded HTML email body.
export function changeEmailHtml(heading, intro, lines) {
  const items = lines.map((l) => `<li style="margin:4px 0">${l}</li>`).join('');
  const link = APP_URL ? `<p><a href="${APP_URL}" style="color:#7e1f59">Open PERQ Revenue Desk →</a></p>` : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#3e3a4a">`
    + `<h2 style="color:#7e1f59;margin:0 0 8px">${heading}</h2>`
    + `<p>${intro}</p><ul style="padding-left:18px">${items}</ul>${link}`
    + `<p style="color:#7e7a8c;font-size:12px;margin-top:14px">Automated notification from PERQ Revenue Desk.</p></div>`;
}
