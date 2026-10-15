import "server-only";
import type { OutgoingEmail } from "./mailer";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

type Layout = { to: string; subject: string; preheader: string; heading: string; paragraphs: string[]; action?: { label: string; url: string }; footnote: string; orgName: string };

function render(l: Layout): OutgoingEmail {
  const button = l.action
    ? `<tr><td style="padding:8px 0 24px"><a href="${esc(l.action.url)}" style="display:inline-block;background:#DC2626;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">${esc(l.action.label)}</a></td></tr>
       <tr><td style="font-size:13px;color:#64748B;padding-bottom:16px">If the button does not work, copy this link into your browser:<br><span style="word-break:break-all;color:#111827">${esc(l.action.url)}</span></td></tr>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(l.subject)}</title></head>
<body style="margin:0;background:#F6F7F9;font-family:Arial,Helvetica,sans-serif;color:#111827">
<span style="display:none;max-height:0;overflow:hidden">${esc(l.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F7F9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border:1px solid #E5E7EB;border-radius:12px;padding:32px">
<tr><td style="font-size:18px;font-weight:700;color:#DC2626;padding-bottom:24px">RealtyPacer</td></tr>
<tr><td style="font-size:20px;font-weight:700;padding-bottom:16px">${esc(l.heading)}</td></tr>
${l.paragraphs.map((p) => `<tr><td style="font-size:15px;line-height:1.6;padding-bottom:16px">${esc(p)}</td></tr>`).join("")}
${button}
<tr><td style="font-size:13px;color:#64748B;border-top:1px solid #E5E7EB;padding-top:16px">${esc(l.footnote)}</td></tr>
</table>
<p style="font-size:12px;color:#64748B">Sent by RealtyPacer on behalf of ${esc(l.orgName)}.</p>
</td></tr></table></body></html>`;
  const text = [
    l.heading,
    "",
    ...l.paragraphs.flatMap((p) => [p, ""]),
    ...(l.action ? [`${l.action.label}: ${l.action.url}`, ""] : []),
    l.footnote,
    "",
    `Sent by RealtyPacer on behalf of ${l.orgName}.`,
  ].join("\n");
  return { to: l.to, subject: l.subject, html, text };
}

/** Customer booking email. Schedule details only: no prices, office notes or internal data. */
export function bookingEmail(p: {
  to: string;
  customerName: string;
  orgName: string;
  orgPhone: string;
  orgEmail: string;
  kind: "booking_confirmation" | "booking_changed" | "booking_cancelled";
  reference: string;
  when: string;
  address: string;
  services: string[];
}) {
  const heading = p.kind === "booking_confirmation" ? "Your booking is confirmed" : p.kind === "booking_changed" ? "Your booking has changed" : "Your booking was cancelled";
  const contact = [p.orgPhone, p.orgEmail].filter(Boolean).join(" or ");
  const details = p.kind === "booking_cancelled"
    ? [`Booking ${p.reference} on ${p.when} at ${p.address} has been cancelled.`]
    : [`When: ${p.when}`, `Where: ${p.address}`, `Services: ${p.services.join(", ")}`, `Reference: ${p.reference}`];
  return render({
    to: p.to,
    orgName: p.orgName,
    subject: `${p.orgName}: ${heading} (${p.reference})`.replace(/\s+/g, " "),
    preheader: `${heading} — ${p.when}`,
    heading,
    paragraphs: [`Hi ${p.customerName},`, ...details, contact ? `Questions or changes? Contact ${p.orgName} at ${contact}.` : `Questions or changes? Reply to ${p.orgName}.`],
    footnote: `You're receiving this because you have a booking with ${p.orgName}.`,
  });
}

export function invitationEmail(p: { to: string; inviteeName: string; inviterName: string; orgName: string; url: string; expiresHours: number }) {
  return render({
    to: p.to,
    orgName: p.orgName,
    subject: `You're invited to ${p.orgName} on RealtyPacer`,
    preheader: `${p.inviterName} invited you to join ${p.orgName}.`,
    heading: `Join ${p.orgName}`,
    paragraphs: [`Hi ${p.inviteeName},`, `${p.inviterName} invited you to the ${p.orgName} workspace on RealtyPacer. Set a password to activate your account.`],
    action: { label: "Accept invitation", url: p.url },
    footnote: `This invitation link works once and expires in ${p.expiresHours} hours. If you weren't expecting it, you can ignore this email.`,
  });
}

export function verificationEmail(p: { to: string; name: string; orgName: string; url: string; expiresHours: number }) {
  return render({
    to: p.to,
    orgName: p.orgName,
    subject: "Verify your RealtyPacer email address",
    preheader: "Confirm your email address to finish signing in.",
    heading: "Verify your email address",
    paragraphs: [`Hi ${p.name},`, "Confirm this email address to finish setting up your RealtyPacer account."],
    action: { label: "Verify email address", url: p.url },
    footnote: `This link works once and expires in ${p.expiresHours} hours. If you didn't request it, you can ignore this email.`,
  });
}

export function passwordResetEmail(p: { to: string; name: string; orgName: string; url: string; expiresMinutes: number }) {
  return render({
    to: p.to,
    orgName: p.orgName,
    subject: "Reset your RealtyPacer password",
    preheader: "Use this link to choose a new password.",
    heading: "Reset your password",
    paragraphs: [`Hi ${p.name},`, "We received a request to reset your RealtyPacer password. Choose a new one using the link below."],
    action: { label: "Choose a new password", url: p.url },
    footnote: `This link works once and expires in ${p.expiresMinutes} minutes. If you didn't request a reset, you can ignore this email — your password stays the same.`,
  });
}

export function passwordChangedEmail(p: { to: string; name: string; orgName: string; when: string; supportUrl: string }) {
  return render({
    to: p.to,
    orgName: p.orgName,
    subject: "Your RealtyPacer password was changed",
    preheader: "Your password was just changed.",
    heading: "Your password was changed",
    paragraphs: [
      `Hi ${p.name},`,
      `The password for your RealtyPacer account was changed on ${p.when}. All other signed-in sessions have been signed out.`,
      "If you didn't make this change, reset your password immediately and contact your administrator.",
    ],
    action: { label: "Reset password", url: p.supportUrl },
    footnote: "This is an automated security notification.",
  });
}
